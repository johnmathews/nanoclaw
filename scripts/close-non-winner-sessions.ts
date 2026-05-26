/**
 * Close non-winner sessions per agent group, in preparation for switching
 * Slack wirings to session_mode='agent-shared'.
 *
 * Background: Slack forces per-thread sessions, so over time each Slack-wired
 * agent group accumulates many sessions (one per top-level @-mention).
 * `findSessionByAgentGroup` picks the most-recently-created active session,
 * which is not the one holding any scheduled tasks. By marking all non-winner
 * sessions as status='closed', we ensure the agent-shared resolver locks onto
 * the chosen winner — preserving recurring task visibility and management.
 *
 * Closing a session row:
 *   - Does NOT affect any running container (containers don't query sessions.status).
 *   - Excludes the session from host-sweep iteration and from session resolution.
 *   - Does NOT delete any files on disk (data/v2-sessions/<g>/<s>/ stays put).
 *
 * Reversible: UPDATE sessions SET status='active' WHERE status='closed';
 *
 * Default is dry-run. Pass --apply to commit.
 */
import Database from 'better-sqlite3';

interface AgentPlan {
  agentGroupId: string;
  folder: string;
  /** Explicit winner session id; if absent we'll auto-pick the latest active session. */
  winnerSessionId?: string;
  /** Reason — printed for transparency. */
  reason: string;
}

const PLAN: AgentPlan[] = [
  {
    agentGroupId: 'ag-1779373702795-5wbiev',
    folder: 'main',
    winnerSessionId: 'sess-1779373704233-eu40dq',
    reason: 'holds 2 live tasks (daily morning report + daily doc summary)',
  },
  {
    agentGroupId: 'ag-1779373702794-62oxsv',
    folder: 'slack_git-maintenance',
    winnerSessionId: 'sess-1779373704595-mqteww',
    reason: 'holds 1 live task (Mon/Thu git maintenance)',
  },
  {
    agentGroupId: 'ag-1779373702801-p8esva',
    folder: 'slack_the-managers-guide',
    winnerSessionId: 'sess-1779373705838-l34qo2',
    reason: 'holds 1 live task (Wed newsletter extraction)',
  },
  { agentGroupId: 'ag-1779373702798-bazp91', folder: 'slack_docs', reason: 'no live tasks; auto-pick latest' },
  { agentGroupId: 'ag-1779373702796-yetuu0', folder: 'slack_job-search', reason: 'no live tasks; auto-pick latest' },
  { agentGroupId: 'ag-1779373702799-op9123', folder: 'slack_journal', reason: 'no live tasks; auto-pick latest' },
  { agentGroupId: 'ag-1779373702793-d27s2z', folder: 'slack_nanoclaw', reason: 'already single session — no-op' },
  { agentGroupId: 'ag-1779373702800-zlh2qn', folder: 'slack_nederlands', reason: 'no live tasks; auto-pick latest' },
  { agentGroupId: 'ag-1779373702798-vevk6e', folder: 'slack_server-bot', reason: 'no live tasks; auto-pick latest' },
];

const apply = process.argv.includes('--apply');
const db = new Database('data/v2.db');

function pickWinner(plan: AgentPlan): { winner: string; chosenBy: 'explicit' | 'latest' } | null {
  if (plan.winnerSessionId) {
    const exists = db
      .prepare("SELECT 1 FROM sessions WHERE id = ? AND agent_group_id = ? AND status = 'active'")
      .get(plan.winnerSessionId, plan.agentGroupId);
    if (!exists) {
      console.log(`[${plan.folder}] ERROR: declared winner ${plan.winnerSessionId} is not active. Aborting.`);
      return null;
    }
    return { winner: plan.winnerSessionId, chosenBy: 'explicit' };
  }
  const row = db
    .prepare(
      "SELECT id FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    )
    .get(plan.agentGroupId) as { id: string } | undefined;
  if (!row) return null;
  return { winner: row.id, chosenBy: 'latest' };
}

function loserSessions(agentGroupId: string, winner: string): string[] {
  const rows = db
    .prepare("SELECT id FROM sessions WHERE agent_group_id = ? AND status = 'active' AND id != ?")
    .all(agentGroupId, winner) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

let totalToClose = 0;
const work: Array<{ plan: AgentPlan; winner: string; chosenBy: string; losers: string[] }> = [];

for (const plan of PLAN) {
  const picked = pickWinner(plan);
  if (!picked) {
    console.log(`[${plan.folder}] skip — no active sessions`);
    continue;
  }
  const losers = loserSessions(plan.agentGroupId, picked.winner);
  work.push({ plan, winner: picked.winner, chosenBy: picked.chosenBy, losers });
  totalToClose += losers.length;
}

console.log(`\nPlan (${apply ? 'APPLY' : 'DRY-RUN'}):`);
console.log(`Total sessions to close: ${totalToClose}\n`);

for (const item of work) {
  console.log(`${item.plan.folder} (${item.plan.agentGroupId})`);
  console.log(`  reason : ${item.plan.reason}`);
  console.log(`  winner : ${item.winner}  [${item.chosenBy}]`);
  if (item.losers.length === 0) {
    console.log(`  close  : (none)`);
  } else {
    console.log(`  close  : ${item.losers.length} sessions`);
    for (const l of item.losers) console.log(`           - ${l}`);
  }
  console.log();
}

if (!apply) {
  console.log('Dry-run only. Re-run with --apply to commit.');
  process.exit(0);
}

const stmt = db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?");
const tx = db.transaction((ids: string[]) => {
  for (const id of ids) stmt.run(id);
});

let closed = 0;
for (const item of work) {
  tx(item.losers);
  closed += item.losers.length;
}

console.log(`Applied. Closed ${closed} sessions.`);
console.log(`To revert: pnpm exec tsx scripts/q.ts data/v2.db "UPDATE sessions SET status='active' WHERE status='closed'"`);
