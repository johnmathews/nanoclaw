import type { NewMessage } from './types.js';
import { logger } from './logger.js';

/** Commands intercepted on the host (no container spawn). */
const INTERCEPTED_COMMANDS = new Set(['/usage']);

/** Read-only commands that any authorized sender can use (not just admins). */
const READ_ONLY_COMMANDS = new Set(['/usage', '/skills', '/model', '/status']);

/**
 * Extract a slash command from a message, stripping the trigger prefix if present.
 * Returns the normalized command (e.g., '/compact') or null if not a single-word command.
 * Accepts both /command and \command (backslash normalized to forward slash).
 */
export function extractCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  const match = text.match(/^[/\\](\w+)$/);
  if (!match) return null;
  return '/' + match[1];
}

/**
 * Check if a command is intercepted on the host side (not forwarded to the SDK).
 */
export function isInterceptedCommand(command: string): boolean {
  return INTERCEPTED_COMMANDS.has(command);
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender (is_from_me) in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
): boolean {
  return isMainGroup || isFromMe;
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean, messageTs?: string) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  /** Execute an intercepted command on the host (e.g., /usage). Returns formatted response text. */
  executeInterceptedCommand?: (command: string) => Promise<string>;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  // Find the first slash command in the batch
  const cmdMsg = missedMessages.find(
    (m) => extractCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  // Read-only commands (e.g. /usage, /skills) skip auth — available to anyone.
  // Session-modifying commands (e.g. /compact, /clear) require admin access.
  if (
    !READ_ONLY_COMMANDS.has(command) &&
    !isSessionCommandAllowed(isMainGroup, cmdMsg.is_from_me === true)
  ) {
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // --- Intercepted commands (handled on host, no container needed) ---
  if (isInterceptedCommand(command) && deps.executeInterceptedCommand) {
    logger.info({ group: groupName, command }, 'Intercepted command');
    await deps.setTyping(true, cmdMsg.id);
    const response = await deps.executeInterceptedCommand(command);
    await deps.sendMessage(response);
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.setTyping(false);
    return { handled: true, success: true };
  }

  // --- SDK commands (forwarded to container) ---
  logger.info({ group: groupName, command }, 'Session command');

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in the session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      // Always advance cursor past the pre-command messages to prevent
      // infinite retry loops when the failure is persistent (e.g. container
      // compilation error). The command message is also consumed — asking
      // the user to "try again" means re-send the command.
      deps.advanceCursor(cmdMsg.timestamp);
      return { handled: true, success: true };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true, cmdMsg.id);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
