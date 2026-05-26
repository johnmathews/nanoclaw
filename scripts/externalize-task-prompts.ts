/**
 * Externalize scheduled-task prompts into editable markdown files.
 *
 * For each known live task:
 *   1. Read the current prompt from messages_in.content
 *   2. Fix any stale v1 paths (/workspace/group → /workspace/agent)
 *   3. Write the body to groups/<folder>/tasks/<slug>.md
 *   4. Replace the task row's prompt with: "Read /workspace/agent/tasks/<slug>.md and follow it exactly."
 *
 * Default is dry-run. Pass --apply to commit.
 *
 * Reversible by restoring the prompt JSON manually from the markdown file.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

interface TaskEntry {
  agentGroupId: string;
  sessionId: string;
  taskId: string;
  groupFolder: string;
  slug: string;
}

const TASKS: TaskEntry[] = [
  {
    agentGroupId: 'ag-1779373702795-5wbiev',
    sessionId: 'sess-1779373704233-eu40dq',
    taskId: 'task-1778224040275-4dht84',
    groupFolder: 'main',
    slug: 'morning-report',
  },
  {
    agentGroupId: 'ag-1779373702795-5wbiev',
    sessionId: 'sess-1779373704233-eu40dq',
    taskId: 'task-1778399790530-f2euaw',
    groupFolder: 'main',
    slug: 'documentation-summary',
  },
  {
    agentGroupId: 'ag-1779373702794-62oxsv',
    sessionId: 'sess-1779373704595-mqteww',
    taskId: 'task-1775472071448-rpvh6c',
    groupFolder: 'slack_nanoclaw-introspection',
    slug: 'git-maintenance',
  },
  {
    agentGroupId: 'ag-1779373702801-p8esva',
    sessionId: 'sess-1779373705838-l34qo2',
    taskId: 'task-1778486931678-gh31yp',
    groupFolder: 'slack_the-managers-guide',
    slug: 'newsletter-extraction',
  },
];

const apply = process.argv.includes('--apply');
const GROUPS = '/srv/apps/nanoclaw/groups';
const SESSIONS = '/srv/apps/nanoclaw/data/v2-sessions';

function fixV1Paths(s: string): string {
  return s.replace(/\/workspace\/group\b/g, '/workspace/agent');
}

function newPromptFor(slug: string): string {
  return `Read /workspace/agent/tasks/${slug}.md and follow the instructions there exactly. The file is the single source of truth for this task — if anything in this prompt seems to conflict with the file, the file wins.`;
}

for (const t of TASKS) {
  const inboundPath = path.join(SESSIONS, t.agentGroupId, t.sessionId, 'inbound.db');
  if (!fs.existsSync(inboundPath)) {
    console.log(`[${t.slug}] SKIP — inbound.db missing at ${inboundPath}`);
    continue;
  }
  const db = new Database(inboundPath);
  const row = db
    .prepare("SELECT id, content FROM messages_in WHERE series_id = ? AND status IN ('pending','paused') ORDER BY seq DESC LIMIT 1")
    .get(t.taskId) as { id: string; content: string } | undefined;
  if (!row) {
    console.log(`[${t.slug}] SKIP — no live row for ${t.taskId}`);
    db.close();
    continue;
  }
  const parsed = JSON.parse(row.content);
  const originalPrompt: string = parsed.prompt;
  const fixedBody = fixV1Paths(originalPrompt);

  const tasksDir = path.join(GROUPS, t.groupFolder, 'tasks');
  const mdPath = path.join(tasksDir, `${t.slug}.md`);
  const newPrompt = newPromptFor(t.slug);
  const newContent = JSON.stringify({ ...parsed, prompt: newPrompt });

  console.log(`\n[${t.slug}]`);
  console.log(`  inbound.db   : ${inboundPath}`);
  console.log(`  task row     : ${row.id}  (series ${t.taskId})`);
  console.log(`  write file   : ${mdPath}  (${fixedBody.length} chars)`);
  if (originalPrompt !== fixedBody) {
    console.log(`  v1→v2 paths  : rewritten`);
  }
  console.log(`  new prompt   : "${newPrompt.slice(0, 60)}..."`);

  if (apply) {
    fs.mkdirSync(tasksDir, { recursive: true });
    const header = `<!-- Externalized task prompt for series ${t.taskId}. Edit freely — the task fires whatever is in this file at its next run. -->\n\n`;
    fs.writeFileSync(mdPath, header + fixedBody + '\n');
    db.prepare("UPDATE messages_in SET content = ? WHERE id = ?").run(newContent, row.id);
    console.log(`  applied      : file written + DB updated`);
  }
  db.close();
}

if (!apply) {
  console.log('\nDry-run only. Re-run with --apply to commit.');
}
