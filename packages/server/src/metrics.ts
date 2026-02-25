import type { MetricsSnapshot } from './types.js';

class Metrics {
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

  incrementChannel(channel: string): void {
    this.subscriptionsByChannel.set(
      channel,
      (this.subscriptionsByChannel.get(channel) || 0) + 1
    );
  }

  decrementChannel(channel: string): void {
    const count = (this.subscriptionsByChannel.get(channel) || 0) - 1;
    if (count <= 0) {
      this.subscriptionsByChannel.delete(channel);
    } else {
      this.subscriptionsByChannel.set(channel, count);
    }
  }

  recordError(type: string): void {
    this.errorsTotal++;
    this.errorsByType.set(type, (this.errorsByType.get(type) || 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    return {
      connections: {
        active: this.connectionsActive,
        total: this.connectionsTotal,
      },
      subscriptions: {
        active: this.subscriptionsActive,
        byChannel: Object.fromEntries(this.subscriptionsByChannel),
      },
      changes: {
        received: this.changesReceived,
        broadcast: this.changesBroadcast,
      },
      wal: {
        lagBytes: this.walLagBytes,
        lastLsn: this.walLastLsn,
      },
      errors: {
        total: this.errorsTotal,
        byType: Object.fromEntries(this.errorsByType),
      },
      uptime: Date.now() - this.startTime,
    };
  }
}

export const metrics = new Metrics();
