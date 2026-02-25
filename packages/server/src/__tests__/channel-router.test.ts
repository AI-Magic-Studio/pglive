import { describe, it, expect } from 'vitest';
import { ChannelRouter } from '../channel-router.js';
import type { Change, Subscription } from '../types.js';

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    ref: 'sub_1',
    channel: 'changes:agents',
    channelType: 'changes',
    target: 'agents',
    events: [],
    filter: {},
    ...overrides,
  };
}

function makeChange(overrides: Partial<Change> = {}): Change {
  return {
    type: 'INSERT',
    table: 'agents',
    schema: 'public',
    new: { id: 1, status: 'running' },
    old: null,
    ts: '2026-01-01T00:00:00Z',
    id: '0/1234',
    ...overrides,
  };
}

describe('ChannelRouter', () => {
  describe('add/remove subscriptions', () => {
    it('adds and retrieves a subscription by ref', () => {
      const router = new ChannelRouter();
      const sub = makeSub();
      router.addSubscription(sub);

      const found = router.getSubscriptionsByRef('sub_1');
      expect(found).toBeDefined();
      expect(found!.ref).toBe('sub_1');
      expect(found!.channel).toBe('changes:agents');
    });

    it('removes a subscription by ref', () => {
      const router = new ChannelRouter();
      const sub = makeSub();
      router.addSubscription(sub);
      router.removeSubscription('sub_1');

      const found = router.getSubscriptionsByRef('sub_1');
      expect(found).toBeUndefined();
    });

    it('handles removing a non-existent ref gracefully', () => {
      const router = new ChannelRouter();
      // Should not throw
      router.removeSubscription('nonexistent');
    });
  });

  describe('routing', () => {
    it('routes change to matching subscription by table name', () => {
      const router = new ChannelRouter();
      router.addSubscription(makeSub({ ref: 'sub_1', target: 'agents' }));

      const change = makeChange({ table: 'agents' });
      const matches = router.routeChange(change);

      expect(matches).toHaveLength(1);
      expect(matches[0].ref).toBe('sub_1');
    });

    it('routes change to matching subscription by schema.table', () => {
      const router = new ChannelRouter();
      router.addSubscription(makeSub({
        ref: 'sub_1',
        channel: 'changes:public.agents',
        target: 'public.agents',
      }));

      const change = makeChange({ schema: 'public', table: 'agents' });
      const matches = router.routeChange(change);

      expect(matches).toHaveLength(1);
      expect(matches[0].ref).toBe('sub_1');
    });

    it('filters by event type', () => {
      const router = new ChannelRouter();
      router.addSubscription(makeSub({
        ref: 'insert_only',
        events: ['INSERT'],
      }));
      router.addSubscription(makeSub({
        ref: 'update_only',
        events: ['UPDATE'],
      }));

      const insertChange = makeChange({ type: 'INSERT' });
      const matches = router.routeChange(insertChange);

      expect(matches).toHaveLength(1);
      expect(matches[0].ref).toBe('insert_only');
    });

    it('filters by column filter', () => {
      const router = new ChannelRouter();
      router.addSubscription(makeSub({
        ref: 'running_only',
        filter: { status: { eq: 'running' } },
      }));
      router.addSubscription(makeSub({
        ref: 'stopped_only',
        filter: { status: { eq: 'stopped' } },
      }));

      const change = makeChange({
        new: { id: 1, status: 'running' },
      });
      const matches = router.routeChange(change);

      expect(matches).toHaveLength(1);
      expect(matches[0].ref).toBe('running_only');
    });

    it('returns empty array when no subscribers match', () => {
      const router = new ChannelRouter();
      router.addSubscription(makeSub({
        ref: 'sub_1',
        target: 'other_table',
        channel: 'changes:other_table',
      }));

      const change = makeChange({ table: 'agents' });
      const matches = router.routeChange(change);

      expect(matches).toHaveLength(0);
    });

    it('returns empty array when there are no subscriptions at all', () => {
      const router = new ChannelRouter();
      const change = makeChange();
      const matches = router.routeChange(change);

      expect(matches).toHaveLength(0);
    });

    it('matches multiple subscriptions on the same channel', () => {
      const router = new ChannelRouter();
      router.addSubscription(makeSub({ ref: 'sub_1' }));
      router.addSubscription(makeSub({ ref: 'sub_2' }));

      const change = makeChange();
      const matches = router.routeChange(change);

      expect(matches).toHaveLength(2);
      const refs = matches.map((m) => m.ref).sort();
      expect(refs).toEqual(['sub_1', 'sub_2']);
    });

    it('subscription with empty events matches all event types', () => {
      const router = new ChannelRouter();
      router.addSubscription(makeSub({ ref: 'all_events', events: [] }));

      expect(router.routeChange(makeChange({ type: 'INSERT' }))).toHaveLength(1);
      expect(router.routeChange(makeChange({ type: 'UPDATE' }))).toHaveLength(1);
      expect(router.routeChange(makeChange({ type: 'DELETE', new: null, old: { id: 1 } }))).toHaveLength(1);
    });
  });

  describe('getAllSubscriptionsForSocket', () => {
    it('returns all subscriptions matching a set of refs', () => {
      const router = new ChannelRouter();
      router.addSubscription(makeSub({ ref: 'sub_1' }));
      router.addSubscription(makeSub({ ref: 'sub_2' }));
      router.addSubscription(makeSub({
        ref: 'sub_3',
        channel: 'changes:other',
        target: 'other',
      }));

      const refs = new Set(['sub_1', 'sub_3']);
      const subs = router.getAllSubscriptionsForSocket(refs);

      expect(subs).toHaveLength(2);
      const subRefs = subs.map((s) => s.ref).sort();
      expect(subRefs).toEqual(['sub_1', 'sub_3']);
    });
  });
});
