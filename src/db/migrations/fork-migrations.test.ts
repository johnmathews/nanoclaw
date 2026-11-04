/**
 * Fork-local migrations carried onto upstream by the Phase 2 replay.
 *
 * The runner records a migration by `name`, never by `version`, so these four
 * names are an applied identity already present in this install's
 * schema_version ledger (written under the fork's older numbering). A rename
 * makes the live DB treat the migration as new and re-run it — where
 * `ALTER TABLE messaging_groups ADD COLUMN reply_mode` fails on the column
 * that is already there. Renaming is therefore a one-way break on an existing
 * install while looking harmless on a fresh one, which is exactly the kind of
 * change a test has to stop. See .nanoclaw-migrations/index.md §1.11.
 */
import { describe, expect, it } from 'vitest';

import { migrations } from './index.js';

/** Byte-for-byte identities recorded in the live ledger. Never edit. */
const FORK_MIGRATION_NAMES = [
  'reply-mode',
  'reply-mode-channel-default',
  'container-config-env',
  'task-outcomes',
] as const;

describe('fork-local migrations', () => {
  it('keeps each fork migration name byte-for-byte', () => {
    const names = migrations.map((migration) => migration.name);
    for (const name of FORK_MIGRATION_NAMES) expect(names, `missing fork migration: ${name}`).toContain(name);
  });

  it('registers no duplicate migration name', () => {
    // A fork migration colliding with an upstream name would be silently
    // skipped on a fresh install, leaving its column absent.
    const names = migrations.map((migration) => migration.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('orders the fork migrations after every upstream built-in', () => {
    const forkVersions = migrations
      .filter((migration) => (FORK_MIGRATION_NAMES as readonly string[]).includes(migration.name))
      .map((migration) => migration.version);
    const upstreamVersions = migrations
      .filter((migration) => !(FORK_MIGRATION_NAMES as readonly string[]).includes(migration.name))
      .map((migration) => migration.version);
    expect(Math.min(...forkVersions)).toBeGreaterThan(Math.max(...upstreamVersions));
  });

  it('declares every fork migration portable, not sqliteOnly', () => {
    // Upstream's portability policy applies to post-boundary migrations; these
    // are all post-boundary, so they must survive a non-SQLite central DB.
    for (const name of FORK_MIGRATION_NAMES) {
      const migration = migrations.find((candidate) => candidate.name === name);
      expect(migration?.sqliteOnly, name).toBeFalsy();
    }
  });
});
