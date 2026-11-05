/**
 * Registering an MCP server must be the ONLY wiring needed to expose its
 * tools.
 *
 * There is no static allowlist edit for a new server: `resolveClaudeMcpServers`
 * derives `mcp__<name>__*` from the registered servers, and the provider passes
 * the result straight to `allowedTools`. If that derivation is lost, a server
 * registered in a group's mcpServers map still starts, still appears to the
 * SDK — and every one of its tools is silently filtered out. That failure is
 * invisible from the outside, which is why it gets a test.
 *
 * Carried from the fork's add-gmail-tool skill, where it asserted the old
 * shape (an `mcpAllowPattern` function plus an
 * `Object.keys(this.mcpServers).map(...)` spread) through the TypeScript AST.
 * Upstream moved the derivation into this exported, pure function, so the
 * guard is now behavioural: it calls the real thing instead of pattern-matching
 * the source that implements it.
 */
import { describe, it, expect } from 'bun:test';

import { resolveClaudeMcpServers } from './claude-config.js';
import type { McpServerConfig } from '../types.js';

const server = (command: string): McpServerConfig => ({ command, args: [] }) as McpServerConfig;

function allowed(names: string[]): string[] {
  return resolveClaudeMcpServers(
    Object.fromEntries(names.map((n) => [n, server('/bin/true')])),
    {} as NodeJS.ProcessEnv,
  ).allowedTools;
}

describe('MCP allow-pattern derivation', () => {
  it('derives a wildcard for each registered server', () => {
    const tools = allowed(['gmail', 'gcal']);
    expect(tools).toContain('mcp__gmail__*');
    expect(tools).toContain('mcp__gcal__*');
  });

  it('keeps the base allowlist alongside the derived patterns', () => {
    // The derived entries are additive — losing the spread would strip the
    // built-in tools instead, which is a different and louder failure.
    const base = allowed([]);
    expect(base.length).toBeGreaterThan(0);
    expect(allowed(['gmail']).length).toBe(base.length + 1);
  });

  it('adds nothing when no server is registered', () => {
    expect(allowed([]).some((t) => t.startsWith('mcp__'))).toBe(false);
  });

  it('sanitizes a name that is not pattern-safe', () => {
    // A server name with dots or slashes must still produce a usable pattern
    // rather than one the SDK silently never matches.
    const tools = allowed(['my.tool/v2']);
    const derived = tools.filter((t) => t.startsWith('mcp__'));
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatch(/^mcp__[A-Za-z0-9_-]+__\*$/);
  });

  it('passes the registered servers through unchanged', () => {
    const resolved = resolveClaudeMcpServers({ gmail: server('/bin/true') }, {} as NodeJS.ProcessEnv);
    expect(Object.keys(resolved.mcpServers)).toEqual(['gmail']);
  });
});
