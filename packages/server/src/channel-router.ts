import { matchesFilter } from './filter-engine.js';
import type { Change, Subscription } from './types.js';

export class ChannelRouter {
  // Outer key: "changes:schema.table" or "changes:table"
  // Inner key: subscription ref
  private subscriptions: Map<string, Map<string, Subscription>> = new Map();

  addSubscription(sub: Subscription): void {
    const key = `${sub.channelType}:${sub.target}`;
    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, new Map());
    }
    this.subscriptions.get(key)!.set(sub.ref, sub);
  }

  removeSubscription(ref: string): void {
    for (const [key, subs] of this.subscriptions) {
      if (subs.has(ref)) {
        subs.delete(ref);
        if (subs.size === 0) {
          this.subscriptions.delete(key);
        }
        return;
      }
    }
  }

  routeChange(change: Change): Subscription[] {
    const matches: Subscription[] = [];

    // Check both fully-qualified "changes:schema.table" and shorthand "changes:table"
    const keys = [
      `changes:${change.schema}.${change.table}`,
      `changes:${change.table}`,
    ];

    for (const key of keys) {
      const subs = this.subscriptions.get(key);
      if (!subs) continue;

      for (const sub of subs.values()) {
        // Check event type match
        if (sub.events.length > 0 && !sub.events.includes(change.type)) {
          continue;
        }

        // Check filter match
        if (!matchesFilter(change, sub.filter)) {
          continue;
        }

        matches.push(sub);
      }
    }

    return matches;
  }

  getSubscriptionsByRef(ref: string): Subscription | undefined {
    for (const subs of this.subscriptions.values()) {
      const sub = subs.get(ref);
      if (sub) return sub;
    }
    return undefined;
  }

  getAllSubscriptionsForSocket(refs: Set<string>): Subscription[] {
    const result: Subscription[] = [];
    for (const subs of this.subscriptions.values()) {
      for (const sub of subs.values()) {
        if (refs.has(sub.ref)) {
          result.push(sub);
        }
      }
    }
    return result;
  }
}
