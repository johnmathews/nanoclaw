import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/test-groups',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
    },
  };
});

import { resolveModelAlias, readGroupConfig } from './group-config.js';
import { logger } from './logger.js';
import fs from 'fs';

describe('resolveModelAlias', () => {
  it('resolves "opus" to full model ID', () => {
    expect(resolveModelAlias('opus')).toBe('claude-opus-4-6');
  });

  it('resolves case-insensitively', () => {
    expect(resolveModelAlias('Sonnet')).toBe('claude-sonnet-4-6');
    expect(resolveModelAlias('HAIKU')).toBe('claude-haiku-4-5-20251001');
  });

  it('passes through full model IDs unchanged', () => {
    expect(resolveModelAlias('claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  it('passes through unknown strings unchanged', () => {
    expect(resolveModelAlias('some-custom-model')).toBe('some-custom-model');
  });

  it('trims whitespace', () => {
    expect(resolveModelAlias('  opus  ')).toBe('claude-opus-4-6');
  });
});

describe('readGroupConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns resolved model from valid config with alias', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{"model": "opus"}');
    const config = readGroupConfig('my-group');
    expect(config.model).toBe('claude-opus-4-6');
  });

  it('passes through full model ID', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      '{"model": "claude-sonnet-4-6"}',
    );
    const config = readGroupConfig('my-group');
    expect(config.model).toBe('claude-sonnet-4-6');
  });

  it('returns default model (opus) when file is missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const config = readGroupConfig('missing-group');
    expect(config).toEqual({ model: 'claude-opus-4-6' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns default model and warns on invalid JSON', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not json{');
    const config = readGroupConfig('bad-json');
    expect(config).toEqual({ model: 'claude-opus-4-6' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'bad-json' }),
      'Invalid JSON in group config',
    );
  });

  it('returns default model when no model field present', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{"other": "value"}');
    const config = readGroupConfig('no-model');
    expect(config).toEqual({ model: 'claude-opus-4-6' });
  });

  it('returns default model when model field is not a string', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{"model": 42}');
    const config = readGroupConfig('bad-model');
    expect(config).toEqual({ model: 'claude-opus-4-6' });
  });

  it('trims whitespace from model value', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{"model": "  opus  "}');
    const config = readGroupConfig('trim-test');
    expect(config.model).toBe('claude-opus-4-6');
  });

  it('ignores extra fields', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      '{"model": "haiku", "extra": true}',
    );
    const config = readGroupConfig('extra-fields');
    expect(config.model).toBe('claude-haiku-4-5-20251001');
  });

  it('parses skipImageMultimodal when true', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      '{"model": "opus", "skipImageMultimodal": true}',
    );
    const config = readGroupConfig('skip-img');
    expect(config.skipImageMultimodal).toBe(true);
  });

  it('parses skipImageMultimodal when false', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      '{"model": "opus", "skipImageMultimodal": false}',
    );
    const config = readGroupConfig('skip-img-false');
    expect(config.skipImageMultimodal).toBe(false);
  });

  it('ignores non-boolean skipImageMultimodal values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      '{"model": "opus", "skipImageMultimodal": "yes"}',
    );
    const config = readGroupConfig('skip-img-string');
    expect(config.skipImageMultimodal).toBeUndefined();
  });

  it('leaves skipImageMultimodal undefined when absent', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{"model": "sonnet"}');
    const config = readGroupConfig('no-skip');
    expect(config.skipImageMultimodal).toBeUndefined();
  });

  it('warns on non-ENOENT read errors', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    const config = readGroupConfig('no-access');
    expect(config).toEqual({ model: 'claude-opus-4-6' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'no-access' }),
      'Failed to read group config',
    );
  });
});
