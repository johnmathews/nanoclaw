import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import {
  DEFAULT_MODEL,
  createContainerConfig,
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigScalars,
} from './container-configs.js';
import { createAgentGroup } from './agent-groups.js';
import { runMigrations } from './migrations/index.js';
import type { AgentGroup } from '../types.js';

function makeAgentGroup(id: string): AgentGroup {
  return {
    id,
    name: id,
    folder: id,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('container-configs default model', () => {
  it('seeds DEFAULT_MODEL when ensureContainerConfig creates a new row', () => {
    createAgentGroup(makeAgentGroup('ag-new'));
    ensureContainerConfig('ag-new');

    const row = getContainerConfig('ag-new');
    expect(row?.model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('claude-opus-4-7');
  });

  it('does not clobber an explicitly set model on subsequent ensureContainerConfig calls', () => {
    createAgentGroup(makeAgentGroup('ag-override'));
    ensureContainerConfig('ag-override');
    updateContainerConfigScalars('ag-override', { model: 'claude-haiku-4-5-20251001' });

    // Idempotent re-init must not reset the override (INSERT OR IGNORE)
    ensureContainerConfig('ag-override');

    expect(getContainerConfig('ag-override')?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('migration 017 backfills NULL model values to the default', () => {
    // Simulate a pre-migration row (legacy backfill path writes model = null)
    createAgentGroup(makeAgentGroup('ag-legacy'));
    createContainerConfig({
      agent_group_id: 'ag-legacy',
      provider: null,
      model: null,
      effort: null,
      image_tag: null,
      assistant_name: null,
      max_messages_per_prompt: null,
      skills: '"all"',
      mcp_servers: '{}',
      packages_apt: '[]',
      packages_npm: '[]',
      additional_mounts: '[]',
      cli_scope: 'group',
      updated_at: new Date().toISOString(),
    });

    expect(getContainerConfig('ag-legacy')?.model).toBeNull();

    // Apply the same UPDATE migration 017 runs. Guards against the SQL drifting.
    getDb().prepare("UPDATE container_configs SET model = 'claude-opus-4-7' WHERE model IS NULL OR model = ''").run();

    expect(getContainerConfig('ag-legacy')?.model).toBe(DEFAULT_MODEL);
  });

  it('migration 017 also rewrites empty-string model values', () => {
    createAgentGroup(makeAgentGroup('ag-empty'));
    ensureContainerConfig('ag-empty');
    getDb().prepare("UPDATE container_configs SET model = '' WHERE agent_group_id = 'ag-empty'").run();

    expect(getContainerConfig('ag-empty')?.model).toBe('');

    getDb().prepare("UPDATE container_configs SET model = 'claude-opus-4-7' WHERE model IS NULL OR model = ''").run();

    expect(getContainerConfig('ag-empty')?.model).toBe(DEFAULT_MODEL);
  });
});
