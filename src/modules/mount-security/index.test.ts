import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before any imports so the module under test sees the mock.
// The loader stat()s the allowlist (mtime-keyed cache) and reads it; validate*
// resolves symlinks via realpathSync.
const mockStatSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('fs', () => ({
  default: {
    statSync: (...args: unknown[]) => mockStatSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
  statSync: (...args: unknown[]) => mockStatSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
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

// Mark the allowlist file present (stat succeeds) with a stable mtime so the
// loader proceeds to read it. Tests that want a missing file call missingFile().
function presentAllowlist(json: string, mtimeMs = 1): void {
  mockStatSync.mockReturnValue({ mtimeMs } as unknown as import('fs').Stats);
  mockReadFileSync.mockReturnValue(json);
}

function missingFile(): void {
  mockStatSync.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

let loadMountAllowlist: typeof import('./index.js').loadMountAllowlist;
let validateMount: typeof import('./index.js').validateMount;
let validateAdditionalMounts: typeof import('./index.js').validateAdditionalMounts;
let generateAllowlistTemplate: typeof import('./index.js').generateAllowlistTemplate;

beforeEach(async () => {
  vi.resetModules();
  mockStatSync.mockReset();
  mockReadFileSync.mockReset();
  mockRealpathSync.mockReset();
  mockExistsSync.mockReset();
  mockLog.debug.mockReset();
  mockLog.info.mockReset();
  mockLog.warn.mockReset();
  mockLog.error.mockReset();

  // Defaults: file present with a stable mtime; realpathSync is identity.
  // Tests override per-case.
  mockStatSync.mockReturnValue({ mtimeMs: 1 } as unknown as import('fs').Stats);
  mockRealpathSync.mockImplementation((p: string) => p);

  const mod = await import('./index.js');
  loadMountAllowlist = mod.loadMountAllowlist;
  validateMount = mod.validateMount;
  validateAdditionalMounts = mod.validateAdditionalMounts;
  generateAllowlistTemplate = mod.generateAllowlistTemplate;
});

describe('loadMountAllowlist', () => {
  it('returns null when the allowlist file is missing (and does not cache the miss)', () => {
    missingFile();

    const first = loadMountAllowlist();
    const second = loadMountAllowlist();

    expect(first).toBeNull();
    expect(second).toBeNull();
    // Re-stat'd each call — a file created later is picked up without a restart.
    expect(mockStatSync).toHaveBeenCalledTimes(2);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('returns null on invalid JSON', () => {
    presentAllowlist('not valid json {{{');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when allowedRoots is not an array', () => {
    presentAllowlist(JSON.stringify({ allowedRoots: 'not-array', blockedPatterns: [] }));
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when blockedPatterns is not an array', () => {
    presentAllowlist(JSON.stringify({ allowedRoots: [], blockedPatterns: 'not-array' }));
    expect(loadMountAllowlist()).toBeNull();
  });

  it('successfully loads and merges DEFAULT_BLOCKED_PATTERNS with user patterns', () => {
    presentAllowlist(JSON.stringify(makeAllowlist({ blockedPatterns: ['custom-secret'] })));

    const result = loadMountAllowlist();

    expect(result).not.toBeNull();
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.gnupg');
    expect(result!.blockedPatterns).toContain('id_rsa');
    expect(result!.blockedPatterns).toContain('custom-secret');
    const unique = new Set(result!.blockedPatterns);
    expect(unique.size).toBe(result!.blockedPatterns.length);
  });

  it('serves from cache while the file is unchanged (readFileSync NOT called again)', () => {
    presentAllowlist(JSON.stringify(makeAllowlist()), 1);

    const first = loadMountAllowlist();
    const second = loadMountAllowlist();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    // Same mtime → served from cache; the file is only read once.
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('re-reads when the file mtime changes (a fixed/edited file is picked up)', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(makeAllowlist()));
    mockStatSync.mockReturnValueOnce({ mtimeMs: 1 } as unknown as import('fs').Stats);
    mockStatSync.mockReturnValueOnce({ mtimeMs: 2 } as unknown as import('fs').Stats);

    loadMountAllowlist();
    loadMountAllowlist();

    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it('does not cache parse errors — recovers on the next call without a restart', () => {
    // A broken edit blocks mounts...
    presentAllowlist('not valid json {');
    expect(loadMountAllowlist()).toBeNull();

    // ...but fixing the file recovers on the very next call (parse errors are
    // never cached), even at the same mtime.
    mockReadFileSync.mockReturnValue(JSON.stringify(makeAllowlist()));
    const recovered = loadMountAllowlist();
    expect(recovered).not.toBeNull();
    expect(recovered!.allowedRoots).toHaveLength(1);
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it('translates per-root readOnly:false into a read-write grant', () => {
    presentAllowlist(
      JSON.stringify({ allowedRoots: [{ path: '/allowed/root', readOnly: false }], blockedPatterns: [] }),
    );

    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots[0].allowReadWrite).toBe(true);
  });

  it('keeps per-root readOnly:true as a read-only grant', () => {
    presentAllowlist(
      JSON.stringify({ allowedRoots: [{ path: '/allowed/root', readOnly: true }], blockedPatterns: [] }),
    );

    const result = loadMountAllowlist();
    expect(result!.allowedRoots[0].allowReadWrite).toBe(false);
  });

  it('tolerates the legacy top-level nonMainReadOnly key (warn-and-ignore)', () => {
    presentAllowlist(
      JSON.stringify({
        allowedRoots: [{ path: '/allowed/root', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: true,
      }),
    );

    const result = loadMountAllowlist();

    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
    expect(result!.allowedRoots[0].allowReadWrite).toBe(true);
  });
});

describe('validateMount', () => {
  function setupAllowlist(overrides?: Partial<MountAllowlist>) {
    presentAllowlist(JSON.stringify(makeAllowlist(overrides)));
  }

  it('blocks all mounts when no allowlist exists', () => {
    missingFile();

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

  it('honors a per-root readOnly:false grant end-to-end (mount opts into read-write)', () => {
    presentAllowlist(
      JSON.stringify({ allowedRoots: [{ path: '/allowed/root', readOnly: false }], blockedPatterns: [] }),
    );

    const result = validateMount({ hostPath: '/allowed/root/project', containerPath: 'project', readonly: false });

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
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
    presentAllowlist(JSON.stringify(makeAllowlist(overrides)));
  }

  it('returns empty array when all mounts rejected', () => {
    missingFile();

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
    expect(firstRoot).toHaveProperty('description');
  });
});
