/**
 * One-shot setup:
 *   Phase 1: Rename John's job-search group (slack_job-search → slack_job-search-john)
 *   Phase 2: Create Ritsya's parallel group (slack_job-search-ritsya), wire to Slack channel C0B62EKV4JH
 *
 * Filesystem operations run sequentially with error checks. DB writes are
 * atomic in one transaction so partial failure can't leave dangling rows.
 *
 * Default is dry-run; pass --apply to commit.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const apply = process.argv.includes('--apply');
const ROOT = '/srv/apps/nanoclaw';
const GROUPS = path.join(ROOT, 'groups');
const DB_PATH = path.join(ROOT, 'data', 'v2.db');

const JOHN_AG_ID = 'ag-1779373702796-yetuu0';
const JOHN_OLD = 'slack_job-search';
const JOHN_NEW = 'slack_job-search-john';

const RITSYA_FOLDER = 'slack_job-search-ritsya';
const RITSYA_CHANNEL_PLATFORM_ID = 'slack:C0B62EKV4JH';

const MAIN_AG_ID = 'ag-1779373702795-5wbiev';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
const RITSYA_AG_ID = genId('ag');
const RITSYA_MG_ID = genId('mg');
const RITSYA_WIRING_ID = genId('mga');

const log = (s: string): void => console.log(s);

log(`MODE: ${apply ? 'APPLY' : 'DRY-RUN'}`);
log('');
log('IDs that will be assigned:');
log(`  Ritsya agent_group : ${RITSYA_AG_ID}`);
log(`  Ritsya messaging_group : ${RITSYA_MG_ID}`);
log(`  Ritsya wiring : ${RITSYA_WIRING_ID}`);
log('');

const db = new Database(DB_PATH);

// ---------------- preflight checks ----------------

const johnRow = db.prepare('SELECT id, name, folder FROM agent_groups WHERE id = ?').get(JOHN_AG_ID) as
  | { id: string; name: string; folder: string }
  | undefined;
if (!johnRow) throw new Error(`John's agent group ${JOHN_AG_ID} not found in DB`);
if (johnRow.folder !== JOHN_OLD) throw new Error(`John's folder is "${johnRow.folder}", expected "${JOHN_OLD}"`);
log(`John's current row: ${JSON.stringify(johnRow)}`);

const ritsyaFolderExists = fs.existsSync(path.join(GROUPS, RITSYA_FOLDER));
if (ritsyaFolderExists) throw new Error(`groups/${RITSYA_FOLDER}/ already exists — refuse to overwrite`);

const dupeMg = db
  .prepare('SELECT id FROM messaging_groups WHERE platform_id = ?')
  .get(RITSYA_CHANNEL_PLATFORM_ID) as { id: string } | undefined;
if (dupeMg) throw new Error(`Slack channel ${RITSYA_CHANNEL_PLATFORM_ID} is already registered as ${dupeMg.id}`);

const johnContainerCfg = db
  .prepare('SELECT additional_mounts FROM container_configs WHERE agent_group_id = ?')
  .get(JOHN_AG_ID) as { additional_mounts: string } | undefined;
const mainContainerCfg = db
  .prepare('SELECT additional_mounts FROM container_configs WHERE agent_group_id = ?')
  .get(MAIN_AG_ID) as { additional_mounts: string } | undefined;
if (!mainContainerCfg) throw new Error('main container_configs row missing');

log('preflight: ok');
log('');

if (!apply) {
  log('Dry-run only. Re-run with --apply to commit.');
  db.close();
  process.exit(0);
}

// ---------------- Phase 1: rename John ----------------

log('Phase 1: Rename John');
const oldDir = path.join(GROUPS, JOHN_OLD);
const newDir = path.join(GROUPS, JOHN_NEW);
fs.renameSync(oldDir, newDir);
log(`  fs: renamed ${oldDir} → ${newDir}`);

// ---------------- Phase 2: scaffold Ritsya's folder ----------------

log('Phase 2a: Scaffold Ritsya folder');
const ritsyaDir = path.join(GROUPS, RITSYA_FOLDER);
fs.mkdirSync(path.join(ritsyaDir, 'criteria'), { recursive: true });
fs.mkdirSync(path.join(ritsyaDir, 'cv'), { recursive: true });
fs.mkdirSync(path.join(ritsyaDir, 'history'), { recursive: true });
log(`  fs: created ${ritsyaDir}/{criteria,cv,history}/`);

const CLAUDE_LOCAL = `# Job Search Agent — Ritsya

You are an automated job search assistant for **Ritsya** (John's wife). Your purpose is to find relevant job
opportunities based on her criteria and report them in this Slack channel.

John relays Ritsya's preferences and questions for now — Ritsya may join the channel directly later.

## Layout of this folder

\`\`\`
/workspace/agent/
├── CLAUDE.local.md       # this file
├── README.md             # human-readable overview
├── criteria/             # Ritsya's job-search preferences (read these first)
├── cv/                   # Ritsya's CV PDFs (read all to understand her background)
└── history/              # past reports and reference artifacts
\`\`\`

## Your Job

1. **Read the criteria files** in \`criteria/\` (\`01-role.md\` through \`07-job-boards.md\`) to understand exactly what Ritsya is looking for
2. **Read the CV files** under \`cv/\` to understand her background
3. **Search for matching jobs** on the job boards specified in \`criteria/07-job-boards.md\`
4. **Post a report** summarising the most interesting opportunities you found

If criteria files are not yet filled in, post a message asking John to complete them first.

## Criteria Files

All under \`criteria/\`:

- \`01-role.md\` — job titles, seniority, industry
- \`02-location.md\` — remote/hybrid/on-site, geographic preferences
- \`03-compensation.md\` — salary range, benefits
- \`04-technical.md\` — skills, tools, must-haves
- \`05-company.md\` — company size, culture, stage
- \`06-schedule.md\` — when to search, when to report
- \`07-job-boards.md\` — which sites to search

## Report Delivery

Reports are sent to **this Slack channel only** (no email by default — change in \`criteria/06-schedule.md\` if Ritsya wants email).

### Slack format

- Use Slack mrkdwn: *bold*, _italic_, • bullets
- **No links in the Slack message** — Slack unfurls links into previews which creates visual clutter
- Jobs are identified by number only. John can ask "give me the link for job 3" and you reply with just that URL in a new message
- Keep it scannable — one line per job entry

## Notes

- Be selective — quality over quantity. Only include genuinely interesting matches.
- Avoid sin industries unless Ritsya explicitly wants them: gambling, fossil fuels, tobacco, weapons/defence.
- The \`criteria/\` files are the source of truth — if you're ever unsure what Ritsya wants, re-read them rather than guessing.
`;

const README = `# Job Search Configuration — Ritsya

Fill in the files under \`criteria/\` to configure Ritsya's automated job search.

## Structure

\`\`\`
slack_job-search-ritsya/
├── CLAUDE.local.md       # agent role / behaviour
├── README.md             # this file
├── criteria/             # job-search preferences (edit these)
│   ├── 01-role.md            # job titles, seniority, industry
│   ├── 02-location.md        # where she wants to work
│   ├── 03-compensation.md    # salary, contract vs permanent
│   ├── 04-technical.md       # skills, tools, must-haves
│   ├── 05-company.md         # company size, culture, specific names
│   ├── 06-schedule.md        # when to search, when to report
│   └── 07-job-boards.md      # which sites to search
├── cv/                   # Ritsya's CV PDFs (drop them in here)
└── history/              # past job-link reports and reference artifacts
\`\`\`

Once criteria files are filled in and at least one CV is in \`cv/\`, ask the channel agent to set up the
scheduled search task — the same workflow as John's group.
`;

const CRITERIA_TEMPLATES: Record<string, string> = {
  '01-role.md': `# Role & Seniority

Fill in the answers. Delete questions that don't apply; add anything missed.

## What job titles are you looking for?
*Primary preference:*
*Secondary:*

## What seniority level?
*Junior / Mid / Senior / Lead / Principal — pick one or a range:*

## What industries / domains?
`,
  '02-location.md': `# Location & Work Style

## Where are you based?

## Are you open to remote work?
*Remote / Hybrid (how many days office-vs-home) / On-site only:*

## Acceptable commute / max distance?

## Any geographic restrictions or preferences?
`,
  '03-compensation.md': `# Compensation

## Minimum acceptable salary?

## Target / hoping-for salary?

## Contract or permanent?

## Benefits / equity preferences?
`,
  '04-technical.md': `# Technical Criteria

## Primary skills / tech stack?

## Skills she enjoys using?

## Must-haves?

## Deal-breakers?
`,
  '05-company.md': `# Company Preferences

## Company size preference?
*Startup / scale-up / large corp — any of these or specific:*

## Any specific companies she'd love to work for?

## Any companies to exclude?
`,
  '06-schedule.md': `# Search Schedule

## What time should the nightly search run? (Amsterdam time)

## What time should the report arrive?

## Delivery channels
- This Slack channel
- (add email address if Ritsya wants email too)
`,
  '07-job-boards.md': `# Job Boards & Sources

## Which job boards should I search?
Tick \`[x]\` to enable, leave \`[ ]\` to skip.

- [ ] LinkedIn
- [ ] Indeed
- [ ] Otta (otta.com)
- [ ] Wellfound
- [ ] (add other boards she prefers)

## Any specific company career pages to check directly?
`,
};

fs.writeFileSync(path.join(ritsyaDir, 'CLAUDE.local.md'), CLAUDE_LOCAL);
fs.writeFileSync(path.join(ritsyaDir, 'README.md'), README);
for (const [name, body] of Object.entries(CRITERIA_TEMPLATES)) {
  fs.writeFileSync(path.join(ritsyaDir, 'criteria', name), body);
}
log(`  fs: wrote CLAUDE.local.md, README.md, criteria/*.md`);

// ---------------- DB transaction: rename John + insert Ritsya + update mounts ----------------

const now = new Date().toISOString();

// Update main's additional_mounts: old slack_job-search path → slack_job-search-john path, AND add Ritsya
const mainMounts = JSON.parse(mainContainerCfg.additional_mounts) as Array<{
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}>;
const updatedMainMounts = mainMounts.map((m) => {
  if (m.hostPath === path.join(GROUPS, JOHN_OLD)) {
    return { ...m, hostPath: path.join(GROUPS, JOHN_NEW), containerPath: JOHN_NEW };
  }
  return m;
});
updatedMainMounts.push({
  hostPath: path.join(GROUPS, RITSYA_FOLDER),
  containerPath: RITSYA_FOLDER,
  readonly: false,
});

const tx = db.transaction(() => {
  // Phase 1: rename John in agent_groups
  db.prepare("UPDATE agent_groups SET folder = ?, name = ? WHERE id = ?").run(JOHN_NEW, 'job-search-john', JOHN_AG_ID);

  // Phase 1: update main's additional_mounts
  db.prepare("UPDATE container_configs SET additional_mounts = ?, updated_at = ? WHERE agent_group_id = ?").run(
    JSON.stringify(updatedMainMounts),
    now,
    MAIN_AG_ID,
  );

  // Phase 2: insert Ritsya's agent_groups row
  db.prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)").run(
    RITSYA_AG_ID,
    'job-search-ritsya',
    RITSYA_FOLDER,
    now,
  );

  // Phase 2: insert Ritsya's container_configs row (copying John's defaults — empty provider/model, skills='all', cli_scope='group')
  db.prepare(
    `INSERT INTO container_configs
       (agent_group_id, provider, model, image_tag, assistant_name, max_messages_per_prompt,
        cli_scope, skills, mcp_servers, packages_apt, packages_npm, additional_mounts, updated_at)
     VALUES (?, '', '', '', '', NULL, 'group', '"all"', '{}', '[]', '[]', '[]', ?)`,
  ).run(RITSYA_AG_ID, now);

  // Phase 2: insert Ritsya's messaging_groups row
  // unknown_sender_policy='public' matches the rest of this install — the
  // schema default 'strict' requires a member row in agent_group_members,
  // which nothing populates today. 'public' lets the owner (and anyone in
  // the Slack channel) interact without an explicit membership row.
  db.prepare(
    "INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at, reply_mode) VALUES (?, 'slack', ?, 'job-search-ritsya', 1, 'public', ?, 'thread')",
  ).run(RITSYA_MG_ID, RITSYA_CHANNEL_PLATFORM_ID, now);

  // Phase 2: insert wiring (same shape as John: pattern engagement, always-on, sender_scope=all, agent-shared sessions)
  db.prepare(
    `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
     VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'agent-shared', 0, ?)`,
  ).run(RITSYA_WIRING_ID, RITSYA_MG_ID, RITSYA_AG_ID, now);
});

tx();
log('  db: transaction committed');
log('');

// ---------------- summary ----------------

log('Done.');
log('');
log('Verify:');
log('  pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, name, folder FROM agent_groups WHERE folder LIKE \'slack_job-search%\'"');
log('  pnpm exec tsx scripts/q.ts data/v2.db "SELECT mga.id, ag.folder, mg.name, mga.session_mode FROM messaging_group_agents mga JOIN agent_groups ag ON ag.id=mga.agent_group_id JOIN messaging_groups mg ON mg.id=mga.messaging_group_id WHERE ag.folder LIKE \'slack_job-search%\'"');

db.close();
