import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import type { AgentGroup } from './types.js';

const AG = 'ag-compose';
let groupDir: string;

function group(): AgentGroup {
  // Absolute folder ⇒ path.resolve(GROUPS_DIR, folder) === folder (temp dir).
  return { id: AG, name: AG, folder: groupDir, agent_provider: null, created_at: new Date().toISOString() };
}

function read(file: string): string {
  return fs.readFileSync(path.join(groupDir, file), 'utf8');
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-compose-'));
  createAgentGroup(group());
  ensureContainerConfig(AG);
});

afterEach(() => {
  closeDb();
  fs.rmSync(groupDir, { recursive: true, force: true });
});

describe('composeGroupClaudeMd — memory seeding', () => {
  it('migrates CLAUDE.local.md into MEMORY.md, blanks the local file, sizes the budget', () => {
    const content = 'x'.repeat(2000); // ceil(2000*1.25)=2500 > floor 2200
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), content);

    composeGroupClaudeMd(group());

    expect(read('MEMORY.md').trim()).toBe(content);
    expect(read('CLAUDE.local.md')).not.toContain(content); // blanked (pointer note only)
    expect(read('CLAUDE.local.md')).toContain('MEMORY.md');
    expect(getContainerConfig(AG)?.memory_budget_chars).toBe(2500);
    expect(fs.existsSync(path.join(groupDir, 'USER.md'))).toBe(true);
  });

  it('seeds an empty MEMORY.md and keeps the floor budget when no local content', () => {
    composeGroupClaudeMd(group());
    expect(fs.existsSync(path.join(groupDir, 'MEMORY.md'))).toBe(true);
    expect(read('MEMORY.md')).toBe('');
    expect(getContainerConfig(AG)?.memory_budget_chars).toBe(2200);
  });

  it('is idempotent — a second compose does not re-seed or un-blank', () => {
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'original memory');
    composeGroupClaudeMd(group());
    const afterFirst = read('CLAUDE.local.md');

    // Simulate the agent later appending to MEMORY.md via the remember tool.
    fs.writeFileSync(path.join(groupDir, 'MEMORY.md'), 'original memory\nnew lesson');
    composeGroupClaudeMd(group());

    expect(read('CLAUDE.local.md')).toBe(afterFirst); // unchanged
    expect(read('MEMORY.md')).toBe('original memory\nnew lesson'); // not clobbered
  });
});

describe('composeGroupClaudeMd — memory injection', () => {
  it('injects MEMORY.md and USER.md as frozen fragments imported by CLAUDE.md', () => {
    fs.writeFileSync(path.join(groupDir, 'MEMORY.md'), 'remembered lesson');
    fs.writeFileSync(path.join(groupDir, 'USER.md'), 'user is John');

    composeGroupClaudeMd(group());

    const memFrag = read(path.join('.claude-fragments', 'memory.md'));
    expect(memFrag).toContain('Operational memory (MEMORY.md)');
    expect(memFrag).toContain('remembered lesson');

    const userFrag = read(path.join('.claude-fragments', 'user.md'));
    expect(userFrag).toContain('User profile (USER.md)');
    expect(userFrag).toContain('user is John');

    const composed = read('CLAUDE.md');
    expect(composed).toContain('@./.claude-fragments/memory.md');
    expect(composed).toContain('@./.claude-fragments/user.md');
  });

  it('omits the fragment when the file is empty, and prunes a stale fragment', () => {
    // First compose with content creates the fragment.
    fs.writeFileSync(path.join(groupDir, 'MEMORY.md'), 'temporary');
    composeGroupClaudeMd(group());
    expect(fs.existsSync(path.join(groupDir, '.claude-fragments', 'memory.md'))).toBe(true);

    // Empty it and recompose — fragment must be pruned and import dropped.
    fs.writeFileSync(path.join(groupDir, 'MEMORY.md'), '');
    composeGroupClaudeMd(group());
    expect(fs.existsSync(path.join(groupDir, '.claude-fragments', 'memory.md'))).toBe(false);
    expect(read('CLAUDE.md')).not.toContain('@./.claude-fragments/memory.md');
  });
});
