import { describe, it, expect } from 'vitest';
import { toOneCliIdentifier, fromOneCliIdentifier } from './onecli-identifier.js';

describe('toOneCliIdentifier', () => {
  it('leaves a letter-leading id unchanged', () => {
    expect(toOneCliIdentifier('a8a98f3a-3dca-4fb6-b872-3a46161e73a9')).toBe(
      'a8a98f3a-3dca-4fb6-b872-3a46161e73a9',
    );
    expect(toOneCliIdentifier('ag-1779790222913-5fp7xo')).toBe('ag-1779790222913-5fp7xo');
    expect(toOneCliIdentifier('eed83246-277b-41ec-8430-793480b7633f')).toBe(
      'eed83246-277b-41ec-8430-793480b7633f',
    );
  });

  it('prefixes a digit-leading id so OneCLI accepts it', () => {
    expect(toOneCliIdentifier('15ba74f8-3193-4ab5-83dd-1ab8b83bab5e')).toBe(
      'oc-15ba74f8-3193-4ab5-83dd-1ab8b83bab5e',
    );
    expect(toOneCliIdentifier('0a58d857-6de8-44d4-9646-9f12c807da8e')).toBe(
      'oc-0a58d857-6de8-44d4-9646-9f12c807da8e',
    );
  });

  it('keeps the identifier within OneCLI bounds (<=50 chars, [a-z0-9-], letter-leading)', () => {
    const id = toOneCliIdentifier('9fffffff-ffff-ffff-ffff-ffffffffffff');
    expect(id.length).toBeLessThanOrEqual(50);
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe('fromOneCliIdentifier (round-trip)', () => {
  it('inverts the transform for both letter- and digit-leading ids', () => {
    for (const id of [
      'a8a98f3a-3dca-4fb6-b872-3a46161e73a9',
      'ag-1779790222913-5fp7xo',
      '15ba74f8-3193-4ab5-83dd-1ab8b83bab5e',
      '0a58d857-6de8-44d4-9646-9f12c807da8e',
    ]) {
      expect(fromOneCliIdentifier(toOneCliIdentifier(id))).toBe(id);
    }
  });

  it('passes through an identifier that was never prefixed', () => {
    expect(fromOneCliIdentifier('ag-1779790222913-5fp7xo')).toBe('ag-1779790222913-5fp7xo');
  });
});
