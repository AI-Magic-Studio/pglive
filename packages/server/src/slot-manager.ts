import pg from 'pg';
import { createLogger } from './logger.js';

const log = createLogger('slot-manager');

export class SlotManager {
  private client: pg.Client | null = null;

  constructor(
    private db: string,
    private slot: string,
    private publication: string
  ) {}

  async ensureSlot(): Promise<void> {
    const client = await this.getClient();

    // Check if publication exists
    const pubResult = await client.query(
      `SELECT 1 FROM pg_publication WHERE pubname = $1`,
      [this.publication]
    );
    if (pubResult.rows.length === 0) {
      throw new Error(
        `Publication "${this.publication}" does not exist. ` +
        `Run: CREATE PUBLICATION ${this.publication} FOR ALL TABLES;`
      );
    }

    // Check if slot exists
    const slotResult = await client.query(
      `SELECT 1 FROM pg_replication_slots WHERE slot_name = $1`,
      [this.slot]
    );

    if (slotResult.rows.length === 0) {
      log.info(`Creating replication slot "${this.slot}"...`);
      await client.query(
        `SELECT pg_create_logical_replication_slot($1, 'pgoutput')`,
        [this.slot]
      );
      log.info(`Replication slot "${this.slot}" created.`);
    } else {
      log.info(`Replication slot "${this.slot}" already exists, reusing.`);
    }
  }

  async dropSlot(): Promise<void> {
    try {
      const client = await this.getClient();
      await client.query(
        `SELECT pg_drop_replication_slot($1)`,
        [this.slot]
      );
      log.info(`Replication slot "${this.slot}" dropped.`);
    } catch (err: any) {
      // Slot may already be dropped (e.g. Neon drops idle slots)
      if (err.code === '42704') {
        log.debug(`Slot "${this.slot}" already dropped.`);
      } else {
        log.warn(`Failed to drop slot "${this.slot}": ${err.message}`);
      }
    } finally {
      await this.disconnect();
    }
  }

  async checkLag(): Promise<number> {
    const client = await this.getClient();
    const result = await client.query(
      `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) as lag_bytes
       FROM pg_replication_slots WHERE slot_name = $1`,
      [this.slot]
    );
    if (result.rows.length === 0) return 0;
    return parseInt(result.rows[0].lag_bytes || '0', 10);
  }

  async recreateIfDropped(): Promise<void> {
    const client = await this.getClient();
    const result = await client.query(
      `SELECT 1 FROM pg_replication_slots WHERE slot_name = $1`,
      [this.slot]
    );
    if (result.rows.length === 0) {
      log.warn(`Slot "${this.slot}" was dropped (Neon?). Recreating...`);
      await client.query(
        `SELECT pg_create_logical_replication_slot($1, 'pgoutput')`,
        [this.slot]
      );
      log.info(`Slot "${this.slot}" recreated.`);
    }
  }

  private async getClient(): Promise<pg.Client> {
    if (!this.client) {
      this.client = new pg.Client({ connectionString: this.db });
      await this.client.connect();
    }
    return this.client;
  }

  private async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end().catch(() => {});
      this.client = null;
    }
  }
}
