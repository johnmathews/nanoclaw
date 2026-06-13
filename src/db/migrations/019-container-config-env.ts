import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Add a per-group `env` map to container_configs. These key=value pairs are
 * injected into the agent container as `-e` flags at spawn time (see
 * `buildContainerArgs` in src/container-runner.ts), giving operators a
 * transparent way to set environment variables read by tools the agent runs
 * (e.g. AGENT_BROWSER_* for paywall-bypass browsing) without code changes.
 *
 * Reserved keys (TZ, HOME, proxy/cert vars wired by the host + OneCLI gateway)
 * are filtered at injection time — see RESERVED_CONTAINER_ENV — so a stray
 * entry here can never clobber the credential proxy. Stored as a JSON object;
 * default '{}'.
 */
export const migration019: Migration = {
  version: 19,
  name: 'container-config-env',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}';`);
  },
};
