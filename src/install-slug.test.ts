import { afterEach, describe, expect, it } from 'vitest';

import { getContainerImageBase, getInstallSlug, getLaunchdLabel, getSystemdUnit } from './install-slug.js';

afterEach(() => {
  delete process.env.NANOCLAW_INSTALL_ID;
});

describe('getInstallSlug', () => {
  it('derives from the project root when NANOCLAW_INSTALL_ID is unset', () => {
    const slug = getInstallSlug('/some/checkout');
    expect(slug).toMatch(/^[0-9a-f]{8}$/);
    expect(getInstallSlug('/some/checkout')).toBe(slug);
    expect(getInstallSlug('/other/checkout')).not.toBe(slug);
  });

  it('honors a valid NANOCLAW_INSTALL_ID override', () => {
    process.env.NANOCLAW_INSTALL_ID = 'prod-eks_1';
    expect(getInstallSlug('/some/checkout')).toBe('prod-eks_1');
  });

  it('rejects label-unsafe overrides', () => {
    for (const bad of ['UPPER', '-leading', 'has space', 'a'.repeat(33), 'dot.dot']) {
      process.env.NANOCLAW_INSTALL_ID = bad;
      expect(() => getInstallSlug('/some/checkout'), bad).toThrow(/NANOCLAW_INSTALL_ID/);
    }
  });
});

// Fork §6.3: no `-v2-` infix. The running unit on this install is
// `nanoclaw-583cc1c4` and its image `nanoclaw-agent-583cc1c4`; reintroducing
// the infix would point restarts and spawns at names that don't exist.
describe('install-derived names', () => {
  it('carry no v2 infix and match the live install', () => {
    const root = '/srv/apps/nanoclaw';
    expect(getInstallSlug(root)).toBe('583cc1c4');
    expect(getSystemdUnit(root)).toBe('nanoclaw-583cc1c4');
    expect(getLaunchdLabel(root)).toBe('com.nanoclaw-583cc1c4');
    expect(getContainerImageBase(root)).toBe('nanoclaw-agent-583cc1c4');
  });
});
