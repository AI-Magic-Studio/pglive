import { createPgLive } from '@pglive/server';
import pg from 'pg';

const DB_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

async function setup() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  // Create test table
  await client.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Ensure publication exists
  const pub = await client.query(
    `SELECT 1 FROM pg_publication WHERE pubname = 'pglive'`
  );
  if (pub.rows.length === 0) {
    await client.query(`CREATE PUBLICATION pglive FOR ALL TABLES`);
    console.log('Created publication "pglive"');
  }

  await client.end();
}

async function main() {
  console.log('Setting up database...');
  await setup();

  // Start the pgLive server
  const server = createPgLive({
    db: DB_URL,
    port: 4400,
    logLevel: 'debug',
  });

  await server.start();
  console.log('\npgLive server running on ws://localhost:4400');
  console.log('Waiting 2 seconds for WAL reader to connect...\n');

  await new Promise(resolve => setTimeout(resolve, 2000));

  // Connect a client via raw WebSocket
  const ws = new WebSocket('ws://localhost:4400');

  ws.addEventListener('open', () => {
    console.log('[client] Connected to pgLive');

    // Subscribe to agents table changes
    ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'changes:agents',
      ref: 'sub_1',
      payload: {
        event: ['INSERT', 'UPDATE', 'DELETE'],
        filter: {},
      },
    }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'subscribed') {
      console.log(`[client] Subscribed to ${msg.channel}`);
      console.log('[client] Waiting for changes...\n');

      // Insert a row after subscribing
      setTimeout(async () => {
        const client = new pg.Client({ connectionString: DB_URL });
        await client.connect();

        console.log('[sql] INSERT INTO agents (name, status) VALUES (\'Codex\', \'running\')');
        await client.query(`INSERT INTO agents (name, status) VALUES ('Codex', 'running')`);

        // Update after a short delay
        setTimeout(async () => {
          console.log('[sql] UPDATE agents SET status = \'complete\' WHERE name = \'Codex\'');
          await client.query(`UPDATE agents SET status = 'complete' WHERE name = 'Codex'`);

          // Delete after another delay
          setTimeout(async () => {
            console.log('[sql] DELETE FROM agents WHERE name = \'Codex\'');
            await client.query(`DELETE FROM agents WHERE name = 'Codex'`);

            setTimeout(async () => {
              await client.end();
              console.log('\n[done] Example complete. Shutting down...');
              await server.stop();
              process.exit(0);
            }, 1000);
          }, 1000);
        }, 1000);
      }, 500);
    }

    if (msg.type === 'change') {
      const c = msg.payload;
      console.log(`[realtime] ${c.type} on ${c.table}:`, c.type === 'DELETE' ? c.old : c.new);
    }
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
