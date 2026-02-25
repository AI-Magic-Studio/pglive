import { Connection } from './connection.js';
import { Channel } from './channel.js';
import type { PgLiveOptions, WireMessage } from './types.js';

export class PgLive {
  private connection: Connection;
  private channels: Map<string, Channel> = new Map();
  private refCounter: number = 0;

  constructor(url: string, options?: PgLiveOptions) {
    this.connection = new Connection(url, options);
    this.connection.on('message', (msg: WireMessage) => this._routeMessage(msg));
  }

  /**
   * Get or create a channel for the given topic.
   * Topics follow the format: `schema:table` (e.g. `public:users`).
   */
  channel(topic: string): Channel {
    if (!this.channels.has(topic)) {
      const ref = `sub_${++this.refCounter}`;
      const ch = new Channel(topic, this.connection, ref);
      this.channels.set(topic, ch);
    }
    return this.channels.get(topic)!;
  }

  /**
   * Register a listener for connection lifecycle events.
   */
  on(event: 'connected' | 'disconnected' | 'reconnecting' | 'error', callback: Function): this {
    this.connection.on(event, callback);
    return this;
  }

  /**
   * Remove a listener for connection lifecycle events.
   */
  off(event: 'connected' | 'disconnected' | 'reconnecting' | 'error', callback: Function): this {
    this.connection.off(event, callback);
    return this;
  }

  /**
   * Unsubscribe all channels and close the connection.
   */
  close(): void {
    this.channels.forEach((ch) => ch.unsubscribe());
    this.channels.clear();
    this.connection.close();
  }

  private _routeMessage(msg: WireMessage): void {
    if (msg.channel) {
      const ch = this.channels.get(msg.channel);
      if (ch) {
        ch._handleMessage(msg);
      }
    }
    // Server-level messages (pong, error without channel) are handled by Connection
  }
}

// Re-export types
export type { Change, ChangeType, FilterMap, FilterCondition, WireMessage, PgLiveOptions } from './types.js';
export { Channel } from './channel.js';
export { Connection } from './connection.js';
