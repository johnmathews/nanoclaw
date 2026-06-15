import { describe, expect, it } from 'vitest';

import { containerEnvArgs, isReservedContainerEnv } from './container-config.js';

describe('isReservedContainerEnv', () => {
  it('flags host/OneCLI-owned keys (case-insensitive)', () => {
    for (const key of ['TZ', 'HOME', 'home', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
      expect(isReservedContainerEnv(key)).toBe(true);
    }
  });

  it('flags the container-network proxy family by exact name (case-insensitive)', () => {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'ALL_PROXY', 'no_proxy', 'FTP_PROXY']) {
      expect(isReservedContainerEnv(key)).toBe(true);
    }
  });

  it('flags CA-bundle override vars used by curl/requests', () => {
    expect(isReservedContainerEnv('CURL_CA_BUNDLE')).toBe(true);
    expect(isReservedContainerEnv('REQUESTS_CA_BUNDLE')).toBe(true);
  });

  it('allows ordinary operator vars', () => {
    for (const key of ['AGENT_BROWSER_EXTENSIONS', 'AGENT_BROWSER_PROFILE', 'AGENT_BROWSER_ARGS', 'MY_FLAG']) {
      expect(isReservedContainerEnv(key)).toBe(false);
    }
  });

  it('allows namespaced tool proxy vars (only the container-network proxy is reserved)', () => {
    // AGENT_BROWSER_PROXY routes the in-tool browser (e.g. through a VPN) and
    // must NOT be caught by the proxy guard — that guard is for the container's
    // own HTTP(S)_PROXY which fronts the OneCLI credential gateway.
    expect(isReservedContainerEnv('AGENT_BROWSER_PROXY')).toBe(false);
    expect(isReservedContainerEnv('AGENT_BROWSER_PROXY_BYPASS')).toBe(false);
  });
});

describe('containerEnvArgs', () => {
  it('returns no args for undefined or empty env', () => {
    expect(containerEnvArgs(undefined)).toEqual({ args: [], skipped: [] });
    expect(containerEnvArgs({})).toEqual({ args: [], skipped: [] });
  });

  it('emits -e KEY=VALUE pairs for allowed keys', () => {
    const { args, skipped } = containerEnvArgs({
      AGENT_BROWSER_EXTENSIONS: '/workspace/extra/bpc',
      AGENT_BROWSER_ARGS: '--no-sandbox,--headless=new',
    });
    expect(args).toEqual([
      '-e',
      'AGENT_BROWSER_EXTENSIONS=/workspace/extra/bpc',
      '-e',
      'AGENT_BROWSER_ARGS=--no-sandbox,--headless=new',
    ]);
    expect(skipped).toEqual([]);
  });

  it('filters reserved keys and reports them so the proxy can never be clobbered', () => {
    const { args, skipped } = containerEnvArgs({
      AGENT_BROWSER_PROFILE: '/workspace/agent/.bpc-profile',
      HTTPS_PROXY: 'http://evil:1234',
      HOME: '/tmp/evil',
      NODE_EXTRA_CA_CERTS: '/tmp/evil.pem',
    });
    expect(args).toEqual(['-e', 'AGENT_BROWSER_PROFILE=/workspace/agent/.bpc-profile']);
    expect(skipped.sort()).toEqual(['HOME', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']);
  });
});
