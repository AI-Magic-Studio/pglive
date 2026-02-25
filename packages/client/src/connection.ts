import type { PgLiveOptions, WireMessage } from './types.js';

type ConnectionEvent = 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'message';

const HEARTBEAT_INTERVAL = 30_000;
const MAX_BACKOFF = 30_000;

interface RequiredOptions {
  token: string;
  autoReconnect: boolean;
  reconnectInterval: number;
  maxReconnectAttempts: number;
}

export class Connection {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Function[]> = new Map();
  private queue: WireMessage[] = [];
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed: boolean = false;
  private url: string;
  private options: RequiredOptions;

  constructor(url: string, options?: PgLiveOptions) {
    const opts = options ?? {};
    this.options = {
      token: opts.token ?? '',
      autoReconnect: opts.autoReconnect ?? true,
      reconnectInterval: opts.reconnectInterval ?? 1000,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? Infinity,
    };

    // Build URL with token query param if provided
    if (this.options.token) {
      const separator = url.includes('?') ? '&' : '?';
      this.url = `${url}${separator}token=${encodeURIComponent(this.options.token)}`;
    } else {
      this.url = url;
    }

    this.connect();
  }

  send(msg: WireMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  on(event: ConnectionEvent, callback: Function): void {
    const list = this.listeners.get(event);
    if (list) {
      list.push(callback);
    } else {
      this.listeners.set(event, [callback]);
    }
  }

  off(event: ConnectionEvent, callback: Function): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const idx = list.indexOf(callback);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
  }

  private connect(): void {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.emit('error', err);
      this.reconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.flushQueue();
      this.emit('connected');
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      this.emit('disconnected');
      this.reconnect();
    };

    this.ws.onerror = (event: Event) => {
      this.emit('error', event);
      // onclose will fire after onerror, which handles reconnection
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg: WireMessage = JSON.parse(
          typeof event.data === 'string' ? event.data : String(event.data),
        );
        this.emit('message', msg);
      } catch {
        // Ignore malformed messages
      }
    };
  }

  private reconnect(): void {
    if (this.closed || !this.options.autoReconnect) return;

    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempts++;

    // Exponential backoff: base * 2^(attempt-1), capped at MAX_BACKOFF
    const delay = Math.min(
      this.options.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1),
      MAX_BACKOFF,
    );

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private emit(event: string, ...args: any[]): void {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const fn of list) {
      try {
        fn(...args);
      } catch {
        // Prevent listener errors from breaking the connection
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private flushQueue(): void {
    const pending = this.queue.splice(0);
    for (const msg of pending) {
      this.send(msg);
    }
  }
}
