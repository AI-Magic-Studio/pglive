import { describe, it, expect } from 'vitest';
import { normalizeFilter, matchesFilter } from '../filter-engine.js';
import type { Change } from '../types.js';

describe('normalizeFilter', () => {
  it('wraps primitive values in { eq: value }', () => {
    const result = normalizeFilter({ status: 'running', count: 42 });
    expect(result).toEqual({
      status: { eq: 'running' },
      count: { eq: 42 },
    });
  });

  it('passes through object values unchanged', () => {
    const result = normalizeFilter({ age: { gt: 18 }, name: { like: '%foo%' } });
    expect(result).toEqual({
      age: { gt: 18 },
      name: { like: '%foo%' },
    });
  });

  it('converts null to { is: null }', () => {
    const result = normalizeFilter({ deleted_at: null });
    expect(result).toEqual({
      deleted_at: { is: null },
    });
  });

  it('converts undefined to { is: null }', () => {
    const result = normalizeFilter({ field: undefined });
    expect(result).toEqual({
      field: { is: null },
    });
  });

  it('returns empty object for empty input', () => {
    const result = normalizeFilter({});
    expect(result).toEqual({});
  });
});

describe('matchesFilter', () => {
  const insertChange: Change = {
    type: 'INSERT',
    table: 'agents',
    schema: 'public',
    new: { id: 1, status: 'running', name: 'agent-1' },
    old: null,
    ts: '2026-01-01T00:00:00Z',
    id: '0/1234',
  };

  const updateChange: Change = {
    type: 'UPDATE',
    table: 'agents',
    schema: 'public',
    new: { id: 1, status: 'stopped', name: 'agent-1' },
    old: { id: 1, status: 'running', name: 'agent-1' },
    ts: '2026-01-01T00:00:01Z',
    id: '0/1235',
  };

  const deleteChange: Change = {
    type: 'DELETE',
    table: 'agents',
    schema: 'public',
    new: null,
    old: { id: 1, status: 'stopped', name: 'agent-1' },
    ts: '2026-01-01T00:00:02Z',
    id: '0/1236',
  };

  it('empty filter matches everything', () => {
    expect(matchesFilter(insertChange, {})).toBe(true);
    expect(matchesFilter(updateChange, {})).toBe(true);
    expect(matchesFilter(deleteChange, {})).toBe(true);
  });

  it('eq operator matches correctly', () => {
    expect(matchesFilter(insertChange, { status: { eq: 'running' } })).toBe(true);
    expect(matchesFilter(insertChange, { status: { eq: 'stopped' } })).toBe(false);
  });

  it('filter on INSERT uses change.new', () => {
    expect(matchesFilter(insertChange, { status: { eq: 'running' } })).toBe(true);
    // INSERT has no old, so the filter checks new
    expect(matchesFilter(insertChange, { name: { eq: 'agent-1' } })).toBe(true);
  });

  it('filter on UPDATE uses change.new', () => {
    // UPDATE: new has status='stopped'
    expect(matchesFilter(updateChange, { status: { eq: 'stopped' } })).toBe(true);
    expect(matchesFilter(updateChange, { status: { eq: 'running' } })).toBe(false);
  });

  it('filter on DELETE uses change.old', () => {
    // DELETE: old has status='stopped'
    expect(matchesFilter(deleteChange, { status: { eq: 'stopped' } })).toBe(true);
    expect(matchesFilter(deleteChange, { status: { eq: 'running' } })).toBe(false);
  });

  it('non-matching filter returns false', () => {
    expect(matchesFilter(insertChange, { status: { eq: 'idle' } })).toBe(false);
    expect(matchesFilter(insertChange, { nonexistent: { eq: 'value' } })).toBe(false);
  });

  it('returns false when row is null and filter is non-empty', () => {
    const noRow: Change = {
      type: 'DELETE',
      table: 'agents',
      schema: 'public',
      new: null,
      old: null,
      ts: '2026-01-01T00:00:03Z',
      id: '0/1237',
    };
    expect(matchesFilter(noRow, { status: { eq: 'running' } })).toBe(false);
  });
});
