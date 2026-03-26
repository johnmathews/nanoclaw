import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initWatchdog } from './watchdog.js';

const mockExecFileSync = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('initWatchdog', () => {
  const originalEnv = process.env.NOTIFY_SOCKET;

  beforeEach(() => {
    mockExecFileSync.mockClear();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NOTIFY_SOCKET;
    } else {
      process.env.NOTIFY_SOCKET = originalEnv;
    }
  });

  it('returns null when NOTIFY_SOCKET is not set', () => {
    delete process.env.NOTIFY_SOCKET;
    expect(initWatchdog()).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('sends --ready on init with --pid flag', () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    const wd = initWatchdog();
    expect(wd).not.toBeNull();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync.mock.calls[0][0]).toBe('systemd-notify');
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args).toContain('--ready');
    expect(args[0]).toMatch(/^--pid=\d+$/);
  });

  it('tick sends WATCHDOG=1', () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    const wd = initWatchdog()!;
    mockExecFileSync.mockClear();

    wd.tick();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args).toContain('WATCHDOG=1');
  });

  it('close sends --stopping', () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    const wd = initWatchdog()!;
    mockExecFileSync.mockClear();

    wd.close();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args).toContain('--stopping');
  });
});
