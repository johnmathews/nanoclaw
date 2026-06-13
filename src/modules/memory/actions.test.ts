import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate the handler from the (separately tested) compose machinery.
vi.mock('../../claude-md-compose.js', () => ({ composeGroupClaudeMd: vi.fn() }));

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { AgentGroup, Session } from '../../types.js';
import { handleRemember } from './actions.js';

const AG = 'ag-mem';
let groupDir: string;
let inDb: Database.Database;

function makeInbound(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
      status TEXT DEFAULT 'pending', platform_id TEXT, channel_type TEXT, thread_id TEXT,
      content TEXT NOT NULL, process_after TEXT, recurrence TEXT, series_id TEXT,
      tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, source_session_id TEXT,
      on_wake INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function session(): Session {
  return {
    id: 'sess-mem',
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function makeGroup(folder: string): AgentGroup {
  return { id: AG, name: AG, folder, agent_provider: null, created_at: new Date().toISOString() };
}

/** Read the host's reply frame for a given remember request from inbound.db. */
function replyFrame(requestId: string): Record<string, unknown> | undefined {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`rem-resp-${requestId}`) as
    | { content: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(row.content).frame;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mem-'));
  // Absolute folder ⇒ path.resolve(GROUPS_DIR, folder) === folder, so the
  // handler writes into our temp dir instead of the real groups/ tree.
  createAgentGroup(makeGroup(groupDir));
  ensureContainerConfig(AG);
  inDb = makeInbound();
});

afterEach(() => {
  inDb.close();
  closeDb();
  fs.rmSync(groupDir, { recursive: true, force: true });
});

describe('handleRemember — happy paths', () => {
  it('add writes MEMORY.md and replies ok', async () => {
    await handleRemember({ requestId: 'r1', target: 'memory', op: 'add', text: 'prefers metric units' }, session(), inDb);

    expect(fs.readFileSync(path.join(groupDir, 'MEMORY.md'), 'utf8')).toBe('prefers metric units');
    expect(replyFrame('r1')).toMatchObject({ ok: true, target: 'memory', op: 'add' });
  });

  it('writes USER.md for target=user', async () => {
    await handleRemember({ requestId: 'r2', target: 'user', op: 'add', text: 'name is John' }, session(), inDb);
    expect(fs.readFileSync(path.join(groupDir, 'USER.md'), 'utf8')).toBe('name is John');
    expect(replyFrame('r2')).toMatchObject({ ok: true, target: 'user' });
  });

  it('replace edits the matching entry', async () => {
    fs.writeFileSync(path.join(groupDir, 'MEMORY.md'), 'likes tea\ndislikes noise');
    await handleRemember(
      { requestId: 'r3', target: 'memory', op: 'replace', match: 'tea', replacement: 'likes coffee' },
      session(),
      inDb,
    );
    expect(fs.readFileSync(path.join(groupDir, 'MEMORY.md'), 'utf8')).toBe('likes coffee\ndislikes noise');
    expect(replyFrame('r3')).toMatchObject({ ok: true });
  });

  it('remove deletes the matching entry', async () => {
    fs.writeFileSync(path.join(groupDir, 'MEMORY.md'), 'keep this\ndrop that');
    await handleRemember({ requestId: 'r4', target: 'memory', op: 'remove', match: 'drop' }, session(), inDb);
    expect(fs.readFileSync(path.join(groupDir, 'MEMORY.md'), 'utf8')).toBe('keep this');
    expect(replyFrame('r4')).toMatchObject({ ok: true });
  });
});

describe('handleRemember — budget enforcement', () => {
  it('rejects an over-budget add, returns current entries, and does not mutate the file', async () => {
    updateContainerConfigScalars(AG, { memory_budget_chars: 10 });
    fs.writeFileSync(path.join(groupDir, 'MEMORY.md'), 'nine char'); // 9 chars
    await handleRemember(
      { requestId: 'r5', target: 'memory', op: 'add', text: 'this is way too long' },
      session(),
      inDb,
    );
    const frame = replyFrame('r5');
    expect(frame).toMatchObject({ ok: false, error: 'budget_exceeded', budget: 10 });
    expect(frame?.current).toBe('nine char');
    // File untouched.
    expect(fs.readFileSync(path.join(groupDir, 'MEMORY.md'), 'utf8')).toBe('nine char');
  });

  it('uses the per-group user budget for target=user', async () => {
    updateContainerConfigScalars(AG, { user_budget_chars: 5 });
    await handleRemember({ requestId: 'r6', target: 'user', op: 'add', text: 'too long for five' }, session(), inDb);
    expect(replyFrame('r6')).toMatchObject({ ok: false, error: 'budget_exceeded', budget: 5 });
  });
});

describe('handleRemember — validation', () => {
  it('rejects an invalid target', async () => {
    await handleRemember({ requestId: 'r7', target: 'nope', op: 'add', text: 'x' }, session(), inDb);
    expect(replyFrame('r7')).toMatchObject({ ok: false, error: 'invalid_target' });
  });

  it('surfaces no_match with current entries for replace', async () => {
    fs.writeFileSync(path.join(groupDir, 'MEMORY.md'), 'alpha\nbeta');
    await handleRemember(
      { requestId: 'r8', target: 'memory', op: 'replace', match: 'zzz', replacement: 'x' },
      session(),
      inDb,
    );
    expect(replyFrame('r8')).toMatchObject({ ok: false, error: 'no_match', current: 'alpha\nbeta' });
  });
});
