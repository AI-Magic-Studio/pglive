# pgLive — Claude Code Handoff

## Context

pgLive is an open-source project that provides realtime subscriptions for any Postgres database via WAL logical replication + WebSocket. Think "Supabase Realtime, but standalone." This document is everything you need to scaffold the monorepo, write the v1 code, and ship working packages.

Read the full project spec at: `README.md` (in the repo root). That has the complete architecture rationale, API design, protocol spec, and v2 planning. This document is the **build plan** — what to create, in what order, with what dependencies, and what the code should do.

---

## Phase 0: Monorepo Scaffold

### Create the monorepo structure

```
pglive/
├── packages/
│   ├── server/          # @pglive/server
│   ├── client/          # @pglive/client
│   └── react/           # @pglive/react
├── examples/
│   └── basic/           # Minimal working example
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── docs/
├── package.json         # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json   # Shared TS config
├── .gitignore
├── .eslintrc.js
├── LICENSE              # MIT
└── README.md            # Copy from pgLive_Project_Spec.md
```

### Root `package.json`

```json
{
  "name": "pglive",
  "private": true,
  "scripts": {
    "build": "turbo build",
    "dev": "turbo dev",
    "lint": "turbo lint",
    "test": "turbo test",
    "clean": "turbo clean"
  },
  "devDependencies": {
    "turbo": "^2",
    "typescript": "^5.4",
    "@types/node": "^20",
    "tsup": "^8",
    "vitest": "^2"
  }
}
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
  - "examples/*"
```

### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {},
    "clean": {
      "cache": false
    }
  }
}
```

### Shared `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

---

## Phase 1: `@pglive/server`

This is the core. Build this first.

### Dependencies

```json
{
  "name": "@pglive/server",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "pglive": "dist/cli.js"
  },
  "scripts": {
    "build": "tsup src/index.ts src/cli.ts --format esm --dts",
    "dev": "tsup src/index.ts src/cli.ts --format esm --watch",
    "test": "vitest"
  },
  "dependencies": {
    "pg-logical-replication": "^2",
    "ws": "^8",
    "pg": "^8"
  },
  "devDependencies": {
    "@types/ws": "^8",
    "@types/pg": "^8"
  }
}
```

### File: `src/types.ts`

Shared types used across all server modules.

```ts
// --- Wire Protocol Types ---

export type MessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'ping'
  | 'pong'
  | 'subscribed'
  | 'change'
  | 'error'
  // Reserved for v2:
  | 'broadcast'
  | 'presence_sync'
  | 'presence_diff';

export interface WireMessage {
  type: MessageType;
  channel?: string;
  ref?: string;
  payload?: any;
}

// --- Change Types ---

export type ChangeType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface Change {
  type: ChangeType;
  table: string;
  schema: string;
  new: Record<string, any> | null;
  old: Record<string, any> | null;
  ts: string;
  id: string; // WAL LSN
}

// --- Filter Types ---

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'like' | 'is';

export interface FilterCondition {
  [operator: string]: any; // e.g. { eq: 'running' }
}

export interface FilterMap {
  [column: string]: FilterCondition;
}

// --- Subscription Types ---

export interface Subscription {
  ref: string;
  channel: string;      // e.g. 'changes:agents'
  channelType: string;  // e.g. 'changes'
  target: string;       // e.g. 'agents' (table name for changes)
  events: ChangeType[];
  filter: FilterMap;
}

// --- Config Types ---

export interface PgLiveConfig {
  db: string;           // DATABASE_URL
  port: number;
  host: string;
  publication: string;
  slot: string;
  tables: string[] | null; // null = all tables in publication
  heartbeat: number;    // seconds
  maxClients: number;
  maxWalLagMb: number;
  cors: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auth: AuthConfig;
  hooks: Hooks;
}

export interface AuthConfig {
  mode: 'none' | 'jwt' | 'webhook';
  secret?: string;
  url?: string;
}

export interface AuthResult {
  allowed: boolean;
  claims?: Record<string, any>;
  error?: string;
}

// --- Hook Types ---

export interface Hooks {
  onConnect?: (socket: any, token: string | undefined) => Promise<AuthResult>;
  onSubscribe?: (socket: any, subscription: Subscription) => Promise<AuthResult>;
  onChange?: (change: Change, subscribers: Subscription[]) => Promise<Change | null>;
  onDisconnect?: (socket: any, reason: string) => Promise<void>;
}

export interface Plugin {
  name: string;
  hooks: Partial<Hooks>;
}

// --- Metrics Types ---

export interface MetricsSnapshot {
  connections: { active: number; total: number };
  subscriptions: { active: number; byChannel: Record<string, number> };
  changes: { received: number; broadcast: number };
  wal: { lagBytes: number; lastLsn: string };
  errors: { total: number; byType: Record<string, number> };
  uptime: number;
}
```

### File: `src/config.ts`

Parse environment variables and CLI args into `PgLiveConfig`. Use `process.env` with `PGLIVE_` prefix. Defaults:

| Field | Env Var | Default |
|-------|---------|---------|
| db | `DATABASE_URL` | required |
| port | `PGLIVE_PORT` | 4400 |
| host | `PGLIVE_HOST` | `0.0.0.0` |
| publication | `PGLIVE_PUBLICATION` | `pglive` |
| slot | `PGLIVE_SLOT` | `pglive_slot` |
| tables | `PGLIVE_TABLES` | null (all) |
| heartbeat | `PGLIVE_HEARTBEAT` | 30 |
| maxClients | `PGLIVE_MAX_CLIENTS` | 1000 |
| maxWalLagMb | `PGLIVE_MAX_WAL_LAG_MB` | 100 |
| cors | `PGLIVE_CORS` | `*` |
| logLevel | `PGLIVE_LOG_LEVEL` | `info` |
| auth.mode | `PGLIVE_AUTH_MODE` | `none` |
| auth.secret | `PGLIVE_JWT_SECRET` | undefined |

### File: `src/metrics.ts`

Simple singleton with increment/decrement/get methods. No external dependencies.

```ts
class Metrics {
  // Counters
  connectionsActive: number = 0;
  connectionsTotal: number = 0;
  subscriptionsActive: number = 0;
  subscriptionsByChannel: Map<string, number> = new Map();
  changesReceived: number = 0;
  changesBroadcast: number = 0;
  walLagBytes: number = 0;
  walLastLsn: string = '';
  errorsTotal: number = 0;
  errorsByType: Map<string, number> = new Map();
  startTime: number = Date.now();

  // Methods: increment(field), decrement(field), snapshot(): MetricsSnapshot
}

export const metrics = new Metrics();
```

### File: `src/auth.ts`

v1 implementation: always allows. Interface ready for v2.

```ts
export async function verifyConnection(token: string | undefined, config: AuthConfig): Promise<AuthResult> {
  if (config.mode === 'none') return { allowed: true };
  // v2: JWT verification, webhook call
  return { allowed: true };
}

export async function verifySubscription(
  claims: Record<string, any> | undefined,
  subscription: Subscription,
  config: AuthConfig
): Promise<AuthResult> {
  if (config.mode === 'none') return { allowed: true };
  // v2: check claims against channel/table permissions
  return { allowed: true };
}
```

### File: `src/filter-engine.ts`

Normalizes shorthand filters and evaluates changes against them.

**Critical behaviors:**

1. Normalize `{ status: 'running' }` → `{ status: { eq: 'running' } }`
2. Evaluate a `Change` against a `FilterMap` — all conditions must match (AND logic)
3. v1 implements `eq` operator only. Return `false` for unknown operators (safe default).
4. Empty filter = match everything
5. Filter is applied against `change.new` for INSERT/UPDATE, `change.old` for DELETE

```ts
export function normalizeFilter(input: Record<string, any>): FilterMap {
  // If value is primitive, wrap in { eq: value }
  // If value is already { operator: value }, pass through
}

export function matchesFilter(change: Change, filter: FilterMap): boolean {
  // Get the row to check (new for INSERT/UPDATE, old for DELETE)
  // For each column in filter, check operator against row value
  // All must match (AND)
}
```

### File: `src/slot-manager.ts`

Manages the Postgres replication slot lifecycle. **This is safety-critical.**

**Behaviors:**

1. On server start: check if slot exists. If not, create it.
2. On graceful shutdown: drop the slot (prevents WAL buildup).
3. On SIGINT/SIGTERM: register handler to drop slot before exit.
4. Monitor replication lag via `pg_replication_slots` view.
5. Log warning when lag exceeds `maxWalLagMb`.
6. Handle Neon's behavior of dropping idle slots — auto-recreate on reconnect.

```ts
export class SlotManager {
  constructor(private db: string, private slot: string, private publication: string) {}

  async ensureSlot(): Promise<void> {}     // Create if not exists
  async dropSlot(): Promise<void> {}       // Drop on shutdown
  async checkLag(): Promise<number> {}     // Returns lag in bytes
  async recreateIfDropped(): Promise<void> {} // Handle Neon slot drops
}
```

Use the `pg` library (not `pg-logical-replication`) for these admin queries since they're regular SQL.

### File: `src/wal-reader.ts`

The WAL change stream. Uses `pg-logical-replication` with the `pgoutput` plugin.

**Behaviors:**

1. Connect to Postgres using the streaming replication protocol
2. Subscribe to the publication via the replication slot
3. Decode `pgoutput` messages into `Change` objects
4. Emit changes via an EventEmitter or callback
5. Handle reconnection (the library handles this, but we need to re-subscribe)
6. Track and auto-acknowledge LSN positions
7. Enable backpressure/flow control if available in the library

```ts
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';

export class WalReader extends EventEmitter {
  constructor(private config: { db: string; slot: string; publication: string }) {}

  async start(): Promise<void> {
    const service = new LogicalReplicationService(
      { connectionString: this.config.db },
      { acknowledge: { auto: true, timeoutSeconds: 10 } }
    );

    const plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: [this.config.publication],
    });

    service.on('data', (lsn: string, msg: Pgoutput.Message) => {
      // Convert Pgoutput.Message to our Change type
      // msg can be: Begin, Commit, Insert, Update, Delete, Relation, Type
      // We care about Insert, Update, Delete
      // Relation messages map relation IDs to table names — cache these
      const change = this.toChange(lsn, msg);
      if (change) this.emit('change', change);
    });

    // Reconnect loop
    const subscribe = () => {
      service.subscribe(plugin, this.config.slot)
        .catch(err => {
          this.emit('error', err);
          setTimeout(subscribe, 1000);
        });
    };
    subscribe();
  }

  async stop(): Promise<void> {
    // service.stop()
  }
}
```

**Important:** `pgoutput` sends `Relation` messages that map numeric relation IDs to table/schema/column info. You MUST cache these and use them to decode Insert/Update/Delete messages. The relation mapping looks like:

```ts
// Cache: relationId -> { schema, table, columns: [{ name, type, flags }] }
private relations: Map<number, RelationInfo> = new Map();

// On Relation message: store in cache
// On Insert/Update/Delete: lookup relation by ID, decode columns using cached info
```

### File: `src/channel-router.ts`

Routes WAL changes to matching WebSocket subscriptions.

**Behaviors:**

1. Maintain a map of active subscriptions grouped by `channelType:target` (e.g., `changes:agents`)
2. When a change arrives, find all subscriptions for that table
3. For each subscription: check if the event type matches, then run the filter engine
4. Return list of matching subscriptions (the WS manager will send to them)

```ts
export class ChannelRouter {
  private subscriptions: Map<string, Map<string, Subscription>> = new Map();
  // Outer key: "changes:schema.table", inner key: subscription ref

  addSubscription(sub: Subscription): void {}
  removeSubscription(ref: string): void {}
  routeChange(change: Change): Subscription[] {
    const key = `changes:${change.schema}.${change.table}`;
    // Also check `changes:${change.table}` (without schema, for public schema shorthand)
    // For each matching sub, check event type + filter
  }
}
```

### File: `src/ws-manager.ts`

WebSocket server managing connections and message routing.

**Behaviors:**

1. Create `ws.WebSocketServer` on the configured port
2. On connection: parse token from URL params or first message, call auth hook, track in metrics
3. On message: parse JSON, route by `type`:
   - `subscribe` → parse channel, create Subscription, add to router, send `subscribed` ack
   - `unsubscribe` → remove from router, clean up
   - `ping` → send `pong`
4. On close: remove all subscriptions for this socket, update metrics
5. `broadcast(change, subscriptions)` → for each subscription, find its socket and send the change message
6. Heartbeat: ping all clients every `config.heartbeat` seconds, drop unresponsive connections
7. Respect `config.maxClients` — reject connections beyond the limit

**Channel parsing:**

```ts
function parseChannel(channel: string): { type: string; target: string } {
  // "changes:agents" → { type: "changes", target: "agents" }
  // "changes:public.agents" → { type: "changes", target: "public.agents" }
  // "broadcast:cursors" → { type: "broadcast", target: "cursors" } (v2)
  const [type, ...rest] = channel.split(':');
  return { type, target: rest.join(':') };
}
```

**Subscribe message handling:**

```ts
// Client sends:
// { type: "subscribe", channel: "changes:agents", ref: "sub_1", payload: { event: ["INSERT", "UPDATE"], filter: { status: "running" } } }

// Server:
// 1. Parse channel → { type: "changes", target: "agents" }
// 2. Normalize filter → { status: { eq: "running" } }
// 3. Validate: table must exist in publication (or whitelist)
// 4. Call auth hook
// 5. Create Subscription object
// 6. Add to channel router
// 7. Send: { type: "subscribed", channel: "changes:agents", ref: "sub_1" }
```

### File: `src/hooks.ts`

Plugin registration and hook execution.

```ts
export class HookRunner {
  private plugins: Plugin[] = [];

  use(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  async runOnConnect(socket: any, token: string | undefined): Promise<AuthResult> {
    // Run config hooks first, then plugins in order
    // First rejection stops the chain
  }

  async runOnChange(change: Change, subscribers: Subscription[]): Promise<Change | null> {
    // Plugins can transform or drop changes
    // null = drop the change (don't broadcast)
  }

  // ... same for onSubscribe, onDisconnect
}
```

### File: `src/index.ts`

The main entry point. Wires everything together.

```ts
export function createPgLive(config: Partial<PgLiveConfig>) {
  const fullConfig = mergeWithDefaults(config);

  const slotManager = new SlotManager(fullConfig.db, fullConfig.slot, fullConfig.publication);
  const walReader = new WalReader({ db: fullConfig.db, slot: fullConfig.slot, publication: fullConfig.publication });
  const channelRouter = new ChannelRouter();
  const hookRunner = new HookRunner();
  const wsManager = new WsManager(fullConfig, channelRouter, hookRunner);

  return {
    async start() {
      await slotManager.ensureSlot();
      walReader.on('change', (change: Change) => {
        // Check table whitelist
        // Run onChange hooks
        // Route to subscribers
        // Broadcast via wsManager
        metrics.changesReceived++;
      });
      await walReader.start();
      await wsManager.start();
      // Register shutdown handlers
      process.on('SIGINT', () => this.stop());
      process.on('SIGTERM', () => this.stop());
    },
    async stop() {
      await wsManager.stop();
      await walReader.stop();
      await slotManager.dropSlot();
    },
    use(plugin: Plugin) {
      hookRunner.use(plugin);
    },
    // Expose for testing
    config: fullConfig,
    metrics,
  };
}
```

### File: `src/cli.ts`

```ts
#!/usr/bin/env node
import { createPgLive } from './index.js';
import { parseConfig } from './config.js';

const config = parseConfig(process.argv.slice(2));
const server = createPgLive(config);

server.start().then(() => {
  console.log(`pgLive listening on ws://${config.host}:${config.port}`);
  console.log(`Connected to ${config.db.replace(/:[^:@]+@/, ':***@')}`);  // hide password
  console.log(`Publication: ${config.publication}, Slot: ${config.slot}`);
});
```

---

## Phase 2: `@pglive/client`

### Dependencies

```json
{
  "name": "@pglive/client",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "dev": "tsup src/index.ts --format esm,cjs --watch",
    "test": "vitest"
  },
  "dependencies": {}
}
```

No runtime dependencies. Uses the browser-native `WebSocket` API. For Node.js usage, consumers install `ws` themselves or use Node 22+ which has built-in WebSocket.

### File: `src/types.ts`

Re-export the types needed client-side: `Change`, `ChangeType`, `FilterMap`, `WireMessage`. Keep these in sync with server types but as a separate file (no shared package dependency for v1 simplicity).

### File: `src/connection.ts`

WebSocket connection manager with auto-reconnection.

**Behaviors:**

1. Connect to the pgLive server URL
2. Auto-reconnect on disconnect with exponential backoff (1s, 2s, 4s, 8s... capped at 30s)
3. Reset backoff on successful connection
4. Respect `maxReconnectAttempts` (default: Infinity)
5. Send `ping` messages on heartbeat interval
6. Emit lifecycle events: `connected`, `disconnected`, `reconnecting`, `error`
7. Queue messages sent while disconnected, flush on reconnect
8. Pass token as URL query param: `ws://host:port?token=xxx`

### File: `src/channel.ts`

The channel abstraction. This is the main public API surface.

```ts
export class Channel {
  private handlers: Map<string, { filter?: FilterMap; callback: (change: Change) => void }[]> = new Map();
  private subscribed: boolean = false;

  constructor(
    private topic: string,        // e.g. "changes:agents"
    private connection: Connection,
    private ref: string,           // unique subscription ref
  ) {}

  on(event: ChangeType | '*', callbackOrFilter: any, maybeCallback?: any): this {
    // Overloaded:
    // .on('INSERT', callback)
    // .on('UPDATE', { filter: { status: 'error' } }, callback)
    // .on('*', callback)
    return this; // for chaining
  }

  subscribe(): this {
    // Send subscribe message to server
    // { type: 'subscribe', channel: this.topic, ref: this.ref, payload: { event: [...], filter: {...} } }
    this.subscribed = true;
    return this;
  }

  unsubscribe(): void {
    // Send unsubscribe message
    this.subscribed = false;
  }

  // Called internally by PgLive when a message arrives for this channel
  _handleMessage(msg: WireMessage): void {
    // Match against registered handlers by event type + filter
  }
}
```

### File: `src/index.ts`

```ts
export class PgLive {
  private connection: Connection;
  private channels: Map<string, Channel> = new Map();
  private refCounter: number = 0;

  constructor(url: string, options?: { token?: string; autoReconnect?: boolean; reconnectInterval?: number; maxReconnectAttempts?: number }) {
    this.connection = new Connection(url, options);
    this.connection.on('message', (msg) => this._routeMessage(msg));
  }

  channel(topic: string): Channel {
    if (!this.channels.has(topic)) {
      const ref = `sub_${++this.refCounter}`;
      const ch = new Channel(topic, this.connection, ref);
      this.channels.set(topic, ch);
    }
    return this.channels.get(topic)!;
  }

  on(event: 'connected' | 'disconnected' | 'reconnecting' | 'error', callback: Function): this {
    this.connection.on(event, callback);
    return this;
  }

  close(): void {
    this.channels.forEach(ch => ch.unsubscribe());
    this.connection.close();
  }

  private _routeMessage(msg: WireMessage): void {
    // Route to the matching channel by msg.channel
    // Handle server-level messages (pong, error without channel)
  }
}
```

---

## Phase 3: `@pglive/react`

### Dependencies

```json
{
  "name": "@pglive/react",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts --external react",
    "dev": "tsup src/index.ts --format esm,cjs --watch --external react",
    "test": "vitest"
  },
  "dependencies": {
    "@pglive/client": "workspace:*"
  },
  "peerDependencies": {
    "react": "^18 || ^19"
  }
}
```

### File: `src/provider.tsx`

```tsx
import { createContext, useContext, useEffect, useRef } from 'react';
import { PgLive } from '@pglive/client';

const PgLiveContext = createContext<PgLive | null>(null);

export function PgLiveProvider({ url, token, children }: {
  url: string;
  token?: string;
  children: React.ReactNode;
}) {
  const pgRef = useRef<PgLive | null>(null);

  if (!pgRef.current) {
    pgRef.current = new PgLive(url, { token });
  }

  useEffect(() => {
    return () => {
      pgRef.current?.close();
    };
  }, []);

  return (
    <PgLiveContext.Provider value={pgRef.current}>
      {children}
    </PgLiveContext.Provider>
  );
}

export function usePgLiveClient(): PgLive {
  const pg = useContext(PgLiveContext);
  if (!pg) throw new Error('usePgLiveClient must be used within PgLiveProvider');
  return pg;
}
```

### File: `src/use-pglive.ts`

The main hook. Maintains a reactive array of rows.

```ts
export function usePgLive<T extends Record<string, any>>(
  table: string,
  options: {
    event?: ChangeType[];
    filter?: Record<string, any>;
    initialData?: T[];
    keyField?: string;   // default: 'id'
  } = {}
): {
  data: T[];
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error: Error | null;
} {
  // 1. Get PgLive from context
  // 2. Create channel `changes:${table}`
  // 3. Subscribe with events and filter
  // 4. On INSERT: append to data array
  // 5. On UPDATE: replace matching row by keyField
  // 6. On DELETE: remove matching row by keyField
  // 7. Return reactive state
  // 8. Unsubscribe on unmount
}
```

### File: `src/use-pglive-callback.ts`

Raw callback hook for custom logic.

```ts
export function usePgLiveCallback<T extends Record<string, any>>(
  table: string,
  options: {
    event?: ChangeType[];
    filter?: Record<string, any>;
    callback: (change: Change) => void;
  }
): void {
  // 1. Get PgLive from context
  // 2. Create channel, subscribe
  // 3. Call callback on each matching change
  // 4. Unsubscribe on unmount
}
```

---

## Phase 4: Example & Docker

### `examples/basic/`

A minimal Node.js script that:
1. Connects to a local Postgres
2. Starts pgLive server
3. Connects a client
4. Subscribes to a table
5. Inserts a row via `pg` directly
6. Logs the realtime change received by the client

Include a `docker-compose.yml` that runs Postgres with `wal_level=logical` + the example.

### `docker/Dockerfile`

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY packages/server/dist ./dist
COPY packages/server/package.json ./
RUN npm install --production
EXPOSE 4400
ENTRYPOINT ["node", "dist/cli.js"]
```

### `docker/docker-compose.yml`

For local development:

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
    command: >
      postgres
      -c wal_level=logical
      -c max_replication_slots=10
      -c max_wal_senders=10
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  pglive:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/postgres
    ports:
      - "4400:4400"
    depends_on:
      - postgres

volumes:
  pgdata:
```

---

## Build Order & Verification

### Step 1: Scaffold + Server core
1. Create monorepo structure
2. Build `types.ts`, `config.ts`, `metrics.ts`, `auth.ts`
3. Build `filter-engine.ts` with tests
4. Build `slot-manager.ts`
5. Build `wal-reader.ts`
6. **Verify:** Run WAL reader against docker-compose Postgres, insert a row, see the Change emitted

### Step 2: Server WebSocket layer
1. Build `channel-router.ts` with tests
2. Build `ws-manager.ts`
3. Build `hooks.ts`
4. Wire together in `index.ts`
5. Build `cli.ts`
6. **Verify:** Start server via CLI, connect with `wscat`, send subscribe message, insert a row, see the change arrive over WebSocket

### Step 3: Client SDK
1. Build `connection.ts` with reconnection logic
2. Build `channel.ts` with event handling
3. Build `index.ts` (PgLive class)
4. **Verify:** Write a Node.js script using the client SDK that subscribes and receives changes

### Step 4: React hooks
1. Build `provider.tsx`
2. Build `use-pglive.ts`
3. Build `use-pglive-callback.ts`
4. **Verify:** Create a minimal Next.js page that shows a live-updating list

### Step 5: Examples & Docker
1. Create basic example
2. Create Docker setup
3. Write README with quickstart

---

## Testing Strategy

### Unit tests (vitest)
- `filter-engine.test.ts` — normalize + match for various filter shapes
- `channel-router.test.ts` — subscription add/remove/route
- `config.test.ts` — env var parsing, defaults, validation

### Integration tests (need Docker Postgres)
- WAL reader receives INSERT/UPDATE/DELETE
- Slot manager creates/drops slots
- Full server flow: client subscribes → SQL insert → client receives change
- Reconnection: kill/restart WAL connection, verify client gets changes after recovery

### What NOT to test in v1
- Auth (it's a passthrough)
- Horizontal scaling
- Broadcast/presence (not implemented)
- Performance benchmarks

---

## Key Libraries Reference

### `pg-logical-replication`

```ts
import { LogicalReplicationService, PgoutputPlugin, Pgoutput } from 'pg-logical-replication';

// Pgoutput.Message types we care about:
// - Pgoutput.MessageRelation: { tag: 'relation', relationOid, schema, name, columns }
// - Pgoutput.MessageInsert: { tag: 'insert', relation, new: { [column]: value } }
// - Pgoutput.MessageUpdate: { tag: 'update', relation, old?, new }
// - Pgoutput.MessageDelete: { tag: 'delete', relation, old?, key? }
// - Pgoutput.MessageBegin / MessageCommit: transaction boundaries

// The library handles:
// - Streaming replication protocol
// - LSN acknowledgment (auto or manual)
// - Backpressure / flow control
// - Reconnection (need to re-subscribe in catch handler)
```

### `ws` (WebSocket server)

```ts
import { WebSocketServer, WebSocket } from 'ws';

const wss = new WebSocketServer({ port: 4400 });
wss.on('connection', (ws: WebSocket, req) => {
  // req.url contains query params (for token)
  ws.on('message', (data) => { /* parse JSON */ });
  ws.on('close', () => { /* cleanup */ });
  ws.on('pong', () => { /* mark alive for heartbeat */ });
});

// Heartbeat:
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
```

---

## Edge Cases to Handle

1. **Relation cache miss:** pgoutput sends Relation messages before the first change for each table. But on reconnect, you may get a change without having seen the Relation message. Solution: query `pg_catalog.pg_class` to build initial relation map on startup.

2. **TOAST values:** Large column values may be TOASTed (stored out-of-line). For UPDATE, if a TOASTed column didn't change, pgoutput may send `unchanged_toast` marker instead of the value. Handle by merging with the `old` row data or documenting the limitation.

3. **Transaction boundaries:** pgoutput sends Begin/Commit messages wrapping changes. For v1, ignore these and broadcast changes individually. v2 could support "batch changes in a transaction" mode.

4. **Schema changes mid-stream:** If a table is ALTERed (add/drop column), pgoutput sends a new Relation message. Update the relation cache. Existing subscriptions continue working but column shapes change. Log a warning.

5. **Slot already exists on startup:** If the server crashed without cleanup, the slot persists. `ensureSlot()` should handle this gracefully — just reuse it. The slot tracks the last acknowledged LSN, so you'll receive any changes since the crash.

6. **Publication doesn't exist:** Fail fast with a clear error message telling the user to run `CREATE PUBLICATION pglive FOR ALL TABLES`.

7. **Client sends subscribe for table not in publication:** Return an error message. Don't crash.

8. **WebSocket message ordering:** WAL changes are ordered. Don't process them concurrently — broadcast sequentially per change to preserve order.
