import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before any imports so the module under test sees the mock
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();

vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
  },
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
}));

vi.mock('../../config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/fake/allowlist.json',
}));

const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../../log.js', () => ({
  log: mockLog,
}));

import type { MountAllowlist, AdditionalMount } from './index.js';

function makeAllowlist(overrides?: Partial<MountAllowlist>): MountAllowlist {
  return {
    allowedRoots: [{ path: '/allowed/root', allowReadWrite: true, description: 'test' }],
    blockedPatterns: [],
    ...overrides,
  };
}

let loadMountAllowlist: typeof import('./index.js').loadMountAllowlist;
let validateMount: typeof import('./index.js').validateMount;
let validateAdditionalMounts: typeof import('./index.js').validateAdditionalMounts;
let generateAllowlistTemplate: typeof import('./index.js').generateAllowlistTemplate;

beforeEach(async () => {
  vi.resetModules();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockRealpathSync.mockReset();
  mockLog.debug.mockReset();
  mockLog.info.mockReset();
  mockLog.warn.mockReset();
  mockLog.error.mockReset();

  // Default: realpathSync returns input (identity). Tests override per-case.
  mockRealpathSync.mockImplementation((p: string) => p);

  const mod = await import('./index.js');
  loadMountAllowlist = mod.loadMountAllowlist;
  validateMount = mod.validateMount;
  validateAdditionalMounts = mod.validateAdditionalMounts;
  generateAllowlistTemplate = mod.generateAllowlistTemplate;
});

describe('loadMountAllowlist', () => {
  it('returns null when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadMountAllowlist()).toBeNull();
    expect(mockExistsSync).toHaveBeenCalledWith('/fake/allowlist.json');
  });

  it('returns null on invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when allowedRoots is not an array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ allowedRoots: 'not-array', blockedPatterns: [] }));
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when blockedPatterns is not an array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ allowedRoots: [], blockedPatterns: 'not-array' }));
    expect(loadMountAllowlist()).toBeNull();
  });

  it('successfully loads and merges DEFAULT_BLOCKED_PATTERNS with user patterns', () => {
    const allowlist = makeAllowlist({ blockedPatterns: ['custom-secret'] });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(allowlist));

    const result = loadMountAllowlist();

    expect(result).not.toBeNull();
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.gnupg');
    expect(result!.blockedPatterns).toContain('id_rsa');
    expect(result!.blockedPatterns).toContain('custom-secret');
    const unique = new Set(result!.blockedPatterns);
    expect(unique.size).toBe(result!.blockedPatterns.length);
  });

  it('caches result on second call (readFileSync NOT called again)', () => {
    const allowlist = makeAllowlist();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(allowlist));

    const first = loadMountAllowlist();
    const second = loadMountAllowlist();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not cache file-not-found (file may appear later without restart)', () => {
    mockExistsSync.mockReturnValue(false);

    const first = loadMountAllowlist();
    const second = loadMountAllowlist();

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockExistsSync).toHaveBeenCalledTimes(2);
  });

  it('caches parse errors permanently', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const first = loadMountAllowlist();
    const second = loadMountAllowlist();

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('silently ignores legacy nonMainReadOnly field for forwards-compat with v1 allowlists', () => {
    // v2 dropped the nonMainReadOnly field; v1 allowlists with it set should still load.
    const legacyAllowlist = {
      allowedRoots: [{ path: '/allowed/root', allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(legacyAllowlist));

    const result = loadMountAllowlist();

    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
  });
});

describe('validateMount', () => {
  function setupAllowlist(overrides?: Partial<MountAllowlist>) {
    const allowlist = makeAllowlist(overrides);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(allowlist));
  }

  it('blocks all mounts when no allowlist exists', () => {
    mockExistsSync.mockReturnValue(false);

    const result = validateMount({ hostPath: '/some/path' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist configured');
  });

  it('rejects mount with .. in containerPath', () => {
    setupAllowlist();

    const result = validateMount({ hostPath: '/allowed/root/dir', containerPath: '../escape' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('rejects mount with absolute containerPath (starts with /)', () => {
    setupAllowlist();

    const result = validateMount({ hostPath: '/allowed/root/dir', containerPath: '/absolute/path' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it('rejects mount with empty/whitespace containerPath', () => {
    setupAllowlist();

    const result = validateMount({ hostPath: '/allowed/root/dir', containerPath: '   ' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it('rejects containerPath containing colons (Docker -v option injection guard)', () => {
    setupAllowlist();

    // Without this defence, a containerPath like "repo:rw,z" would be appended as
    // "/workspace/extra/repo:rw,z" and Docker would re-interpret the trailing :rw,z
    // as a mount option, bypassing the validateMount-derived readonly flag.
    const result = validateMount({
      hostPath: '/allowed/root/repo',
      containerPath: 'repo:rw,z',
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it('rejects mount when host path does not exist (realpathSync throws)', () => {
    setupAllowlist();
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === '/allowed/root/nonexistent') {
        throw new Error('ENOENT');
      }
      return p;
    });

    const result = validateMount({ hostPath: '/allowed/root/nonexistent' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Host path does not exist');
  });

  it('rejects mount matching blocked pattern (.ssh)', () => {
    setupAllowlist();

    const result = validateMount({ hostPath: '/allowed/root/.ssh', containerPath: 'ssh-keys' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked pattern');
    expect(result.reason).toContain('.ssh');
  });

  it('rejects mount not under any allowed root', () => {
    setupAllowlist();

    const result = validateMount({ hostPath: '/not-allowed/path', containerPath: 'mydir' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('rejects symlink escape — realpath resolves outside allowed root', () => {
    // hostPath looks like it's under /allowed/root, but the symlink resolves to /etc.
    setupAllowlist();
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === '/allowed/root/escape-link') {
        return '/etc';
      }
      return p;
    });

    const result = validateMount({ hostPath: '/allowed/root/escape-link', containerPath: 'mydir' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('allows valid mount under allowed root, defaults to readonly', () => {
    setupAllowlist();

    const result = validateMount({ hostPath: '/allowed/root/project', containerPath: 'project' });

    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe('/allowed/root/project');
    expect(result.resolvedContainerPath).toBe('project');
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write when allowedRoot.allowReadWrite=true and mount opts in', () => {
    setupAllowlist();

    const result = validateMount({
      hostPath: '/allowed/root/project',
      containerPath: 'project',
      readonly: false,
    });

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces readonly when root disallows read-write even if mount opts in', () => {
    setupAllowlist({
      allowedRoots: [{ path: '/allowed/root', allowReadWrite: false, description: 'ro root' }],
    });

    const result = validateMount({
      hostPath: '/allowed/root/project',
      containerPath: 'project',
      readonly: false,
    });

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('derives containerPath from hostPath basename when not specified', () => {
    setupAllowlist();

    const result = validateMount({ hostPath: '/allowed/root/my-project' });

    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('my-project');
  });
});

describe('validateAdditionalMounts', () => {
  function setupAllowlist(overrides?: Partial<MountAllowlist>) {
    const allowlist = makeAllowlist(overrides);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(allowlist));
  }

  it('returns empty array when all mounts rejected', () => {
    mockExistsSync.mockReturnValue(false);

    const mounts: AdditionalMount[] = [{ hostPath: '/some/path' }, { hostPath: '/other/path' }];

    const result = validateAdditionalMounts(mounts, 'test-group');

    expect(result).toEqual([]);
  });

  it('filters out rejected mounts, keeps valid ones', () => {
    setupAllowlist();

    const mounts: AdditionalMount[] = [
      { hostPath: '/allowed/root/valid', containerPath: 'valid' },
      { hostPath: '/not-allowed/invalid', containerPath: 'invalid' },
      { hostPath: '/allowed/root/also-valid', containerPath: 'also-valid' },
    ];

    const result = validateAdditionalMounts(mounts, 'test-group');

    expect(result).toHaveLength(2);
    expect(result[0].hostPath).toBe('/allowed/root/valid');
    expect(result[1].hostPath).toBe('/allowed/root/also-valid');
  });

  it('prefixes containerPath with /workspace/extra/', () => {
    setupAllowlist();

    const mounts: AdditionalMount[] = [{ hostPath: '/allowed/root/project', containerPath: 'project' }];

    const result = validateAdditionalMounts(mounts, 'test-group');

    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/project');
  });

  it('logs warnings for rejected mounts', () => {
    setupAllowlist();

    const mounts: AdditionalMount[] = [{ hostPath: '/not-allowed/path', containerPath: 'nope' }];

    validateAdditionalMounts(mounts, 'test-group');

    expect(mockLog.warn).toHaveBeenCalled();
  });
});

describe('generateAllowlistTemplate', () => {
  it('returns valid JSON', () => {
    const template = generateAllowlistTemplate();
    expect(() => JSON.parse(template)).not.toThrow();
  });

  it('contains expected structure (allowedRoots, blockedPatterns)', () => {
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template);

    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(parsed.allowedRoots.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);

    const firstRoot = parsed.allowedRoots[0];
    expect(firstRoot).toHaveProperty('path');
    expect(firstRoot).toHaveProperty('allowReadWrite');
    expect(firstRoot).toHaveProperty('description');
  });
});
