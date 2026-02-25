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
  [operator: string]: any;
}

export interface FilterMap {
  [column: string]: FilterCondition;
}

// --- Subscription Types ---

export interface Subscription {
  ref: string;
  channel: string;
  channelType: string;
  target: string;
  events: ChangeType[];
  filter: FilterMap;
}

// --- Config Types ---

export interface PgLiveConfig {
  db: string;
  port: number;
  host: string;
  publication: string;
  slot: string;
  tables: string[] | null;
  heartbeat: number;
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
