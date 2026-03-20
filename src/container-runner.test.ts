import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      unlinkSync: vi.fn(),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock group-config (default: no overrides)
vi.mock('./group-config.js', () => ({
  readGroupConfig: vi.fn(() => ({})),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import fs from 'fs';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner attachment handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not clean up attachments (loadImageData handles that)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return String(p).includes('attachments');
    });
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      if (String(p).includes('attachments')) {
        return ['img-1.jpg', 'img-2.jpg'] as any;
      }
      return [] as any;
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    // Container runner should NOT delete attachment files
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('passes base64 image data in container input JSON', async () => {
    const inputWithImage = {
      ...testInput,
      imageAttachments: [{ mediaType: 'image/jpeg', data: 'aGVsbG8=' }],
    };

    const resultPromise = runContainerAgent(
      testGroup,
      inputWithImage,
      () => {},
    );

    // Capture what was written to stdin
    const chunks: Buffer[] = [];
    fakeProc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    const stdinContent = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(stdinContent);
    expect(parsed.imageAttachments).toEqual([
      { mediaType: 'image/jpeg', data: 'aGVsbG8=' },
    ]);
  });
});

describe('container-runner multiple streaming outputs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onOutput for each OUTPUT_MARKER pair', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First response',
      newSessionId: 'session-1',
    });
    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second response',
      newSessionId: 'session-2',
    });
    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Third response',
      newSessionId: 'session-3',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(onOutput).toHaveBeenCalledTimes(3);
    expect(onOutput).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ result: 'First response' }),
    );
    expect(onOutput).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ result: 'Second response' }),
    );
    expect(onOutput).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ result: 'Third response' }),
    );
    expect(result.newSessionId).toBe('session-3');
  });

  it('tracks newSessionId from the latest output marker', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First',
      newSessionId: 'session-A',
    });
    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second',
      newSessionId: 'session-B',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.newSessionId).toBe('session-B');
  });
});

describe('container-runner progress marker parsing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onProgress with parsed text from progress markers', async () => {
    const onOutput = vi.fn(async () => {});
    const onProgress = vi.fn();
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onProgress,
    );

    fakeProc.stdout.push(
      `---NANOCLAW_PROGRESS_START---\n{"text":"Reading files"}\n---NANOCLAW_PROGRESS_END---\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    expect(onProgress).toHaveBeenCalledWith('Reading files');
  });

  it('parses multiple progress markers', async () => {
    const onOutput = vi.fn(async () => {});
    const onProgress = vi.fn();
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onProgress,
    );

    fakeProc.stdout.push(
      `---NANOCLAW_PROGRESS_START---\n{"text":"Reading files"}\n---NANOCLAW_PROGRESS_END---\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.stdout.push(
      `---NANOCLAW_PROGRESS_START---\n{"text":"Writing code"}\n---NANOCLAW_PROGRESS_END---\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 'Reading files');
    expect(onProgress).toHaveBeenNthCalledWith(2, 'Writing code');
  });

  it('handles interleaved progress and output markers', async () => {
    const onOutput = vi.fn(async () => {});
    const onProgress = vi.fn();
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onProgress,
    );

    // Progress before first output
    fakeProc.stdout.push(
      `---NANOCLAW_PROGRESS_START---\n{"text":"Analyzing"}\n---NANOCLAW_PROGRESS_END---\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    // First output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First part',
      newSessionId: 'sess-1',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Progress between outputs
    fakeProc.stdout.push(
      `---NANOCLAW_PROGRESS_START---\n{"text":"Generating"}\n---NANOCLAW_PROGRESS_END---\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    // Second output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second part',
      newSessionId: 'sess-2',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Progress after last output
    fakeProc.stdout.push(
      `---NANOCLAW_PROGRESS_START---\n{"text":"Cleaning up"}\n---NANOCLAW_PROGRESS_END---\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 'Analyzing');
    expect(onProgress).toHaveBeenNthCalledWith(2, 'Generating');
    expect(onProgress).toHaveBeenNthCalledWith(3, 'Cleaning up');
    expect(onOutput).toHaveBeenCalledTimes(2);
  });
});

describe('container-runner error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns error status on non-zero exit code', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    fakeProc.stderr.push('Something went wrong\n');
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Container exited with code 1');
    expect(result.error).toContain('Something went wrong');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('returns error status on spawn error event', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    fakeProc.emit('error', new Error('spawn ENOENT'));
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Container spawn error');
    expect(result.error).toContain('spawn ENOENT');
  });

  it('handles malformed output JSON without crashing', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Push malformed JSON between output markers
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n{not valid json\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    // Then push a valid output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Valid response',
      newSessionId: 'sess-ok',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // The malformed one should be skipped, valid one processed
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Valid response' }),
    );
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('sess-ok');
  });
});

describe('container-runner session ID tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the latest newSessionId from multiple outputs', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First',
      newSessionId: 'early-session',
    });
    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Middle',
      newSessionId: 'middle-session',
    });
    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Last',
      newSessionId: 'final-session',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.newSessionId).toBe('final-session');
  });

  it('retains session ID when later output omits it', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'With session',
      newSessionId: 'the-session',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Second output without newSessionId
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'No session field',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // newSessionId is only updated when present, so first one persists
    expect(result.newSessionId).toBe('the-session');
  });
});

describe('container-runner stdin JSON writing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes JSON.stringify(input) to stdin and ends it', async () => {
    const chunks: Buffer[] = [];
    fakeProc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

    let stdinEnded = false;
    fakeProc.stdin.on('end', () => {
      stdinEnded = true;
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    // Verify stdin received the JSON input
    const stdinContent = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(stdinContent);
    expect(parsed.prompt).toBe('Hello');
    expect(parsed.groupFolder).toBe('test-group');
    expect(parsed.chatJid).toBe('test@g.us');
    expect(parsed.isMain).toBe(false);
    expect(stdinEnded).toBe(true);

    // Clean up
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

describe('container-runner timeout reset on activity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets timeout when output arrives, preventing premature timeout', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Advance to just before original timeout (1830000ms)
    await vi.advanceTimersByTimeAsync(1800000);

    // Emit output — this should reset the timeout
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Late response',
      newSessionId: 'session-late',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Advance past original timeout but not past the reset timeout
    // Original would have fired at 1830000, we're now at ~1800010
    // Reset timeout is another 1830000 from the reset point
    await vi.advanceTimersByTimeAsync(100000);

    // Close normally — should resolve as success, not timeout
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-late');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Late response' }),
    );
  });
});

describe('container-runner large output truncation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('truncates stdout exceeding CONTAINER_MAX_OUTPUT_SIZE but parses earlier markers', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit a valid output marker first
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Before truncation',
      newSessionId: 'sess-before',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Now flood stdout with data exceeding CONTAINER_MAX_OUTPUT_SIZE (10MB)
    const chunkSize = 1024 * 1024; // 1MB chunks
    const largeChunk = 'X'.repeat(chunkSize);
    for (let i = 0; i < 11; i++) {
      fakeProc.stdout.push(largeChunk);
    }
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // The first output marker was parsed before truncation
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Before truncation' }),
    );
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('sess-before');
  });
});
