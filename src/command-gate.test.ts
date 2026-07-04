/**
 * Tests for the host-side command gate — filtered commands are dropped
 * before reaching the container, admin commands are gated against the
 * user_roles table (via hasAdminPrivilege), and host-responder commands
 * (/usage, /status) render inline for admins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// /usage and /status renderers hit live surfaces (Anthropic usage endpoint,
// health snapshot) — stub them so the gate can be tested without network/state.
vi.mock('./usage.js', () => ({
  getUsageText: vi.fn(async () => 'mock usage text'),
}));

vi.mock('./health-snapshot.js', () => ({
  snapshotHealth: vi.fn(() => ({ stub: true })),
}));

vi.mock('./health.js', () => ({
  formatHealthText: vi.fn(() => 'mock status text'),
}));

import { gateCommand } from './command-gate.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

function seedUser(id: string): void {
  createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

function seedOwner(id: string): void {
  seedUser(id);
  grantRole({ user_id: id, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  seedAgentGroup('ag-1');
  seedAgentGroup('ag-2');
});

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
});

function content(text: string): string {
  return JSON.stringify({ text });
}

describe('filtered commands', () => {
  it('drops /start before it reaches the container', () => {
    expect(gateCommand('/start', 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('drops /start regardless of sender', () => {
    expect(gateCommand('/start', null, 'ag-1')).toEqual({ action: 'filter' });
  });

  it('filters /help silently', () => {
    expect(gateCommand(content('/help'), 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });
});

describe('admin gating goes through roles', () => {
  it('denies an admin command from a non-admin user', () => {
    expect(gateCommand('/clear', 'telegram:nobody', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('denies an admin command with no sender', () => {
    expect(gateCommand('/clear', null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('allows an admin command from an owner', () => {
    seedOwner('telegram:owner');
    expect(gateCommand('/clear', 'telegram:owner', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('allows an admin command from a scoped admin of the group', () => {
    seedUser('telegram:admin');
    grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(gateCommand('/clear', 'telegram:admin', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('/clear', 'telegram:admin', 'ag-2')).toEqual({ action: 'deny', command: '/clear' });
  });
});

describe('/usage host responder', () => {
  it('returns a respond action whose render produces the usage text (admin)', async () => {
    seedOwner('telegram:owner');
    const result = gateCommand(content('/usage'), 'telegram:owner', 'ag-1');
    expect(result.action).toBe('respond');
    if (result.action === 'respond') {
      expect(result.command).toBe('/usage');
      await expect(result.render()).resolves.toBe('mock usage text');
    }
  });

  it('denies /usage from a non-admin user', () => {
    expect(gateCommand(content('/usage'), 'telegram:nobody', 'ag-1')).toEqual({ action: 'deny', command: '/usage' });
  });

  it('denies /usage when caller is anonymous', () => {
    expect(gateCommand(content('/usage'), null, 'ag-1')).toEqual({ action: 'deny', command: '/usage' });
  });

  it('matches /usage regardless of trailing text (admin)', () => {
    seedOwner('telegram:owner');
    const result = gateCommand(content('/usage right now please'), 'telegram:owner', 'ag-1');
    expect(result.action).toBe('respond');
  });
});

describe('/status host responder', () => {
  it('returns a respond action whose render produces the status text (admin)', async () => {
    seedOwner('telegram:owner');
    const result = gateCommand(content('/status'), 'telegram:owner', 'ag-1');
    expect(result.action).toBe('respond');
    if (result.action === 'respond') {
      expect(result.command).toBe('/status');
      await expect(result.render()).resolves.toBe('mock status text');
    }
  });

  it('denies /status when caller is anonymous', () => {
    expect(gateCommand(content('/status'), null, 'ag-1')).toEqual({ action: 'deny', command: '/status' });
  });
});

describe('normal messages pass through', () => {
  it('passes a plain message', () => {
    expect(gateCommand('hello there', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes an unknown slash command', () => {
    expect(gateCommand('/whatever', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('tolerates non-JSON content', () => {
    seedOwner('telegram:owner');
    expect(gateCommand('/usage', 'telegram:owner', 'ag-1').action).toBe('respond');
  });
});
