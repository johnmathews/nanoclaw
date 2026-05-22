import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(),
  hasTable: vi.fn(),
}));

vi.mock('./usage.js', () => ({
  getUsageText: vi.fn(async () => 'mock usage text'),
}));

import { hasTable } from './db/connection.js';
import { gateCommand } from './command-gate.js';

const mockedHasTable = vi.mocked(hasTable);

beforeEach(() => {
  // Default: no user_roles table → isAdmin returns true (open-by-default).
  mockedHasTable.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

function content(text: string): string {
  return JSON.stringify({ text });
}

describe('gateCommand', () => {
  it('passes plain chat through', () => {
    expect(gateCommand(content('hello there'), 'u1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('filters /help silently', () => {
    expect(gateCommand(content('/help'), 'u1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('admits /clear when caller is admin', () => {
    expect(gateCommand(content('/clear'), 'u1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('denies /clear when caller is anonymous (no userId)', () => {
    expect(gateCommand(content('/clear'), null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  describe('/usage host responder', () => {
    it('returns a respond action whose render produces the usage text', async () => {
      const result = gateCommand(content('/usage'), 'u1', 'ag-1');
      expect(result.action).toBe('respond');
      if (result.action === 'respond') {
        expect(result.command).toBe('/usage');
        await expect(result.render()).resolves.toBe('mock usage text');
      }
    });

    it('denies /usage when caller is anonymous', () => {
      expect(gateCommand(content('/usage'), null, 'ag-1')).toEqual({ action: 'deny', command: '/usage' });
    });

    it('matches /usage regardless of trailing text', () => {
      const result = gateCommand(content('/usage right now please'), 'u1', 'ag-1');
      expect(result.action).toBe('respond');
    });
  });

  it('passes unknown slash commands through to the SDK', () => {
    expect(gateCommand(content('/somethingElse'), 'u1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('tolerates non-JSON content', () => {
    expect(gateCommand('/usage', 'u1', 'ag-1').action).toBe('respond');
  });
});
