import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { readEnvFile } from './env.js';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from './logger.js';

describe('readEnvFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses requested keys from .env', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'FOO=bar\nBAZ=qux\nIGNORED=yes\n',
    );
    const result = readEnvFile(['FOO', 'BAZ']);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips quotes from values', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('A="double"\nB=\'single\'\n');
    const result = readEnvFile(['A', 'B']);
    expect(result).toEqual({ A: 'double', B: 'single' });
  });

  it('skips empty values and comments', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      '# comment\nEMPTY=\nVALID=yes\n',
    );
    const result = readEnvFile(['EMPTY', 'VALID']);
    expect(result).toEqual({ VALID: 'yes' });
  });

  it('returns empty object when file not found', () => {
    const err: NodeJS.ErrnoException = new Error('ENOENT');
    err.code = 'ENOENT';
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw err;
    });
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({});
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs error-level message on permission denied', () => {
    const err: NodeJS.ErrnoException = new Error('EACCES');
    err.code = 'EACCES';
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw err;
    });
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({});
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('.env') }),
      expect.stringContaining('not readable'),
    );
  });
});
