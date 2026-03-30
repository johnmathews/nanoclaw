import fs from 'fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock googleapis
const { mockGetProfile } = vi.hoisted(() => ({ mockGetProfile: vi.fn() }));
vi.mock('googleapis', () => {
  class MockOAuth2 {
    setCredentials = vi.fn();
    on = vi.fn();
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      gmail: vi.fn().mockReturnValue({
        users: { getProfile: mockGetProfile },
      }),
    },
  };
});

import { GmailChannel, GmailChannelOpts } from './gmail.js';

function makeOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

describe('GmailChannel', () => {
  let channel: GmailChannel;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
  });

  describe('ownsJid', () => {
    it('returns true for gmail: prefixed JIDs', () => {
      expect(channel.ownsJid('gmail:abc123')).toBe(true);
      expect(channel.ownsJid('gmail:thread-id-456')).toBe(true);
    });

    it('returns false for non-gmail JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
      expect(channel.ownsJid('user@s.whatsapp.net')).toBe(false);
    });
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(channel.name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('connect with expired token', () => {
    it('does not crash when OAuth token is expired/revoked', async () => {
      // Provide fake credential files
      const fakeKeys = JSON.stringify({
        installed: {
          client_id: 'fake-id',
          client_secret: 'fake-secret',
          redirect_uris: ['http://localhost'],
        },
      });
      const fakeTokens = JSON.stringify({
        access_token: 'expired',
        refresh_token: 'expired',
      });

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockImplementation((p: any) => {
        if (String(p).includes('gcp-oauth.keys.json')) return fakeKeys;
        if (String(p).includes('credentials.json')) return fakeTokens;
        return '';
      });

      // Simulate invalid_grant error from Google
      mockGetProfile.mockRejectedValueOnce({
        response: { data: { error: 'invalid_grant' } },
      });

      // Should not throw — should degrade gracefully
      await channel.connect();
      expect(channel.isConnected()).toBe(false);

      vi.restoreAllMocks();
    });
  });

  describe('constructor options', () => {
    it('accepts custom poll interval', () => {
      const ch = new GmailChannel(makeOpts(), 30000);
      expect(ch.name).toBe('gmail');
    });

    it('defaults to unread query when no filter configured', () => {
      const ch = new GmailChannel(makeOpts());
      const query = (
        ch as unknown as { buildQuery: () => string }
      ).buildQuery();
      expect(query).toBe('is:unread category:primary');
    });

    it('defaults with no options provided', () => {
      const ch = new GmailChannel(makeOpts());
      expect(ch.name).toBe('gmail');
    });
  });
});
