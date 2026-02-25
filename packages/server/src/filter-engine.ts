import type { Change, FilterMap } from './types.js';

export function normalizeFilter(input: Record<string, any>): FilterMap {
  const result: FilterMap = {};
  for (const [column, value] of Object.entries(input)) {
    if (value === null || value === undefined) {
      result[column] = { is: null };
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      // Already in { operator: value } format
      result[column] = value;
    } else {
      // Shorthand: wrap primitive in { eq: value }
      result[column] = { eq: value };
    }
  }
  return result;
}

export function matchesFilter(change: Change, filter: FilterMap): boolean {
  const columns = Object.keys(filter);
  if (columns.length === 0) return true;

  // Use new for INSERT/UPDATE, old for DELETE
  const row = change.type === 'DELETE' ? change.old : change.new;
  if (!row) return false;

  for (const column of columns) {
    const condition = filter[column];
    const value = row[column];

    for (const [operator, expected] of Object.entries(condition)) {
      if (!evaluateOperator(operator, value, expected)) {
        return false;
      }
    }
  }

  return true;
}

function evaluateOperator(operator: string, value: any, expected: any): boolean {
  switch (operator) {
    case 'eq':
      return value === expected;
    // v2 operators — return false (safe default) for unknown operators
    default:
      return false;
  }
}
