/**
 * Fork behaviour (CLAUDE.md fork convention #12): the webhook listener binds
 * loopback unless WEBHOOK_HOST says otherwise.
 *
 * Main-only on purpose — if an upstream update reverts webhook-server.ts to a
 * hardcoded '0.0.0.0', this file fails the staged test run instead of the
 * port silently reopening to the LAN.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { allocateFreePort } from './test-utils/free-port.js';

describe('WEBHOOK_HOST (fork: loopback by default)', () => {
  const originalCwd = process.cwd();
  let directory: string;
  let stopWebhookServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-webhook-host-'));
    process.chdir(directory);
    vi.stubEnv('WEBHOOK_HOST', undefined);
    vi.stubEnv('WEBHOOK_PORT', undefined);
    vi.resetModules();
    stopWebhookServer = undefined;
  });

  afterEach(async () => {
    try {
      await stopWebhookServer?.();
    } finally {
      process.chdir(originalCwd);
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('defaults to 127.0.0.1', async () => {
    const { getWebhookHost } = await import('./config.js');
    expect(getWebhookHost()).toBe('127.0.0.1');
  });

  it('reads WEBHOOK_HOST from .env, and the process env overrides it', async () => {
    fs.writeFileSync(path.join(directory, '.env'), 'WEBHOOK_HOST=0.0.0.0\n');
    const { getWebhookHost } = await import('./config.js');
    expect(getWebhookHost()).toBe('0.0.0.0');
    vi.stubEnv('WEBHOOK_HOST', '::1');
    expect(getWebhookHost()).toBe('::1');
  });

  it.each(['0.0.0.0 ; rm', 'a b', 'host/evil'])('rejects malformed host %j', async (bad) => {
    vi.stubEnv('WEBHOOK_HOST', bad);
    const { getWebhookHost } = await import('./config.js');
    expect(() => getWebhookHost()).toThrow(/Invalid WEBHOOK_HOST/);
  });

  it('actually binds the listener to loopback by default', async () => {
    const port = await allocateFreePort();
    vi.stubEnv('WEBHOOK_PORT', String(port));
    const webhook = await import('./webhook-server.js');
    stopWebhookServer = webhook.stopWebhookServer;
    const { log } = await import('./log.js');
    const started = vi.spyOn(log, 'info');

    webhook.registerWebhookHandler('loopback', (_req, res) => {
      res.end('ok');
    });

    await vi.waitFor(() =>
      expect(started).toHaveBeenCalledWith(
        'Webhook server started',
        expect.objectContaining({ host: '127.0.0.1', port }),
      ),
    );
    const response = await fetch(`http://127.0.0.1:${port}/webhook/loopback`, { signal: AbortSignal.timeout(500) });
    expect(await response.text()).toBe('ok');
  });
});
