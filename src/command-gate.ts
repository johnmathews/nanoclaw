/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Host-responder commands: handled inline by a host-side renderer
 *   (e.g. /usage queries the Anthropic OAuth usage endpoint and writes the
 *   rendered text directly to messages_out — never reaches the container).
 *   Gated by the same admin check as ADMIN_COMMANDS.
 * - Normal messages: pass through unchanged
 */
import { getDb, hasTable } from './db/connection.js';
import { getUsageText } from './usage.js';
import { formatHealthText } from './health.js';
import { snapshotHealth } from './health-snapshot.js';

export type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'respond'; command: string; render: () => Promise<string> };

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/**
 * Map of slash commands handled inline by the host (no container spawn).
 * Each entry's renderer returns the Slack/markdown text to write to
 * messages_out. Gated by the same admin check as ADMIN_COMMANDS.
 */
const HOST_RESPONDER_COMMANDS: Record<string, () => Promise<string>> = {
  '/usage': () => getUsageText(),
  '/status': async () => formatHealthText(snapshotHealth()),
};

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands, 'respond' for host-handled commands whose output is
 * written directly to messages_out.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  const responder = HOST_RESPONDER_COMMANDS[command];
  if (responder) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'respond', command, render: responder };
    }
    return { action: 'deny', command };
  }

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}
