/**
 * Per-group operator env.
 *
 * The guarantee that matters is narrow and easy to lose: an operator-supplied
 * variable must never be able to redirect the container's egress or its trust
 * store, because that would route API traffic around the credential gateway
 * without any secret appearing in a value — so the spec's admission policy,
 * which screens secret-shaped env and credential values, would not notice.
 *
 * The complementary half is that namespaced tool variables stay settable;
 * AGENT_BROWSER_PROXY is the feature's main use, and an over-broad substring
 * rule would silently break it.
 */
import { describe, expect, it } from 'vitest';

import { filterContainerEnv, isReservedContainerEnv } from './container-config.js';
import { CLAUDE_CODE_QUIET_ENV } from './container-runner.js';

describe('isReservedContainerEnv', () => {
  it('reserves the egress and trust-store names', () => {
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'CURL_CA_BUNDLE',
      'REQUESTS_CA_BUNDLE',
      'DENO_CERT',
    ]) {
      expect(isReservedContainerEnv(key), key).toBe(true);
    }
  });

  it('reserves the host-owned basics', () => {
    expect(isReservedContainerEnv('TZ')).toBe(true);
    expect(isReservedContainerEnv('HOME')).toBe(true);
  });

  it('matches by exact name, so namespaced tool vars stay settable', () => {
    // The whole point of matching exactly: these contain reserved names as
    // substrings and must remain available.
    for (const key of ['AGENT_BROWSER_PROXY', 'MY_HTTPS_PROXY_URL', 'APP_SSL_CERT_FILE_PATH', 'TZDATA']) {
      expect(isReservedContainerEnv(key), key).toBe(false);
    }
  });
});

describe('filterContainerEnv', () => {
  it('passes allowed entries and reports refused ones', () => {
    const { env, skipped } = filterContainerEnv({
      AGENT_BROWSER_PROXY: 'http://vpn:3128',
      HTTPS_PROXY: 'http://attacker:8080',
      FEATURE_FLAG: 'on',
      HOME: '/tmp',
    });
    expect(env).toEqual({ AGENT_BROWSER_PROXY: 'http://vpn:3128', FEATURE_FLAG: 'on' });
    expect(skipped.sort()).toEqual(['HOME', 'HTTPS_PROXY']);
  });

  it('treats absent and empty env as empty', () => {
    expect(filterContainerEnv(undefined)).toEqual({ env: {}, skipped: [] });
    expect(filterContainerEnv({})).toEqual({ env: {}, skipped: [] });
  });
});

describe('CLAUDE_CODE_QUIET_ENV', () => {
  it('names exactly the flags read out of the shipped binary', () => {
    // Asserted literally: a rename in a provider SDK bump silently restores
    // the Datadog traffic this exists to stop.
    expect(Object.keys(CLAUDE_CODE_QUIET_ENV).sort()).toEqual([
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'DISABLE_ERROR_REPORTING',
      'DISABLE_TELEMETRY',
    ]);
    expect(Object.values(CLAUDE_CODE_QUIET_ENV)).toEqual(['1', '1', '1']);
  });

  it('uses no reserved name, so it can never be filtered out', () => {
    for (const key of Object.keys(CLAUDE_CODE_QUIET_ENV)) {
      expect(isReservedContainerEnv(key), key).toBe(false);
    }
  });
});
