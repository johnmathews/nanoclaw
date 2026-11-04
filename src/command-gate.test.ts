/**
 * Tests for the host-side command gate — filtered commands are dropped
 * before reaching the container, and admin commands are gated against
 * the user_roles table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gateCommand } from './command-gate.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

function now(): string {
  return new Date().toISOString();
}

async function seedAgentGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

async function seedUser(id: string): Promise<void> {
  await createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await seedAgentGroup('ag-1');
  await seedAgentGroup('ag-2');
});

afterEach(async () => {
  await closeDb();
});

describe('filtered commands', () => {
  it('drops /start before it reaches the container', async () => {
    expect(await gateCommand('/start', 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('drops /start regardless of sender', async () => {
    expect(await gateCommand('/start', null, 'ag-1')).toEqual({ action: 'filter' });
  });
});

describe('admin gating goes through roles', () => {
  it('denies an admin command from a non-admin user', async () => {
    expect(await gateCommand('/clear', 'telegram:nobody', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('denies an admin command with no sender', async () => {
    expect(await gateCommand('/clear', null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('allows an admin command from an owner', async () => {
    await seedUser('telegram:owner');
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    expect(await gateCommand('/clear', 'telegram:owner', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('allows an admin command from a scoped admin of the group', async () => {
    await seedUser('telegram:admin');
    await grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(await gateCommand('/clear', 'telegram:admin', 'ag-1')).toEqual({ action: 'pass' });
    expect(await gateCommand('/clear', 'telegram:admin', 'ag-2')).toEqual({ action: 'deny', command: '/clear' });
  });
});

describe('normal messages pass through', () => {
  it('passes a plain message', async () => {
    expect(await gateCommand('hello there', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes an unknown slash command', async () => {
    expect(await gateCommand('/whatever', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });
});

// Each row: message text and the runner-handled command it executes, if any
// (mirrored in container/agent-runner/src/slash-command.test.ts). A non-admin
// must be denied exactly the rows the runner would execute.
const RUNNER_COMMAND_CORPUS: Array<[string, '/clear' | '/upload-trace' | null]> = [
  ['/clear', '/clear'],
  ['/CLEAR', '/clear'],
  ['  /clear now ', '/clear'],
  ['/clear@somebot', '/clear'],
  ['/CLEAR@Bot', '/clear'],
  ['/clear@somebot please', '/clear'],
  ['/clear\tnow', '/clear'],
  ['/clear\nnow', '/clear'],
  ['/clearx', null],
  ['/clear.', null],
  ['/clear-', null],
  ['/clear_all', null],
  ['/clear@', null],
  ['/clear@bot.', null],
  ['/clear@bot/x', null],
  ['/upload-trace', '/upload-trace'],
  ['/upload-trace@somebot', '/upload-trace'],
  ['/UPLOAD-TRACE now', '/upload-trace'],
  ['/upload-tracex', null],
  ['/upload-trace.', null],
  ['/upload', null],
  ['clear', null],
  ['hello /clear', null],
];

describe('gate and runner agree on command names', () => {
  it.each(RUNNER_COMMAND_CORPUS)('%j from a non-admin', async (text, executes) => {
    const expected = executes ? { action: 'deny', command: executes } : { action: 'pass' };
    expect(await gateCommand(JSON.stringify({ text }), 'telegram:nobody', 'ag-1')).toEqual(expected);
  });

  it('gates a native admin command sent with a bot suffix', async () => {
    expect(await gateCommand('/compact@somebot', 'telegram:nobody', 'ag-1')).toEqual({
      action: 'deny',
      command: '/compact',
    });
  });

  it('still lets an owner run a suffixed admin command', async () => {
    await seedUser('telegram:owner');
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    expect(await gateCommand('/clear@somebot', 'telegram:owner', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('drops a filtered command sent with a bot suffix', async () => {
    expect(await gateCommand('/start@somebot', 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });

  // The Claude SDK runs these aliases as the gated command itself.
  it.each(['/reset', '/new', '/usage', '/stats'])('denies the SDK alias %s to a non-admin', async (alias) => {
    expect(await gateCommand(`${alias}@somebot now`, 'telegram:nobody', 'ag-1')).toEqual({
      action: 'deny',
      command: alias,
    });
  });

  it.each(['/checkup', '/settings', '/rc'])('drops the SDK alias %s like its command', async (alias) => {
    expect(await gateCommand(alias, 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });
});

describe('host-responder commands (/status, /usage)', () => {
  // The renderers themselves are covered by health-snapshot.test.ts and
  // usage.test.ts; what matters here is the gate's classification. Admin
  // gating is the security-relevant half — the output names channels,
  // sessions and account utilization, so a non-admin must be denied rather
  // than served.
  it('serves an admin with a renderer instead of passing to the container', async () => {
    await seedUser('u-admin');
    await grantRole({ user_id: 'u-admin', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    for (const command of ['/status', '/usage']) {
      const gate = await gateCommand(command, 'u-admin', 'ag-1');
      expect(gate.action, command).toBe('respond');
      if (gate.action !== 'respond') throw new Error('unreachable');
      expect(gate.command).toBe(command);
      expect(typeof gate.render).toBe('function');
    }
  });

  it('denies a non-admin', async () => {
    await seedUser('u-plain');
    for (const command of ['/status', '/usage']) {
      expect(await gateCommand(command, 'u-plain', 'ag-1'), command).toEqual({ action: 'deny', command });
    }
  });

  it('denies an unidentified sender', async () => {
    expect(await gateCommand('/status', null, 'ag-1')).toEqual({ action: 'deny', command: '/status' });
  });

  it('is scoped by agent group like any admin command', async () => {
    await seedUser('u-scoped');
    await grantRole({ user_id: 'u-scoped', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    expect((await gateCommand('/status', 'u-scoped', 'ag-1')).action).toBe('respond');
    expect(await gateCommand('/status', 'u-scoped', 'ag-2')).toEqual({ action: 'deny', command: '/status' });
  });

  it('leaves ordinary messages and unknown commands alone', async () => {
    await seedUser('u-admin2');
    await grantRole({ user_id: 'u-admin2', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(await gateCommand('what is the status?', 'u-admin2', 'ag-1')).toEqual({ action: 'pass' });
    expect(await gateCommand('/statuses', 'u-admin2', 'ag-1')).toEqual({ action: 'pass' });
  });
});
