import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { PgLiveConfig, Change, Subscription, WireMessage, ChangeType } from './types.js';
import { normalizeFilter } from './filter-engine.js';
import { ChannelRouter } from './channel-router.js';
import { HookRunner } from './hooks.js';
import { metrics } from './metrics.js';
import { verifyConnection } from './auth.js';
import { createLogger } from './logger.js';

const log = createLogger('ws-manager');

function parseChannel(channel: string): { type: string; target: string } {
  const [type, ...rest] = channel.split(':');
  return { type, target: rest.join(':') };
}

export class WsManager {
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Track which socket owns which subscription refs
  private socketRefs: Map<WebSocket, Set<string>> = new Map();
  // Reverse lookup: ref -> socket
  private refToSocket: Map<string, WebSocket> = new Map();
  // Track alive status for heartbeat
  private alive: Map<WebSocket, boolean> = new Map();

  constructor(
    private config: PgLiveConfig,
    private router: ChannelRouter,
    private hookRunner: HookRunner,
  ) {}

  async start(): Promise<void> {
    this.wss = new WebSocketServer({
      port: this.config.port,
      host: this.config.host,
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (err: Error) => {
      log.error('WebSocket server error:', err.message);
      metrics.recordError('ws_server');
    });

    // Start heartbeat interval
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, this.config.heartbeat * 1000);

    log.info(`WebSocket server listening on ${this.config.host}:${this.config.port}`);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.wss) {
      // Close all connections
      for (const ws of this.wss.clients) {
        ws.terminate();
      }

      await new Promise<void>((resolve, reject) => {
        this.wss!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.wss = null;
    }

    this.socketRefs.clear();
    this.refToSocket.clear();
    this.alive.clear();

    log.info('WebSocket server stopped.');
  }

  broadcast(change: Change, subscriptions: Subscription[]): void {
    const message = JSON.stringify({
      type: 'change',
      payload: change,
    } satisfies WireMessage);

    for (const sub of subscriptions) {
      const ws = this.refToSocket.get(sub.ref);
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;

      try {
        ws.send(JSON.stringify({
          type: 'change',
          channel: sub.channel,
          ref: sub.ref,
          payload: change,
        } satisfies WireMessage));
      } catch (err: any) {
        log.warn(`Failed to send to ref=${sub.ref}: ${err.message}`);
        metrics.recordError('ws_send');
      }
    }
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // Enforce maxClients
    if (this.wss && this.wss.clients.size > this.config.maxClients) {
      log.warn('Max clients reached, rejecting connection.');
      this.sendError(ws, 'max_clients', 'Server at capacity');
      ws.close(4013, 'Max clients reached');
      return;
    }

    // Parse token from URL params
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') || undefined;

    // Verify connection via auth config
    const authResult = await verifyConnection(token, this.config.auth);
    if (!authResult.allowed) {
      log.info(`Connection rejected by auth: ${authResult.error || 'unauthorized'}`);
      this.sendError(ws, 'auth', authResult.error || 'Unauthorized');
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Run onConnect hooks
    const hookResult = await this.hookRunner.runOnConnect(ws, token);
    if (!hookResult.allowed) {
      log.info(`Connection rejected by hook: ${hookResult.error || 'unauthorized'}`);
      this.sendError(ws, 'auth', hookResult.error || 'Unauthorized');
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Track connection
    this.socketRefs.set(ws, new Set());
    this.alive.set(ws, true);
    metrics.connectionsActive++;
    metrics.connectionsTotal++;
    log.debug(`Client connected. Active: ${metrics.connectionsActive}`);

    ws.on('pong', () => {
      this.alive.set(ws, true);
    });

    ws.on('message', (data: Buffer | string) => {
      this.handleMessage(ws, data);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.handleClose(ws, reason.toString() || `code=${code}`);
    });

    ws.on('error', (err: Error) => {
      log.warn(`WebSocket error: ${err.message}`);
      metrics.recordError('ws_client');
    });
  }

  private async handleMessage(ws: WebSocket, data: Buffer | string): Promise<void> {
    let msg: WireMessage;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
    } catch {
      this.sendError(ws, 'parse', 'Invalid JSON');
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        await this.handleSubscribe(ws, msg);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(ws, msg);
        break;
      case 'ping':
        this.send(ws, { type: 'pong', ref: msg.ref });
        break;
      default:
        this.sendError(ws, 'unknown_type', `Unknown message type: ${msg.type}`);
    }
  }

  private async handleSubscribe(ws: WebSocket, msg: WireMessage): Promise<void> {
    const channel = msg.channel;
    const ref = msg.ref;

    if (!channel || !ref) {
      this.sendError(ws, 'invalid', 'subscribe requires channel and ref');
      return;
    }

    const { type, target } = parseChannel(channel);
    const payload = msg.payload || {};

    // Normalize events
    const events: ChangeType[] = Array.isArray(payload.event) ? payload.event : [];

    // Normalize filter
    const filter = payload.filter ? normalizeFilter(payload.filter) : {};

    const subscription: Subscription = {
      ref,
      channel,
      channelType: type,
      target,
      events,
      filter,
    };

    // Run onSubscribe hooks
    const hookResult = await this.hookRunner.runOnSubscribe(ws, subscription);
    if (!hookResult.allowed) {
      this.sendError(ws, 'auth', hookResult.error || 'Subscription denied', ref);
      return;
    }

    // Register subscription
    this.router.addSubscription(subscription);

    // Track ref ownership
    const refs = this.socketRefs.get(ws);
    if (refs) {
      refs.add(ref);
    }
    this.refToSocket.set(ref, ws);

    metrics.subscriptionsActive++;
    metrics.incrementChannel(channel);

    log.debug(`Subscribed ref=${ref} channel=${channel}`);

    // Send ack
    this.send(ws, { type: 'subscribed', channel, ref });
  }

  private handleUnsubscribe(ws: WebSocket, msg: WireMessage): void {
    const ref = msg.ref;
    if (!ref) {
      this.sendError(ws, 'invalid', 'unsubscribe requires ref');
      return;
    }

    const sub = this.router.getSubscriptionsByRef(ref);
    if (!sub) {
      // Not found, silently ignore
      return;
    }

    // Verify this socket owns the ref
    const refs = this.socketRefs.get(ws);
    if (!refs || !refs.has(ref)) {
      this.sendError(ws, 'invalid', 'Ref not owned by this connection');
      return;
    }

    this.removeSubscription(ref, sub.channel);
    refs.delete(ref);

    log.debug(`Unsubscribed ref=${ref}`);
  }

  private handleClose(ws: WebSocket, reason: string): void {
    const refs = this.socketRefs.get(ws);
    if (refs) {
      for (const ref of refs) {
        const sub = this.router.getSubscriptionsByRef(ref);
        const channel = sub?.channel;
        this.removeSubscription(ref, channel);
      }
    }

    this.socketRefs.delete(ws);
    this.alive.delete(ws);
    metrics.connectionsActive--;

    log.debug(`Client disconnected: ${reason}. Active: ${metrics.connectionsActive}`);

    // Fire onDisconnect hooks (fire-and-forget)
    this.hookRunner.runOnDisconnect(ws, reason).catch((err) => {
      log.warn(`onDisconnect hook error: ${err.message}`);
    });
  }

  private removeSubscription(ref: string, channel?: string): void {
    this.router.removeSubscription(ref);
    this.refToSocket.delete(ref);
    metrics.subscriptionsActive--;
    if (channel) {
      metrics.decrementChannel(channel);
    }
  }

  private heartbeat(): void {
    if (!this.wss) return;

    for (const ws of this.wss.clients) {
      if (!this.alive.get(ws)) {
        log.debug('Terminating unresponsive client.');
        ws.terminate();
        continue;
      }

      this.alive.set(ws, false);
      ws.ping();
    }
  }

  private send(ws: WebSocket, msg: WireMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err: any) {
      log.warn(`Failed to send message: ${err.message}`);
      metrics.recordError('ws_send');
    }
  }

  private sendError(ws: WebSocket, code: string, message: string, ref?: string): void {
    this.send(ws, {
      type: 'error',
      ref,
      payload: { code, message },
    });
  }
}
