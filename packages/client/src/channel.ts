import type { Connection } from './connection.js';
import type { Change, ChangeType, FilterMap, WireMessage } from './types.js';

interface Handler {
  event: ChangeType | '*';
  filter: FilterMap;
  callback: (change: Change) => void;
}

interface FilterOptions {
  filter: Record<string, any>;
}

function normalizeFilter(input: Record<string, any>): FilterMap {
  const result: FilterMap = {};
  for (const [col, val] of Object.entries(input)) {
    if (val === null || val === undefined) {
      result[col] = { is: null };
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      result[col] = val;
    } else {
      result[col] = { eq: val };
    }
  }
  return result;
}

function matchesFilter(change: Change, filter: FilterMap): boolean {
  const cols = Object.keys(filter);
  if (cols.length === 0) return true;

  const row = change.type === 'DELETE' ? change.old : change.new;
  if (!row) return false;

  for (const col of cols) {
    for (const [op, expected] of Object.entries(filter[col])) {
      switch (op) {
        case 'eq':
          if (row[col] !== expected) return false;
          break;
        case 'neq':
          if (row[col] === expected) return false;
          break;
        case 'gt':
          if (!(row[col] > expected)) return false;
          break;
        case 'gte':
          if (!(row[col] >= expected)) return false;
          break;
        case 'lt':
          if (!(row[col] < expected)) return false;
          break;
        case 'lte':
          if (!(row[col] <= expected)) return false;
          break;
        case 'is':
          if (expected === null && row[col] !== null && row[col] !== undefined) return false;
          break;
        case 'in':
          if (Array.isArray(expected) && !expected.includes(row[col])) return false;
          break;
        default:
          // Unknown operator — skip
          break;
      }
    }
  }
  return true;
}

export class Channel {
  private handlers: Handler[] = [];
  private subscribed: boolean = false;

  constructor(
    private topic: string,
    private connection: Connection,
    private ref: string,
  ) {}

  /**
   * Register a handler for change events on this channel.
   *
   * Overloads:
   *   .on('INSERT', callback)
   *   .on('UPDATE', { filter: { status: 'error' } }, callback)
   *   .on('*', callback)
   */
  on(event: ChangeType | '*', callback: (change: Change) => void): this;
  on(event: ChangeType | '*', options: FilterOptions, callback: (change: Change) => void): this;
  on(
    event: ChangeType | '*',
    callbackOrOptions: ((change: Change) => void) | FilterOptions,
    maybeCallback?: (change: Change) => void,
  ): this {
    let filter: FilterMap = {};
    let callback: (change: Change) => void;

    if (typeof callbackOrOptions === 'function') {
      callback = callbackOrOptions;
    } else {
      filter = normalizeFilter(callbackOrOptions.filter || {});
      callback = maybeCallback!;
    }

    this.handlers.push({ event, filter, callback });
    return this;
  }

  subscribe(): this {
    this.subscribed = true;
    this.connection.send({
      type: 'subscribe',
      channel: this.topic,
      ref: this.ref,
      payload: {
        event: this.getUniqueEvents(),
        filter: this.getMergedFilter(),
      },
    });
    return this;
  }

  unsubscribe(): void {
    if (!this.subscribed) return;
    this.connection.send({
      type: 'unsubscribe',
      channel: this.topic,
      ref: this.ref,
    });
    this.subscribed = false;
  }

  /**
   * Called internally by PgLive when a message arrives for this channel.
   * @internal
   */
  _handleMessage(msg: WireMessage): void {
    if (msg.type !== 'change' || !msg.payload) return;

    const change = msg.payload as Change;

    for (const handler of this.handlers) {
      if (handler.event !== '*' && handler.event !== change.type) continue;
      if (!matchesFilter(change, handler.filter)) continue;
      handler.callback(change);
    }
  }

  private getUniqueEvents(): ChangeType[] {
    const events = new Set<ChangeType>();
    for (const h of this.handlers) {
      if (h.event === '*') {
        // Wildcard means all events — send empty array to indicate "all"
        return [];
      }
      events.add(h.event as ChangeType);
    }
    return Array.from(events);
  }

  private getMergedFilter(): Record<string, any> {
    // Send empty filter to server — per-handler filters are applied client-side
    return {};
  }
}
