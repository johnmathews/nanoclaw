/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Host-responder commands: answered by the host itself, never reaching the
 *   container (fork feature — /status and /usage read host runtime state the
 *   container cannot see). Admin-gated like any admin command.
 * - Normal messages: pass through unchanged
 */
import { hasAdminPrivilege } from './modules/permissions/db/user-roles.js';
import './provider-contracts/index.js';
import { listProviderHostContracts } from './provider-contracts/registry.js';
import { commandText, slashCommandName } from './slash-command.js';
import { formatHealthText } from './health.js';
import { snapshotHealth } from './health-snapshot.js';
import { getUsageText } from './usage.js';

export type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'respond'; command: string; render: () => Promise<string> };

const FILTERED_COMMANDS = new Set(
  listProviderHostContracts().flatMap((contract) => contract.commands?.nativeFiltered ?? []),
);
/**
 * Commands the host answers itself. Both read live host state — runtime health
 * and the subscription's rate-limit utilization — that is not visible from
 * inside a container, so routing them to the agent could only produce a guess.
 * The renderer runs off the hot path in the router; see its respond branch.
 */
const HOST_RESPONDER_COMMANDS: Record<string, (() => Promise<string>) | undefined> = {
  '/usage': () => getUsageText(),
  '/status': async () => formatHealthText(await snapshotHealth()),
};

const ADMIN_COMMANDS = new Set([
  '/clear',
  '/upload-trace',
  ...listProviderHostContracts().flatMap((contract) => contract.commands?.nativeAdmin ?? []),
]);

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export async function gateCommand(content: string, userId: string | null, agentGroupId: string): Promise<GateResult> {
  // The runner names commands with the same parse, so what is gated here is
  // exactly what it executes.
  const command = slashCommandName(commandText(content));
  if (command === null) return { action: 'pass' };

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  // Checked before the admin set so a host-responder command is never also
  // forwarded to the container. Still admin-only: the output names channels,
  // sessions and account utilization.
  // The map's value type is optional so this index yields `| undefined`;
  // without that, a Record index reads as always-defined and the truthiness
  // check below is a compile error (TS2774).
  const render = HOST_RESPONDER_COMMANDS[command];
  if (render) {
    if (await isAdmin(userId, agentGroupId)) return { action: 'respond', command, render };
    return { action: 'deny', command };
  }

  if (ADMIN_COMMANDS.has(command)) {
    if (await isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

async function isAdmin(userId: string | null, agentGroupId: string): Promise<boolean> {
  if (!userId) return false;
  return hasAdminPrivilege(userId, agentGroupId);
}
