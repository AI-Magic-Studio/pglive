export type ChangeType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface Change {
  type: ChangeType;
  table: string;
  schema: string;
  new: Record<string, any> | null;
  old: Record<string, any> | null;
  ts: string;
  id: string;
}

export type MessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'ping'
  | 'pong'
  | 'subscribed'
  | 'change'
  | 'error'
  | 'broadcast'
  | 'presence_sync'
  | 'presence_diff';

export interface WireMessage {
  type: MessageType;
  channel?: string;
  ref?: string;
  payload?: any;
}

export interface FilterMap {
  [column: string]: FilterCondition;
}

export interface FilterCondition {
  [operator: string]: any;
}

export interface PgLiveOptions {
  token?: string;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}
