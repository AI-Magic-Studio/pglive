# pgLive

**Realtime subscriptions for any Postgres database.**

> Supabase Realtime is amazing — but locked to Supabase. pgLive gives you the same power with any Postgres: Neon, RDS, self-hosted, whatever.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)]()

---

## The Problem

Every modern dashboard, command center, or collaborative app needs realtime updates. In the Postgres ecosystem, your options are:

- **Supabase Realtime** — Excellent, but deeply coupled to Supabase's auth, JWT model, and tenant system
- **LISTEN/NOTIFY wrappers** (`pg-listen`, `pg-pubsub`) — Low-level plumbing with an 8KB payload limit, no WebSocket layer, no client SDK
- **Prisma Pulse** — Managed SaaS, not self-hostable, locked to Prisma ORM
- **Abandoned packages** (`pg-live-select`, `pg-live-query`, `pg-live-table`) — All unmaintained for 5-10 years

There is no standalone, database-agnostic, open-source realtime server for Postgres with a modern client SDK. pgLive fills that gap.

---

## What pgLive Does

```
┌─────────────┐     ┌──────────────┐      ┌─────────────────┐
│  Your App    │ WS  │   pgLive     │ WAL  │   Any Postgres   │
│  (React,     │◄───►│   Server     │◄─────│   (Neon, RDS,    │
│   Next.js)   │     │              │      │    self-hosted)   │
└─────────────┘     └──────────────┘      └─────────────────┘
```

1. Connects to your Postgres via **logical replication** (WAL decoding)
2. Clients subscribe to **table changes** over WebSocket with optional filters
3. Changes are broadcast to matching subscribers in **real-time**
4. Zero triggers, zero polling, zero external dependencies

---

## Quick Start

### Server

```bash
npx pglive --db postgres://user:pass@your-neon-host.neon.tech/mydb
```

Or with Docker:

```bash
docker run -e DATABASE_URL=postgres://... -p 4400:4400 pglive/server
```

### One-Time Postgres Setup

pgLive uses WAL-based logical replication. You need to enable it once:

```sql
-- For Neon: Enable in Console → Settings → Logical Replication → Enable
-- For self-hosted: Set wal_level = logical in postgresql.conf and restart

-- Then run these SQL statements:
CREATE PUBLICATION pglive FOR ALL TABLES;

-- pgLive auto-creates its replication slot on first connect.
-- To create it manually:
SELECT pg_create_logical_replication_slot('pglive_slot', 'pgoutput');
```

### Client (React)

```bash
npm install @pglive/client @pglive/react
```

```tsx
import { usePgLive } from '@pglive/react';

function AgentDashboard() {
  const { data: agents, status } = usePgLive('agents', {
    filter: { status: 'running' },
    event: ['INSERT', 'UPDATE'],
  });

  return (
    <div>
      {agents.map(agent => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}
```

### Client (Vanilla JS)

```ts
import { PgLive } from '@pglive/client';

const pg = new PgLive('ws://localhost:4400');

const sub = pg.channel('changes:agents')
  .on('INSERT', (change) => console.log('New agent:', change.new))
  .on('UPDATE', { filter: { status: 'error' } }, (change) => {
    console.log('Agent errored:', change.new);
  })
  .subscribe();

// Unsubscribe
sub.unsubscribe();
```

---

## Use Case: Mission Control

pgLive was born from a real need — building **Mission Control**, an AI agent swarm command center that manages autonomous coding agents. The dashboard needs to reflect agent status changes the instant they happen: task dispatched, CI passing, PR created, review complete.

**Tables we subscribe to in Mission Control:**

| Table | Events | Why |
|-------|--------|-----|
| `agents` | UPDATE | Agent status changes (idle → running → error) |
| `dispatch_tasks` | INSERT, UPDATE | New tasks queued, stage transitions |
| `comms_log` | INSERT | Inter-agent messages appear live |
| `cost_entries` | INSERT | Running cost ticker |
| `reviews` | INSERT, UPDATE | Code review verdicts arrive |
| `automations` | UPDATE | Scheduled job status |

---

## Architecture

### How It Works (WAL-Based Logical Replication)

```
┌──────────┐   WebSocket    ┌──────────────────────────┐   Streaming Replication   ┌──────────┐
│  Client   │◄─────────────►│  pgLive Server           │◄────────────────────────►│ Postgres │
│  SDK      │               │                          │   (pgoutput protocol)     │          │
│           │               │  ┌─────────────────────┐ │                           └──────────┘
└──────────┘               │  │ WAL Reader           │ │
                            │  │ (pg-logical-repl)    │ │
                            │  └──────────┬──────────┘ │
                            │             │ Change{}    │
                            │  ┌──────────▼──────────┐ │
                            │  │ Channel Router       │ │
                            │  │ (filter + dispatch)  │ │
                            │  └──────────┬──────────┘ │
                            │             │             │
                            │  ┌──────────▼──────────┐ │
                            │  │ WS Connection Mgr    │ │
                            │  │ (broadcast to subs)  │ │
                            │  └─────────────────────┘ │
                            └──────────────────────────┘
```

**How it works:**
1. Server creates a logical replication slot and subscribes to your publication
2. Postgres streams WAL changes (INSERT/UPDATE/DELETE) in real-time via the `pgoutput` protocol
3. The channel router matches changes against active subscriptions (table + filters)
4. Matching changes are broadcast to subscribed WebSocket clients

**Why WAL over LISTEN/NOTIFY:**
- No 8KB payload limit
- No triggers to manage
- Captures changes from ANY source (your app, direct SQL, n8n workflows, migrations)
- Old row data available on UPDATE/DELETE for free
- Postgres-native, battle-tested replication protocol

**Components:**
- `@pglive/server` — Node.js process using `pg-logical-replication` + `ws`
- `@pglive/client` — Browser/Node WebSocket client with auto-reconnection
- `@pglive/react` — React hooks (`usePgLive`, `usePgLiveCallback`)

---

## Architecture Decisions: Build Right from Day One

We audited every planned future feature to determine whether the v1 architecture needed to account for it up front. The principle: **v2 features should be add-ons, not refactors.**

### Channel Abstraction (v1 — built in)

**Why now:** Broadcast, presence, and DB changes are all different *channel types*. If v1 only has a flat `subscribe(table, callback)` API, adding broadcast later requires breaking the client API. Instead, v1 ships with the channel abstraction even though only `changes:` channels exist initially.

```ts
// v1 — DB changes channel (the only type that exists)
pg.channel('changes:agents').on('UPDATE', callback).subscribe();

// v2 — Broadcast channel (add-on, no API change)
pg.channel('broadcast:cursors').on('message', callback).subscribe();

// v2 — Presence channel (add-on, no API change)
pg.channel('presence:dashboard').on('sync', callback).subscribe();
```

**What v1 builds:** The `channel(topic)` → `.on(event, callback)` → `.subscribe()` chain, with a `type` prefix convention (`changes:`, `broadcast:`, `presence:`). The server routes messages based on channel type. v1 only implements the `changes:` handler.

### Message Envelope (v1 — built in)

**Why now:** Every message over the wire needs a consistent envelope. If v1 uses a flat structure and v2 adds new message types, you're versioning the protocol.

```json
{
  "type": "change",
  "channel": "changes:agents",
  "ref": "sub_1",
  "payload": { ... }
}
```

**What v1 builds:** The envelope with `type`, `channel`, `ref`, `payload`. New `type` values are add-ons.

### Auth Hook Interface (v1 — built in, auth logic is v2)

**Why now:** If v1 has no concept of auth, adding it later means changing the connection handshake, the subscription flow, and the server config. Instead, v1 ships with an auth *hook point* that defaults to "allow all."

```ts
// Server config in v1
{
  auth: {
    mode: 'none',
  }
}

// v2 adds JWT mode — no server code refactored, just a new mode
{
  auth: {
    mode: 'jwt',
    secret: process.env.JWT_SECRET,
    claims: { role: 'authenticated' },
  }
}
```

**What v1 builds:** The connection handshake accepts an optional `token` param. The server calls `auth.verify(token, channel)` on subscribe, which in v1 always returns `{ allowed: true }`. v2 swaps in real verification. No refactoring.

### Subscription Filter Engine (v1 — built in, advanced operators are v2)

**Why now:** If v1 only does exact equality matching (`{ status: 'running' }`), adding operators like `gt`, `in`, `like` later means rewriting the filter engine and the wire protocol for filter expressions.

```ts
// v1 filter format — equality shorthand
{ filter: { status: 'running' } }

// Under the hood, v1 normalizes this to the full format:
{ filter: { status: { eq: 'running' } } }

// v2 adds operators — same format, just more operators
{ filter: { score: { gt: 100 }, status: { in: ['running', 'queued'] } } }
```

**What v1 builds:** The filter engine that accepts `{ column: { operator: value } }` internally. v1 implements `eq` only. The client SDK accepts the shorthand `{ column: value }` and normalizes it. Adding operators is adding cases to a switch statement, not restructuring.

### Metrics Collection Points (v1 — built in, exposure is v2)

**Why now:** Instrumenting after the fact means threading counters through code that wasn't designed for it. v1 tracks the metrics internally; v2 exposes them.

**What v1 builds:** A lightweight `Metrics` singleton that increments counters at key points. No HTTP endpoint yet.

### Replication Slot Management (v1 — built in, this is critical)

**Why now:** This isn't a feature — it's a safety requirement. An unmanaged replication slot will fill your disk. This must be in v1.

### Plugin/Hook System (v1 — interface only)

**Why now:** Without hooks, every new feature requires forking the server code. With hooks, contributors can build features as plugins without touching core.

**What v1 builds:** The hook interface and `server.use(plugin)` registration. Hooks are called at the right lifecycle points. v1 ships with no built-in plugins — the hooks just exist for contributors and v2.

### Summary: What v1 Builds vs. What v2 Adds

| Concern | v1 (Built In) | v2 (Add-On) |
|---------|---------------|-------------|
| Change detection | WAL logical replication | — |
| Channel abstraction | `changes:` type, extensible routing | `broadcast:`, `presence:` types |
| Wire protocol | Envelope with `type/channel/ref/payload` | New `type` values |
| Auth | Hook interface, `mode: 'none'` default | JWT mode, webhook mode |
| Filters | Engine with `eq` operator, normalized format | `gt`, `lt`, `in`, `like`, `is` operators |
| Metrics | Internal counters | `/metrics` Prometheus endpoint |
| Slot management | Create, drop, ack, lag monitoring | — |
| Plugin system | Hook interface + `server.use()` | Broadcast, presence, replay plugins |
| Client SDK | Channel API, reconnection, subscription management | Framework adapters (Vue, Svelte) |
| React hooks | `usePgLive`, `usePgLiveCallback`, Provider | — |
| Horizontal scaling | — | Shared WAL cursor (Redis/Postgres) |
| Admin UI | — | Dashboard showing connections, throughput |
| LISTEN/NOTIFY fallback | — | For Postgres without logical replication |

---

## Server Configuration

```bash
# Minimal
npx pglive --db $DATABASE_URL

# Full options
npx pglive \
  --db postgres://user:pass@host/db \
  --port 4400 \
  --host 0.0.0.0 \
  --publication pglive \
  --slot pglive_slot \
  --tables agents,dispatch_tasks \
  --cors "*" \
  --heartbeat 30 \
  --log-level info
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string | required |
| `PGLIVE_PORT` | Server port | `4400` |
| `PGLIVE_PUBLICATION` | Postgres publication name | `pglive` |
| `PGLIVE_SLOT` | Replication slot name | `pglive_slot` |
| `PGLIVE_TABLES` | Comma-separated table whitelist | all tables in publication |
| `PGLIVE_JWT_SECRET` | JWT signing secret (v2, ignored in v1) | none (no auth) |
| `PGLIVE_HEARTBEAT` | WebSocket ping interval (seconds) | `30` |
| `PGLIVE_MAX_CLIENTS` | Maximum concurrent WebSocket connections | `1000` |
| `PGLIVE_MAX_WAL_LAG_MB` | Warning threshold for replication lag | `100` |

---

## Client SDK API

### `PgLive` (Core Client)

```ts
import { PgLive } from '@pglive/client';

const pg = new PgLive('ws://localhost:4400', {
  token?: string;
  autoReconnect?: boolean;     // default: true
  reconnectInterval?: number;  // default: 1000 (ms), with exponential backoff
  maxReconnectAttempts?: number; // default: Infinity
});

// Connection lifecycle
pg.on('connected', () => {});
pg.on('disconnected', (reason) => {});
pg.on('reconnecting', (attempt) => {});
pg.on('error', (error) => {});

// Create a channel
const channel = pg.channel('changes:agents');

// Subscribe to specific events
channel
  .on('INSERT', (change) => { /* new row */ })
  .on('UPDATE', { filter: { status: 'error' } }, (change) => { /* filtered update */ })
  .on('DELETE', (change) => { /* deleted row */ })
  .on('*', (change) => { /* any change */ })
  .subscribe();

// Unsubscribe from channel
channel.unsubscribe();

// Disconnect all
pg.close();
```

### `Change` Object

```ts
interface Change {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  new: Record<string, any> | null;
  old: Record<string, any> | null;
  ts: string;
  id: string;
}
```

### React Hooks (`@pglive/react`)

```tsx
import { PgLiveProvider, usePgLive, usePgLiveCallback } from '@pglive/react';

// Wrap your app
<PgLiveProvider url="ws://localhost:4400" token={jwt}>
  <App />
</PgLiveProvider>

// Hook: Maintains a reactive collection
function AgentList() {
  const { data, status, error } = usePgLive<Agent>('agents', {
    event: ['INSERT', 'UPDATE'],
    filter: { status: 'running' },
    initialData: [],
    keyField: 'id',
  });
}

// Hook: Raw callback for custom logic
function CostTicker() {
  const [totalCost, setTotalCost] = useState(0);

  usePgLiveCallback<CostEntry>('cost_entries', {
    event: ['INSERT'],
    callback: (change) => {
      setTotalCost(prev => prev + change.new.cost);
    },
  });
}
```

---

## Protocol

WebSocket messages are JSON.

### Client → Server

```json
{ "type": "subscribe", "channel": "changes:agents", "ref": "sub_1", "payload": { "event": ["INSERT", "UPDATE"], "filter": { "status": { "eq": "running" } } } }
{ "type": "unsubscribe", "channel": "changes:agents", "ref": "sub_1" }
{ "type": "ping" }
```

### Server → Client

```json
{ "type": "subscribed", "channel": "changes:agents", "ref": "sub_1" }
{ "type": "change", "channel": "changes:agents", "ref": "sub_1", "payload": { "type": "UPDATE", "table": "agents", "schema": "public", "new": { "id": 1, "name": "Codex", "status": "running" }, "old": { "id": 1, "name": "Codex", "status": "idle" }, "ts": "2026-02-25T14:30:00.000Z", "id": "0/16B3780" } }
{ "type": "pong" }
{ "type": "error", "channel": "changes:agents", "ref": "sub_1", "payload": { "message": "Table 'nonexistent' not in publication" } }
```

---

## Comparison

| Feature | pgLive v1 | Supabase Realtime | pg-listen | Prisma Pulse |
|---------|-----------|-------------------|-----------|-------------|
| Any Postgres | ✅ | ❌ (Supabase) | ✅ | ❌ (Prisma + specific DBs) |
| WAL-based (no triggers) | ✅ | ✅ | ❌ | ✅ |
| WebSocket server | ✅ | ✅ | ❌ | ❌ |
| Client SDK | ✅ | ✅ | ❌ | ✅ (Prisma only) |
| React hooks | ✅ | ❌ (community) | ❌ | ❌ |
| Old row data | ✅ | ✅ | ❌ | ✅ |
| Self-hostable | ✅ | ✅ (complex) | N/A | ❌ |
| Setup | `npx pglive` | Docker compose + config | Code it yourself | `prisma generate` |
| Payload limit | None | None | 8KB | None |

---

## Roadmap

### v1.0 — "Ship It"

Core WAL-based realtime server with channel abstraction and React hooks.

- [ ] WAL reader via `pg-logical-replication` (pgoutput plugin)
- [ ] Auto-managed replication slot (create on start, drop on shutdown)
- [ ] Channel abstraction with `changes:` type routing
- [ ] Subscription filter engine (equality operator)
- [ ] WebSocket server with JSON protocol, heartbeat/pong
- [ ] `@pglive/client` with auto-reconnection
- [ ] `@pglive/react` with `usePgLive` and `usePgLiveCallback`
- [ ] Auth hook interface (default: allow all)
- [ ] Plugin hook interface + `server.use(plugin)`
- [ ] Internal metrics counters
- [ ] `npx pglive` CLI launcher
- [ ] Docker image

### v2.0 — "Add-Ons" (no refactoring, only new code)

- [ ] JWT auth mode, webhook auth mode
- [ ] Advanced filter operators (`neq`, `gt`, `in`, `like`, `is`)
- [ ] `@pglive/broadcast` plugin
- [ ] `@pglive/presence` plugin
- [ ] `/metrics` Prometheus endpoint
- [ ] `@pglive/vue`, `@pglive/svelte`, `@pglive/solid`

### v3.0 — "Scale"

- [ ] Horizontal scaling
- [ ] Admin dashboard UI
- [ ] RLS-like per-user row filtering
- [ ] LISTEN/NOTIFY fallback mode

---

## Postgres Requirements

| Requirement | Why | How |
|-------------|-----|-----|
| `wal_level = logical` | WAL must include row-level change data | Neon: Console → Settings → Logical Replication. Self-hosted: `postgresql.conf` |
| `REPLICATION` privilege | Server needs replication protocol access | Neon default roles have this. Self-hosted: `ALTER ROLE myuser REPLICATION` |
| Publication | Defines which tables to replicate | `CREATE PUBLICATION pglive FOR ALL TABLES` or specific tables |

---

## Contributing

pgLive is built in public. The architecture is designed for contributors to build features as plugins without touching core.

**Good first issues:** Add a filter operator, write a Vue adapter, add `/health` endpoint, write integration tests.

**Plugin contributions (v2):** Broadcast, presence, event replay, Prometheus metrics.

---

## License

MIT — Use it however you want.
