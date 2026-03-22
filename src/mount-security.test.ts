import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before any imports
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

vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/fake/allowlist.json',
}));

vi.mock('pino', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { default: () => mockLogger };
});

import type { MountAllowlist, AdditionalMount } from './types.js';

// Helper to create a valid allowlist
function makeAllowlist(overrides?: Partial<MountAllowlist>): MountAllowlist {
  return {
    allowedRoots: [
      { path: '/allowed/root', allowReadWrite: true, description: 'test' },
    ],
    blockedPatterns: [],
    nonMainReadOnly: true,
    ...overrides,
  };
}

// Fresh module import types
let loadMountAllowlist: typeof import('./mount-security.js').loadMountAllowlist;
let validateMount: typeof import('./mount-security.js').validateMount;
let validateAdditionalMounts: typeof import('./mount-security.js').validateAdditionalMounts;
let generateAllowlistTemplate: typeof import('./mount-security.js').generateAllowlistTemplate;

beforeEach(async () => {
  vi.resetModules();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockRealpathSync.mockReset();

  // Default: realpathSync returns input (identity)
  mockRealpathSync.mockImplementation((p: string) => p);

  const mod = await import('./mount-security.js');
  loadMountAllowlist = mod.loadMountAllowlist;
  validateMount = mod.validateMount;
  validateAdditionalMounts = mod.validateAdditionalMounts;
  generateAllowlistTemplate = mod.generateAllowlistTemplate;
});

describe('loadMountAllowlist', () => {
  it('returns null when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = loadMountAllowlist();

    expect(result).toBeNull();
    expect(mockExistsSync).toHaveBeenCalledWith('/fake/allowlist.json');
  });

  it('returns null on invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const result = loadMountAllowlist();

    expect(result).toBeNull();
  });

  it('returns null when allowedRoots is not an array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: 'not-array',
        blockedPatterns: [],
        nonMainReadOnly: true,
      }),
    );

    const result = loadMountAllowlist();

    expect(result).toBeNull();
  });

  it('returns null when blockedPatterns is not an array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: 'not-array',
        nonMainReadOnly: true,
      }),
    );

    const result = loadMountAllowlist();

    expect(result).toBeNull();
  });

  it('returns null when nonMainReadOnly is not boolean', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: 'yes',
      }),
    );

    const result = loadMountAllowlist();

    expect(result).toBeNull();
  });

  it('successfully loads and merges DEFAULT_BLOCKED_PATTERNS with user patterns', () => {
    const allowlist = makeAllowlist({ blockedPatterns: ['custom-secret'] });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(allowlist));

    const result = loadMountAllowlist();

    expect(result).not.toBeNull();
    // Should include default patterns
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.gnupg');
    expect(result!.blockedPatterns).toContain('id_rsa');
    // Should include user pattern
    expect(result!.blockedPatterns).toContain('custom-secret');
    // No duplicates
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

  it('caches error on second call after load failure', () => {
    mockExistsSync.mockReturnValue(false);

    const first = loadMountAllowlist();
    const second = loadMountAllowlist();

    expect(first).toBeNull();
    expect(second).toBeNull();
    // existsSync only called on first attempt
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
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

    const result = validateMount({ hostPath: '/some/path' }, true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist configured');
  });

  it('rejects mount with .. in containerPath', () => {
    setupAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/root/dir', containerPath: '../escape' },
      true,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('rejects mount with absolute containerPath (starts with /)', () => {
    setupAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/root/dir', containerPath: '/absolute/path' },
      true,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it('rejects mount with empty containerPath', () => {
    setupAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/root/dir', containerPath: '   ' },
      true,
    );

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

    const result = validateMount(
      { hostPath: '/allowed/root/nonexistent' },
      true,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Host path does not exist');
  });

  it('rejects mount matching blocked pattern (.ssh)', () => {
    setupAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/root/.ssh', containerPath: 'ssh-keys' },
      true,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked pattern');
    expect(result.reason).toContain('.ssh');
  });

  it('rejects mount not under any allowed root', () => {
    setupAllowlist();

    const result = validateMount(
      { hostPath: '/not-allowed/path', containerPath: 'mydir' },
      true,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('allows valid mount under allowed root, defaults to readonly', () => {
    setupAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/root/project', containerPath: 'project' },
      true,
    );

    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe('/allowed/root/project');
    expect(result.resolvedContainerPath).toBe('project');
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write when allowedRoot.allowReadWrite=true and isMain=true', () => {
    setupAllowlist();

    const result = validateMount(
      {
        hostPath: '/allowed/root/project',
        containerPath: 'project',
        readonly: false,
      },
      true,
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces readonly for non-main group when nonMainReadOnly=true', () => {
    setupAllowlist({ nonMainReadOnly: true });

    const result = validateMount(
      {
        hostPath: '/allowed/root/project',
        containerPath: 'project',
        readonly: false,
      },
      false,
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('forces readonly when root disallows read-write even for main', () => {
    setupAllowlist({
      allowedRoots: [
        {
          path: '/allowed/root',
          allowReadWrite: false,
          description: 'ro root',
        },
      ],
    });

    const result = validateMount(
      {
        hostPath: '/allowed/root/project',
        containerPath: 'project',
        readonly: false,
      },
      true,
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('derives containerPath from hostPath basename when not specified', () => {
    setupAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/root/my-project' },
      true,
    );

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
    mockExistsSync.mockReturnValue(false); // no allowlist

    const mounts: AdditionalMount[] = [
      { hostPath: '/some/path' },
      { hostPath: '/other/path' },
    ];

    const result = validateAdditionalMounts(mounts, 'test-group', true);

    expect(result).toEqual([]);
  });

  it('filters out rejected mounts, keeps valid ones', () => {
    setupAllowlist();

    const mounts: AdditionalMount[] = [
      { hostPath: '/allowed/root/valid', containerPath: 'valid' },
      { hostPath: '/not-allowed/invalid', containerPath: 'invalid' },
      { hostPath: '/allowed/root/also-valid', containerPath: 'also-valid' },
    ];

    const result = validateAdditionalMounts(mounts, 'test-group', true);

    expect(result).toHaveLength(2);
    expect(result[0].hostPath).toBe('/allowed/root/valid');
    expect(result[1].hostPath).toBe('/allowed/root/also-valid');
  });

  it('prefixes containerPath with /workspace/extra/', () => {
    setupAllowlist();

    const mounts: AdditionalMount[] = [
      { hostPath: '/allowed/root/project', containerPath: 'project' },
    ];

    const result = validateAdditionalMounts(mounts, 'test-group', true);

    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/project');
  });

  it('logs warnings for rejected mounts', async () => {
    // Need to get the pino mock's logger to check calls
    const pino = await import('pino');
    const loggerInstance = (
      pino.default as unknown as () => Record<string, ReturnType<typeof vi.fn>>
    )();

    setupAllowlist();

    const mounts: AdditionalMount[] = [
      { hostPath: '/not-allowed/path', containerPath: 'nope' },
    ];

    validateAdditionalMounts(mounts, 'test-group', true);

    expect(loggerInstance.warn).toHaveBeenCalled();
  });
});

describe('generateAllowlistTemplate', () => {
  it('returns valid JSON', () => {
    const template = generateAllowlistTemplate();

    expect(() => JSON.parse(template)).not.toThrow();
  });

  it('contains expected structure (allowedRoots, blockedPatterns, nonMainReadOnly)', () => {
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template);

    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(parsed.allowedRoots.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');

    // Verify root structure
    const firstRoot = parsed.allowedRoots[0];
    expect(firstRoot).toHaveProperty('path');
    expect(firstRoot).toHaveProperty('allowReadWrite');
    expect(firstRoot).toHaveProperty('description');
  });
});
