/**
 * One-off bootstrap for the #financial-times feed channel.
 *
 * Mirrors the working #hackernews-summaries setup: a group ("feed") channel
 * wired agent-shared with a catch-all engage pattern, public sender policy,
 * and the paywall-bypass browser config (env + RO extension mount) layered on.
 *
 * Goes through the validated DB helpers (NOT raw SQL) so all the easy-to-miss
 * steps are covered: container_configs row (ensureContainerConfig via
 * initGroupFilesystem), agent_destinations row (createMessagingGroupAgent),
 * filesystem scaffold, and a valid UUID agent-group id. OneCLI ensureAgent
 * runs at first spawn — this channel needs no vault secrets (paywall is the
 * extension; posting is host-side via the Slack adapter).
 *
 * Idempotent: reuses existing rows. Safe to re-run.
 *
 * Usage: pnpm exec tsx scripts/init-ft-channel.ts
 */
import crypto from 'crypto';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { updateContainerConfigJson } from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup } from '../src/types.js';

const CHANNEL = 'slack';
const PLATFORM_ID = 'slack:C0B9WUU7D7H'; // #financial-times
const AGENT_NAME = 'Financial Times';
const FOLDER = 'slack_financial-times';
const MG_NAME = 'financial-times';

// Paywall-bypass browser config (see docs/research-paywall-browser.md).
// FT specifically is not bypassable by BPC's direct method (it punts to
// archive.today) and the Googlebot-UA trick gets a 403, so the FT task reads
// article bodies via archive.today. A realistic UA + AutomationControlled-off
// keeps ft.com (headline discovery) and archive.today loading without tripping
// bot detection. The BPC extension still rides along for any non-FT links.
const PAYWALL_ENV = {
  AGENT_BROWSER_EXTENSIONS: '/workspace/extra/bpc',
  AGENT_BROWSER_PROFILE: '/workspace/agent/.bpc-profile',
  AGENT_BROWSER_ARGS: '--no-sandbox,--headless=new,--disable-blink-features=AutomationControlled',
  AGENT_BROWSER_USER_AGENT:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
};
const PAYWALL_MOUNTS = [
  {
    hostPath: '/srv/apps/syncthing/all/bypass-paywalls-chrome-clean-master',
    containerPath: 'bpc',
    readonly: true,
  },
];

function main(): void {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent
  const now = new Date().toISOString();

  // 1. Agent group + filesystem scaffold (creates container_configs row).
  let ag: AgentGroup | undefined = getAgentGroupByFolder(FOLDER);
  if (!ag) {
    createAgentGroup({
      id: crypto.randomUUID(),
      name: AGENT_NAME,
      folder: FOLDER,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(FOLDER)!;
    console.log(`Created agent group: ${ag.id} (${FOLDER})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${FOLDER})`);
  }
  initGroupFilesystem(ag); // ensureContainerConfig + .claude-shared; won't clobber existing CLAUDE.local.md

  // 2. Paywall browser config on the container.
  updateContainerConfigJson(ag.id, 'env', PAYWALL_ENV);
  updateContainerConfigJson(ag.id, 'additional_mounts', PAYWALL_MOUNTS);
  console.log('Set paywall browser env + extension mount.');

  // 3. Messaging group (feed channel: public, group, channel reply mode).
  let mg = getMessagingGroupByPlatform(CHANNEL, PLATFORM_ID);
  if (!mg) {
    createMessagingGroup({
      id: crypto.randomUUID(),
      channel_type: CHANNEL,
      platform_id: PLATFORM_ID,
      name: MG_NAME,
      is_group: 1,
      unknown_sender_policy: 'public', // must be explicit — 'strict' default drops all
      reply_mode: 'channel',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform(CHANNEL, PLATFORM_ID)!;
    console.log(`Created messaging group: ${mg.id} (${PLATFORM_ID})`);
  } else {
    console.log(`Reusing messaging group: ${mg.id} (${PLATFORM_ID})`);
  }

  // 4. Wiring (agent-shared so the recurring task isn't stranded in a
  //    per-thread session; catch-all '.' so every channel message engages).
  if (getMessagingGroupAgentByPair(mg.id, ag.id)) {
    console.log('Wiring already exists.');
  } else {
    createMessagingGroupAgent({
      id: crypto.randomUUID(),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired ${mg.id} -> ${ag.id} (agent-shared, pattern '.')`);
  }

  console.log('');
  console.log('FT channel wiring complete.');
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${FOLDER}`);
  console.log(`  channel: ${CHANNEL} ${PLATFORM_ID}`);
}

main();
