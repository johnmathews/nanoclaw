import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  HEALTH_PORT,
  IDLE_TIMEOUT,
  MAX_CONCURRENT_CONTAINERS,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeReactionsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessageContent,
  getMessageFromMe,
  getMessagesSince,
  getNewMessages,
  getThreadMessages,
  getReactionsForChat,
  getReactionsForMessages,
  getRecentTaskFailureCount,
  getRouterState,
  initDatabase,
  Reaction,
  setRegisteredGroup,
  upsertRateLimit,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeReaction,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { groupMessagesByJid } from './message-loop.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractCommand,
  isInterceptedCommand,
  isReadOnlyCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { collectHealth } from './health.js';
import { startHealthServer } from './health-server.js';
import { executeHostCommand, registerHealthProvider } from './host-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Channel,
  InboundReaction,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import {
  parseImageReferences,
  loadImageData,
  type LoadedImage,
} from './image.js';
import { StatusTracker } from './status-tracker.js';
import { initWatchdog } from './watchdog.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Tracks cursor value before messages were piped to an active container.
// Used to roll back if the container dies after piping.
let cursorBeforePipe: Record<string, string> = {};
let messageLoopRunning = false;
let stopping = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
let statusTracker: StatusTracker;
let watchdog: ReturnType<typeof initWatchdog> = null;

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  const pipeCursor = getRouterState('cursor_before_pipe');
  try {
    cursorBeforePipe = pipeCursor ? JSON.parse(pipeCursor) : {};
  } catch {
    logger.warn('Corrupted cursor_before_pipe in DB, resetting');
    cursorBeforePipe = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  setRouterState('cursor_before_pipe', JSON.stringify(cursorBeforePipe));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/**
 * Build a reaction map for a set of messages (keyed by message ID).
 * Returns undefined if there are no reactions, to avoid unnecessary XML.
 */
function buildReactionMap(
  messages: NewMessage[],
  chatJid: string,
): Map<string, Reaction[]> | undefined {
  if (messages.length === 0) return undefined;
  const ids = messages.map((m) => m.id);
  const reactions = getReactionsForMessages(ids, chatJid);
  if (reactions.length === 0) return undefined;
  const map = new Map<string, Reaction[]>();
  for (const r of reactions) {
    const list = map.get(r.message_id);
    if (list) {
      list.push(r);
    } else {
      map.set(r.message_id, [r]);
    }
  }
  return map;
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    requiresTrigger: group.requiresTrigger !== false,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing, messageTs) =>
        channel.setTyping?.(chatJid, typing, messageTs) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, [], onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
      executeInterceptedCommand: (command) => executeHostCommand(command),
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  // Ensure all user messages are tracked — recovery messages enter processGroupMessages
  // directly via the queue, bypassing startMessageLoop where markReceived normally fires.
  // markReceived is idempotent (rejects duplicates), so this is safe for normal-path messages too.
  for (const msg of missedMessages) {
    statusTracker.markReceived(msg.id, chatJid, false);
  }

  // Mark all user messages as thinking (container is spawning)
  const userMessages = missedMessages.filter(
    (m) => !m.is_from_me && !m.is_bot_message,
  );
  for (const msg of userMessages) {
    statusTracker.markThinking(msg.id);
  }

  // --- Thread-aware context ---
  // Detect if the triggering messages are from a Slack thread.
  // If so, fetch the full thread history so the agent has complete context,
  // and track the threadTs so output goes back to the same thread.
  const threadedMessages = missedMessages.filter((m) => m.thread_ts);
  // Use the thread_ts from the most recent threaded message (all should share
  // the same thread_ts if they're from the same thread).
  const activeThreadTs = threadedMessages.length > 0
    ? threadedMessages[threadedMessages.length - 1].thread_ts
    : undefined;

  let promptMessages = missedMessages;
  if (activeThreadTs) {
    // Fetch full thread history from DB for context
    const threadHistory = getThreadMessages(
      chatJid,
      activeThreadTs,
      ASSISTANT_NAME,
    );
    if (threadHistory.length > 0) {
      // Merge: use thread history as context, but ensure the new pending
      // messages are included (they may not be in the thread query yet if
      // they just arrived). Deduplicate by message ID.
      const seen = new Set(threadHistory.map((m) => m.id));
      const additional = missedMessages.filter((m) => !seen.has(m.id));
      promptMessages = [...threadHistory, ...additional];
    }
    logger.info(
      {
        group: group.name,
        threadTs: activeThreadTs,
        threadMessages: promptMessages.length,
        newMessages: missedMessages.length,
      },
      'Thread-aware context: providing full thread history',
    );
  }

  const reactionMap = buildReactionMap(promptMessages, chatJid);
  const prompt = formatMessages(promptMessages, TIMEZONE, reactionMap);

  // Load images into memory NOW, before any cleanup or container spawn.
  // This eliminates the file-based handoff — data goes directly via stdin.
  const imageRefs = parseImageReferences(missedMessages);
  const groupDir = resolveGroupFolderPath(group.folder);
  const imageAttachments = loadImageData(imageRefs, groupDir);
  if (imageRefs.length > 0 && imageAttachments.length < imageRefs.length) {
    logger.warn(
      {
        group: group.name,
        expected: imageRefs.length,
        loaded: imageAttachments.length,
      },
      'Some image attachments could not be loaded from disk',
    );
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Pass the last message's ID so Slack can react to it (instead of posting a message)
  const lastMessageId = missedMessages[missedMessages.length - 1]?.id;
  await channel.setTyping?.(chatJid, true, lastMessageId);
  let hadError = false;
  let outputSentToUser = false;
  let firstOutputSeen = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    imageAttachments,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        if (!firstOutputSeen) {
          firstOutputSeen = true;
          for (const um of userMessages) {
            statusTracker.markWorking(um.id);
          }
        }
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text, activeThreadTs);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        statusTracker.markAllDone(chatJid);
        // Remove typing indicator after each response so it doesn't linger.
        // It will be re-added by the message loop when the next message is piped.
        channel.setTyping?.(chatJid, false)?.catch(() => {});
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    (text) => {
      channel.updateWorkingIndicator?.(chatJid, text);
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      // Output was sent for the initial batch, so don't roll those back.
      // But if messages were piped AFTER that output, roll back to recover them.
      if (cursorBeforePipe[chatJid]) {
        lastAgentTimestamp[chatJid] = cursorBeforePipe[chatJid];
        delete cursorBeforePipe[chatJid];
        saveState();
        logger.warn(
          { group: group.name },
          'Agent error after output, rolled back piped messages for retry',
        );
        statusTracker.markAllFailed(chatJid, 'Task crashed — retrying.');
        return false;
      }
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, no piped messages to recover',
      );
      statusTracker.markAllDone(chatJid);
      return true;
    }
    // No output sent — roll back everything so the full batch is retried
    lastAgentTimestamp[chatJid] = previousCursor;
    delete cursorBeforePipe[chatJid];
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    statusTracker.markAllFailed(chatJid, 'Task crashed — retrying.');
    return false;
  }

  // Success — clear pipe tracking (markAllDone already fired in streaming callback)
  delete cursorBeforePipe[chatJid];
  saveState();
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments: LoadedImage[],
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onProgress?: (text: string) => void,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  let sessionId: string | undefined = sessions[group.folder];

  // Safety net: if the session file is dangerously large, clear it to prevent
  // prompt-too-long deadlocks. The SDK auto-compacts between turns, but a flood
  // of messages (e.g. a reaction loop) can overwhelm it.
  if (sessionId) {
    const sessionFile = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
      'projects',
      '-workspace-group',
      `${sessionId}.jsonl`,
    );
    try {
      const stat = fs.statSync(sessionFile);
      const sizeMB = stat.size / (1024 * 1024);
      if (sizeMB > 10) {
        logger.warn(
          { group: group.name, sessionId, sizeMB: sizeMB.toFixed(1) },
          'Session file too large, clearing to prevent prompt-too-long deadlock',
        );
        fs.unlinkSync(sessionFile);
        // Also remove subagents directory if it exists
        const subagentsDir = path.join(path.dirname(sessionFile), sessionId);
        fs.rmSync(subagentsDir, { recursive: true, force: true });
        delete sessions[group.folder];
        deleteSession(group.folder);
        sessionId = undefined;
      }
    } catch {
      // File doesn't exist or can't be read — fine, session will start fresh
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update reactions snapshot for container to read
  writeReactionsSnapshot(group.folder, chatJid, getReactionsForChat(chatJid));

  // Wrap onOutput to track session ID and persist rate limits from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        } else if (output.newSessionId === '') {
          delete sessions[group.folder];
          deleteSession(group.folder);
        }
        if (output.rateLimits) {
          for (const snapshot of output.rateLimits) {
            upsertRateLimit(snapshot);
          }
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        ...(imageAttachments.length > 0 && { imageAttachments }),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      onProgress,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    } else if (output.newSessionId === '') {
      delete sessions[group.folder];
      deleteSession(group.folder);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      // Clear stale session so next invocation starts fresh
      if (
        output.error &&
        /session|conversation not found|resume/i.test(output.error)
      ) {
        delete sessions[group.folder];
        deleteSession(group.folder);
        logger.info(
          { group: group.name },
          'Cleared stale session after resume error',
        );
      }
      // Notify user about API errors via the streaming callback
      if (output.error && onOutput) {
        const errLower = output.error.toLowerCase();
        let userMsg: string | null = null;
        if (errLower.includes('529') || errLower.includes('overloaded')) {
          userMsg =
            'The AI service (Anthropic) is currently overloaded (HTTP 529). Your message will be retried automatically.';
        } else if (
          errLower.includes('rate_limit') ||
          errLower.includes('api_error') ||
          errLower.includes('server_error') ||
          errLower.includes('service_unavailable') ||
          errLower.includes('openai') ||
          errLower.includes('anthropic')
        ) {
          userMsg =
            'API error encountered. Your message will be retried automatically.';
        }
        if (userMsg) {
          logger.warn(
            { group: group.name, errorDetail: output.error },
            'Notifying user of API error',
          );
          await onOutput({
            status: 'error',
            result: userMsg,
            error: output.error,
          });
        }
      }
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (!stopping) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Deduplicate by group
        const messagesByGroup = groupMessagesByJid(messages);

        // Track the max timestamp of messages we actually dispatch.
        // Only advance the global cursor past dispatched messages — messages
        // for disconnected channels stay in the DB for the next poll cycle.
        let maxDispatchedTimestamp = '';

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // Channel found — this group's messages will be dispatched.
          // Track the max timestamp for deferred cursor advance.
          const groupMaxTs =
            groupMessages[groupMessages.length - 1]?.timestamp || '';
          if (groupMaxTs > maxDispatchedTimestamp) {
            maxDispatchedTimestamp = groupMaxTs;
          }

          const isMainGroup = group.isMain === true;

          // --- Slash command interception (message loop) ---
          // Must run BEFORE the pipe path — otherwise the next poll cycle
          // will include the command in allPending and pipe it to the container.
          const loopCmdMsg = groupMessages.find(
            (m) => extractCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            const cmd = extractCommand(loopCmdMsg.content, TRIGGER_PATTERN)!;

            if (isInterceptedCommand(cmd)) {
              // Intercepted commands execute inline (no container needed).
              // Read-only commands (e.g. /usage) skip auth — available to anyone.
              if (
                isReadOnlyCommand(cmd) ||
                isSessionCommandAllowed(
                  isMainGroup,
                  loopCmdMsg.is_from_me === true,
                )
              ) {
                logger.info(
                  { group: group.name, command: cmd },
                  'Intercepted command (inline)',
                );
                executeHostCommand(cmd)
                  .then((response) => channel.sendMessage(chatJid, response))
                  .catch((err) =>
                    logger.error({ chatJid, err }, 'Intercepted command error'),
                  );
              }
              // Advance cursor past the command so it won't be included
              // in allPending on the next poll cycle.
              lastAgentTimestamp[chatJid] = loopCmdMsg.timestamp;
              saveState();
              continue;
            }

            // SDK commands: close active container and enqueue for processing.
            // Only close if authorized — otherwise untrusted user could DoS.
            // Read-only commands (e.g. /model, /skills) also allowed — they skip
            // auth in handleSessionCommand and shouldn't be blocked here.
            if (
              isReadOnlyCommand(cmd) ||
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
                group.requiresTrigger !== false,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Mark each user message as received (status emoji)
          for (const msg of groupMessages) {
            if (!msg.is_from_me && !msg.is_bot_message) {
              statusTracker.markReceived(msg.id, chatJid, false);
            }
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          let messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Thread-aware context for piped messages: if the new messages are
          // from a thread, include the full thread history for context.
          const pipeThreaded = messagesToSend.filter((m) => m.thread_ts);
          const pipeThreadTs = pipeThreaded.length > 0
            ? pipeThreaded[pipeThreaded.length - 1].thread_ts
            : undefined;
          if (pipeThreadTs) {
            const threadHist = getThreadMessages(
              chatJid,
              pipeThreadTs,
              ASSISTANT_NAME,
            );
            if (threadHist.length > 0) {
              const seen = new Set(threadHist.map((m) => m.id));
              const extra = messagesToSend.filter((m) => !seen.has(m.id));
              messagesToSend = [...threadHist, ...extra];
            }
          }

          const pipeReactionMap = buildReactionMap(messagesToSend, chatJid);
          const formatted = formatMessages(
            messagesToSend,
            TIMEZONE,
            pipeReactionMap,
          );

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Mark new user messages as thinking (only groupMessages were markReceived'd;
            // accumulated allPending context messages are untracked and would no-op)
            for (const msg of groupMessages) {
              if (!msg.is_from_me && !msg.is_bot_message) {
                statusTracker.markThinking(msg.id);
              }
            }
            // Save cursor before first pipe so we can roll back if container dies
            if (!cursorBeforePipe[chatJid]) {
              cursorBeforePipe[chatJid] = lastAgentTimestamp[chatJid] || '';
            }
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            const lastMsgId = messagesToSend[messagesToSend.length - 1]?.id;
            channel
              .setTyping?.(chatJid, true, lastMsgId)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }

        // Advance the global "seen" cursor only past messages we dispatched.
        // Messages for disconnected channels stay behind the cursor for retry.
        if (maxDispatchedTimestamp > lastTimestamp) {
          lastTimestamp = maxDispatchedTimestamp;
          saveState();
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    watchdog?.tick();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
  logger.info('Message loop stopped cleanly');
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  // Roll back any piped-message cursors that were persisted before a crash.
  // This ensures messages piped to a now-dead container are re-fetched.
  // IMPORTANT: Only roll back if the container is no longer running — rolling
  // back while the container is alive causes duplicate processing.
  let rolledBack = false;
  for (const [chatJid, savedCursor] of Object.entries(cursorBeforePipe)) {
    if (queue.isActive(chatJid)) {
      logger.debug(
        { chatJid },
        'Recovery: skipping piped-cursor rollback, container still active',
      );
      continue;
    }
    logger.info(
      { chatJid, rolledBackTo: savedCursor },
      'Recovery: rolling back piped-message cursor',
    );
    lastAgentTimestamp[chatJid] = savedCursor;
    delete cursorBeforePipe[chatJid];
    rolledBack = true;
  }
  if (rolledBack) {
    saveState();
  }

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  let healthServer: ReturnType<typeof startHealthServer> | null = null;
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopping = true;
    watchdog?.close();
    healthServer?.close();
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    await statusTracker.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onReaction: (chatJid: string, reaction: InboundReaction) => {
      // Always store the reaction (additions and removals)
      storeReaction({
        message_id: reaction.message_id,
        message_chat_jid: chatJid,
        reactor_jid: reaction.reactor_jid,
        reactor_name: reaction.reactor_name,
        emoji: reaction.emoji,
        timestamp: reaction.timestamp,
      });

      // Don't trigger on reaction removals or bot's own reactions
      if (!reaction.emoji || reaction.is_from_me) return;

      // Only trigger in groups that don't require a trigger pattern
      const group = registeredGroups[chatJid];
      if (!group) return;
      const isMainGroup = group.isMain === true;
      const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
      if (needsTrigger) return;

      // Look up the reacted-to message for context
      const originalContent = getMessageContent(reaction.message_id, chatJid);
      const preview = originalContent
        ? `"${originalContent.slice(0, 50)}${originalContent.length > 50 ? '...' : ''}"`
        : 'a message';

      // Synthesize a message so the agent sees the reaction
      storeMessage({
        id: `reaction:${reaction.message_id}:${reaction.reactor_jid}:${reaction.timestamp}`,
        chat_jid: chatJid,
        sender: reaction.reactor_jid,
        sender_name: reaction.reactor_name,
        content: `[Reacted ${reaction.emoji} to ${preview}]`,
        timestamp: reaction.timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Initialize status tracker (uses channels via callbacks, channels don't need to be connected yet)
  statusTracker = new StatusTracker({
    sendReaction: async (chatJid, messageKey, emoji) => {
      const channel = findChannel(channels, chatJid);
      if (!channel?.sendReaction) return;
      await channel.sendReaction(chatJid, messageKey, emoji);
    },
    sendMessage: async (chatJid, text) => {
      const channel = findChannel(channels, chatJid);
      if (!channel) return;
      await channel.sendMessage(chatJid, text);
    },
    isMainGroup: (chatJid) => {
      const group = registeredGroups[chatJid];
      return group?.isMain === true;
    },
    isContainerAlive: (chatJid) => queue.isActive(chatJid),
    hasNativeTyping: (chatJid) => {
      const channel = findChannel(channels, chatJid);
      return channel?.hasNativeTyping === true;
    },
  });

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, threadTs) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, threadTs);
    },
    sendBlocks: (jid, blocks, fallbackText, threadTs) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      // Duck-type: if the channel supports sendBlocks, use it; otherwise fall back to text
      if (
        'sendBlocks' in channel &&
        typeof (channel as { sendBlocks: Function }).sendBlocks === 'function'
      ) {
        return (
          channel as {
            sendBlocks: (
              jid: string,
              blocks: unknown[],
              fallbackText: string,
              threadTs?: string,
            ) => Promise<void>;
          }
        ).sendBlocks(jid, blocks, fallbackText, threadTs);
      }
      return channel.sendMessage(jid, fallbackText, threadTs);
    },
    sendReaction: async (jid, emoji, messageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (messageId) {
        if (!channel.sendReaction)
          throw new Error('Channel does not support sendReaction');
        const messageKey = {
          id: messageId,
          remoteJid: jid,
          fromMe: getMessageFromMe(messageId, jid),
        };
        await channel.sendReaction(jid, messageKey, emoji);
      } else {
        if (!channel.reactToLatestMessage)
          throw new Error('Channel does not support reactions');
        await channel.reactToLatestMessage(jid, emoji);
      }
    },
    setTyping: async (jid, isTyping) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      await channel.setTyping?.(jid, isTyping);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    statusHeartbeat: () => statusTracker.heartbeatCheck(),
    recoverPendingMessages,
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  // Recover status tracker AFTER channels connect, so recovery reactions
  // can actually be sent via the WhatsApp channel.
  await statusTracker.recover();
  // Health data — shared by /status command and HTTP health endpoint
  function getHealth() {
    const tasks = getAllTasks();
    return collectHealth({
      channels,
      messageLoopRunning,
      queueActiveCount: queue.getActiveCount(),
      queueWaitingCount: queue.getWaitingCount(),
      maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
      registeredGroupCount: Object.keys(registeredGroups).length,
      activeSessionCount: Object.keys(sessions).length,
      lastMessageTimestamp: lastTimestamp,
      activeTasks: tasks.filter((t) => t.status === 'active').length,
      pausedTasks: tasks.filter((t) => t.status === 'paused').length,
      nextTaskRunTime:
        tasks
          .filter((t) => t.status === 'active' && t.next_run)
          .sort((a, b) => (a.next_run! < b.next_run! ? -1 : 1))[0]?.next_run ??
        null,
      recentTaskFailures: getRecentTaskFailureCount(
        new Date(Date.now() - 86_400_000).toISOString(),
      ),
    });
  }
  registerHealthProvider(getHealth);
  healthServer = startHealthServer(HEALTH_PORT, getHealth);
  watchdog = initWatchdog();

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
