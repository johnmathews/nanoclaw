import { describe, it, expect, vi } from 'vitest';
import {
  extractCommand,
  isInterceptedCommand,
  isReadOnlyCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractCommand('@Andy /compact', trigger)).toBe('/compact');
  });

  it('rejects /compact with extra text', () => {
    expect(extractCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('detects backslash commands and normalizes to forward slash', () => {
    expect(extractCommand('\\compact', trigger)).toBe('/compact');
    expect(extractCommand('\\clear', trigger)).toBe('/clear');
    expect(extractCommand('\\usage', trigger)).toBe('/usage');
  });

  it('detects backslash commands with trigger prefix', () => {
    expect(extractCommand('@Andy \\clear', trigger)).toBe('/clear');
    expect(extractCommand('@Andy \\compact', trigger)).toBe('/compact');
    expect(extractCommand('@Andy \\usage', trigger)).toBe('/usage');
  });

  it('detects any single-word command generically', () => {
    expect(extractCommand('/done', trigger)).toBe('/done');
    expect(extractCommand('/help', trigger)).toBe('/help');
    expect(extractCommand('/status', trigger)).toBe('/status');
    expect(extractCommand('\\foo', trigger)).toBe('/foo');
  });

  it('rejects multi-word after slash', () => {
    expect(extractCommand('/done now', trigger)).toBeNull();
  });

  it('rejects messages that only contain a slash or backslash', () => {
    expect(extractCommand('/', trigger)).toBeNull();
    expect(extractCommand('\\', trigger)).toBeNull();
  });
});

describe('isInterceptedCommand', () => {
  it('returns true for /usage', () => {
    expect(isInterceptedCommand('/usage')).toBe(true);
  });

  it('returns false for SDK commands', () => {
    expect(isInterceptedCommand('/compact')).toBe(false);
    expect(isInterceptedCommand('/clear')).toBe(false);
    expect(isInterceptedCommand('/done')).toBe(false);
    expect(isInterceptedCommand('/help')).toBe(false);
  });
});

describe('isReadOnlyCommand', () => {
  it('returns true for read-only commands', () => {
    expect(isReadOnlyCommand('/usage')).toBe(true);
    expect(isReadOnlyCommand('/skills')).toBe(true);
    expect(isReadOnlyCommand('/model')).toBe(true);
    expect(isReadOnlyCommand('/status')).toBe(true);
  });

  it('returns false for session-modifying commands', () => {
    expect(isReadOnlyCommand('/compact')).toBe(false);
    expect(isReadOnlyCommand('/clear')).toBe(false);
    expect(isReadOnlyCommand('/done')).toBe(false);
  });

  // Regression: read-only SDK commands (non-intercepted) must be allowed to
  // proceed in non-main groups even without admin auth. The message loop uses
  // isReadOnlyCommand(cmd) || isSessionCommandAllowed(...) to gate closeStdin.
  // Without the isReadOnlyCommand check, /model and /skills were stuck waiting
  // for the idle timeout because closeStdin was never called.
  it('non-intercepted read-only commands bypass session auth gate', () => {
    const readOnlySdkCommands = ['/model', '/skills', '/status'];
    for (const cmd of readOnlySdkCommands) {
      // These are read-only but NOT intercepted — they go to the SDK
      expect(isReadOnlyCommand(cmd)).toBe(true);
      expect(isInterceptedCommand(cmd)).toBe(false);
      // In non-main group with non-admin sender, session auth fails...
      expect(isSessionCommandAllowed(false, false)).toBe(false);
      // ...but the combined gate (isReadOnlyCommand || isSessionCommandAllowed)
      // must still allow the command through
      expect(
        isReadOnlyCommand(cmd) || isSessionCommandAllowed(false, false),
      ).toBe(true);
    }
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group with trigger required', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
    expect(isSessionCommandAllowed(false, false, true)).toBe(false);
  });

  it('allows any sender in direct conversation group (requiresTrigger=false)', () => {
    expect(isSessionCommandAllowed(false, false, false)).toBe(true);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('forwards /compact to SDK via runAgent', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('forwards /clear to SDK via runAgent', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/clear')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith('/clear', expect.any(Function));
  });

  it('forwards generic commands like /done and /help to SDK', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('\\done')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith('/done', expect.any(Function));
  });

  it('normalizes backslash command to forward slash', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('\\compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('intercepts /usage without spawning container', async () => {
    const deps = makeDeps({
      executeInterceptedCommand: vi
        .fn()
        .mockResolvedValue('*Usage — Today*\nNo usage.'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('\\usage')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.executeInterceptedCommand).toHaveBeenCalledWith('/usage');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Usage'),
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('allows session commands from any sender in direct conversation group (requiresTrigger=false)', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/clear', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: false,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).toHaveBeenCalledWith('/clear', expect.any(Function));
  });

  it('allows read-only intercepted command from any sender in non-main group', async () => {
    const deps = makeDeps({
      executeInterceptedCommand: vi.fn().mockResolvedValue('usage data'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('\\usage', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.executeInterceptedCommand).toHaveBeenCalledWith('/usage');
    expect(deps.sendMessage).not.toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
  });

  it('allows /skills from any sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('\\skills', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith('/skills', expect.any(Function));
    expect(deps.sendMessage).not.toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
  });

  it('allows /model from any sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('\\model', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith('/model', expect.any(Function));
    expect(deps.sendMessage).not.toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-command messages before the command', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-command + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('passes messageTs to setTyping for SDK commands', async () => {
    const deps = makeDeps();
    await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { id: 'slack-ts-123' })],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(deps.setTyping).toHaveBeenCalledWith(true, 'slack-ts-123');
    expect(deps.setTyping).toHaveBeenCalledWith(false);
  });

  it('passes messageTs to setTyping for intercepted commands', async () => {
    const deps = makeDeps({
      executeInterceptedCommand: vi.fn().mockResolvedValue('usage data'),
    });
    await handleSessionCommand({
      missedMessages: [makeMsg('\\usage', { id: 'slack-ts-456' })],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(deps.setTyping).toHaveBeenCalledWith(true, 'slack-ts-456');
    expect(deps.setTyping).toHaveBeenCalledWith(false);
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('advances cursor past command on pre-command failure to prevent retry loops', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      requiresTrigger: true,
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });
});
