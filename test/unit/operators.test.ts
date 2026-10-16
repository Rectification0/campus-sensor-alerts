import { describe, expect, it } from 'vitest';
import { compare } from '../../src/engine/operators.js';

describe('compare', () => {
  it.each([
    ['gt', 31, true],
    ['gt', 30, false],
    ['gte', 30, true],
    ['gte', 29.9, false],
    ['lt', 29, true],
    ['lt', 30, false],
    ['lte', 30, true],
    ['lte', 30.1, false],
  ] as const)('%s: %d vs 30 -> %s', (op, value, expected) => {
    expect(compare(op, value, 30)).toBe(expected);
  });
});
