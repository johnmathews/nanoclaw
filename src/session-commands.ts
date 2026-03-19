import type { NewMessage } from './types.js';
import { logger } from './logger.js';

/** Commands the SDK supports as session slash commands. Others are not intercepted. */
const SDK_SESSION_COMMANDS = new Set(['/compact', '/clear']);

/** Commands handled on the host side (no container spawn needed). */
const HOST_COMMANDS = new Set(['/usage']);

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact') or null if not a recognized session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  const match = text.match(/^[/\\](\w+)$/);
  if (!match) return null;
  const command = '/' + match[1];
  return SDK_SESSION_COMMANDS.has(command) ? command : null;
}

/**
 * Extract a host command from a message, stripping the trigger prefix if present.
 * Returns the command (e.g., '/usage') or null if not a recognized host command.
 */
export function extractHostCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  const match = text.match(/^[/\\](\w+)$/);
  if (!match) return null;
  const command = '/' + match[1];
  return HOST_COMMANDS.has(command) ? command : null;
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
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  /** Execute a host-side command (e.g., /usage). Returns formatted response text. */
  executeHostCommand?: (command: string) => Promise<string>;
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

  // --- Host command interception (no container needed) ---
  const hostCmdMsg = missedMessages.find(
    (m) => extractHostCommand(m.content, triggerPattern) !== null,
  );
  if (hostCmdMsg && deps.executeHostCommand) {
    const hostCommand = extractHostCommand(hostCmdMsg.content, triggerPattern)!;

    if (!isSessionCommandAllowed(isMainGroup, hostCmdMsg.is_from_me === true)) {
      if (deps.canSenderInteract(hostCmdMsg)) {
        await deps.sendMessage('Session commands require admin access.');
      }
      deps.advanceCursor(hostCmdMsg.timestamp);
      return { handled: true, success: true };
    }

    logger.info({ group: groupName, command: hostCommand }, 'Host command');
    const response = await deps.executeHostCommand(hostCommand);
    await deps.sendMessage(response);
    deps.advanceCursor(hostCmdMsg.timestamp);
    return { handled: true, success: true };
  }
  // --- End host command interception ---

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (!isSessionCommandAllowed(isMainGroup, cmdMsg.is_from_me === true)) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-compact messages first, then run the command
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
  await deps.setTyping(true);

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
