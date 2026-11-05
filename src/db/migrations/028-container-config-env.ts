import type { Migration } from './index.js';

/**
 * Per-group `env` map on `container_configs`. These key=value pairs are
 * injected into the agent container as `-e` flags at spawn, giving operators a
 * transparent way to set variables read by tools the agent runs (e.g.
 * AGENT_BROWSER_* for paywall-bypass browsing) without code changes.
 *
 * Reserved keys (TZ, HOME, the proxy and CA-cert vars wired by the host and the
 * credential gateway) are filtered at set time AND at injection time, so a
 * stray entry here can never reroute API traffic around the gateway. Stored as
 * a JSON object; default '{}'.
 *
 * NAME IS LOAD-BEARING — see migration 026's header.
 */
export const migration028: Migration = {
  version: 28,
  name: 'container-config-env',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}';`);
  },
};
