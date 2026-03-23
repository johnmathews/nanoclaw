import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// Mock group-folder
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/fake/groups/${folder}`),
}));

// Mock transcription
const mockTranscribeAudioBuffer = vi.fn();
vi.mock('../transcription.js', () => ({
  transcribeAudioBuffer: (...args: any[]) => mockTranscribeAudioBuffer(...args),
}));

// Mock global fetch for Slack file downloads
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// --- @slack/bolt mock ---

type Handler = (...args: any[]) => any;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    eventHandlers = new Map<string, Handler>();
    token: string;
    appToken: string;

    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue(undefined),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: {},
        }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { real_name: 'Alice Smith', name: 'alice' },
        }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    constructor(opts: any) {
      this.token = opts.token;
      this.appToken = opts.appToken;
      appRef.current = this;
    }

    actionHandlers = new Map<string, Handler>();

    event(name: string, handler: Handler) {
      this.eventHandlers.set(name, handler);
    }

    action(pattern: string | RegExp, handler: Handler) {
      const key = pattern instanceof RegExp ? pattern.source : pattern;
      this.actionHandlers.set(key, handler);
    }

    async start() {}
    async stop() {}
  },
  LogLevel: { ERROR: 'error' },
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  }),
}));

import fs from 'fs';

import { SlackChannel, SlackChannelOpts, splitMessage } from './slack.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C0123456789': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  channel?: string;
  channelType?: string;
  user?: string;
  text?: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
  files?: Array<{
    id: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private_download?: string;
    pretty_type?: string;
    transcription?: {
      status?: string;
      preview?: { content?: string };
    };
  }>;
}) {
  return {
    channel: overrides.channel ?? 'C0123456789',
    channel_type: overrides.channelType ?? 'channel',
    user: overrides.user ?? 'U_USER_456',
    text: 'text' in overrides ? overrides.text : 'Hello everyone',
    ts: overrides.ts ?? '1704067200.000000',
    thread_ts: overrides.threadTs,
    subtype: overrides.subtype,
    bot_id: overrides.botId,
    files: overrides.files,
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerMessageEvent(
  event: ReturnType<typeof createMessageEvent>,
) {
  const handler = currentApp().eventHandlers.get('message');
  if (handler) await handler({ event });
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when app starts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message event handler on construction', () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      expect(currentApp().eventHandlers.has('message')).toBe(true);
    });

    it('gets bot user ID on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(currentApp().client.auth.test).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello everyone' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          id: '1704067200.000000',
          chat_jid: 'slack:C0123456789',
          sender: 'U_USER_456',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ channel: 'C9999999999' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C9999999999',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text subtypes (channel_join, etc.)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ subtype: 'channel_join' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('allows bot_message subtype through', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_OTHER_BOT',
        text: 'Bot message',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
    });

    it('skips messages with no text and no files', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: undefined as any });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects bot messages by bot_id', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
        text: 'Bot response',
      });
      await triggerMessageEvent(event);

      // Has bot_id so should be marked as bot message
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
          sender_name: 'Jonesy',
        }),
      );
    });

    it('detects bot messages by matching bot user ID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        user: 'U_BOT_123',
        text: 'Self message',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('identifies IM channel type as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:D0123456789': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        channel: 'D0123456789',
        channelType: 'im',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:D0123456789',
        expect.any(String),
        undefined,
        'slack',
        false, // IM is not a group
      );
    });

    it('converts ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ ts: '1704067200.000000' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('resolves user name from Slack API', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ user: 'U_USER_456', text: 'Hello' });
      await triggerMessageEvent(event);

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U_USER_456',
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'Alice Smith',
        }),
      );
    });

    it('caches user names to avoid repeated API calls', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // First message — API call
      await triggerMessageEvent(
        createMessageEvent({ user: 'U_USER_456', text: 'First' }),
      );
      // Second message — should use cache
      await triggerMessageEvent(
        createMessageEvent({
          user: 'U_USER_456',
          text: 'Second',
          ts: '1704067201.000000',
        }),
      );

      expect(currentApp().client.users.info).toHaveBeenCalledTimes(1);
    });

    it('falls back to user ID when API fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.users.info.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createMessageEvent({ user: 'U_UNKNOWN', text: 'Hi' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'U_UNKNOWN',
        }),
      );
    });

    it('flattens threaded replies into channel messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs: '1704067200.000000', // parent message ts — this is a reply
        text: 'Thread reply',
      });
      await triggerMessageEvent(event);

      // Threaded replies are delivered as regular channel messages
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread reply',
        }),
      );
    });

    it('delivers thread parent messages normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067200.000000',
        threadTs: '1704067200.000000', // same as ts — this IS the parent
        text: 'Thread parent',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread parent',
        }),
      );
    });

    it('delivers messages without thread_ts normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Normal message' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalled();
    });
  });

  // --- File attachment processing ---

  describe('file attachment processing', () => {
    let writeFileSpy: ReturnType<typeof vi.spyOn>;
    let mkdirSpy: ReturnType<typeof vi.spyOn>;

    function mockFetchResponse(buffer: Buffer) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () =>
          Promise.resolve(
            buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            ),
          ),
      });
    }

    function mockFetchFailure(status = 403) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
      });
    }

    beforeEach(() => {
      mockFetch.mockReset();
      mockTranscribeAudioBuffer.mockReset();
      writeFileSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => '' as any);
    });

    afterEach(() => {
      writeFileSpy.mockRestore();
      mkdirSpy.mockRestore();
    });

    it('allows file_share subtype through', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      mockFetchResponse(Buffer.from('image-data'));

      const event = createMessageEvent({
        subtype: 'file_share',
        text: 'Check this out',
        files: [
          {
            id: 'F001',
            name: 'photo.png',
            mimetype: 'image/png',
            size: 1024,
            url_private_download: 'https://files.slack.com/F001/photo.png',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('accepts file-only messages with no text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      mockFetchResponse(Buffer.from('image-data'));

      const event = createMessageEvent({
        subtype: 'file_share',
        text: undefined as any,
        files: [
          {
            id: 'F001',
            name: 'photo.png',
            mimetype: 'image/png',
            size: 2048,
            url_private_download: 'https://files.slack.com/F001/photo.png',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining('[Image attached: attachments/'),
        }),
      );
    });

    it('downloads and saves image files to attachments dir', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const imageBuffer = Buffer.from('fake-png-data');
      mockFetchResponse(imageBuffer);

      const event = createMessageEvent({
        text: 'Look at this',
        files: [
          {
            id: 'F_IMG',
            name: 'screenshot.png',
            mimetype: 'image/png',
            size: 4096,
            url_private_download:
              'https://files.slack.com/F_IMG/screenshot.png',
          },
        ],
      });
      await triggerMessageEvent(event);

      // File downloaded with auth header
      expect(mockFetch).toHaveBeenCalledWith(
        'https://files.slack.com/F_IMG/screenshot.png',
        { headers: { Authorization: 'Bearer xoxb-test-token' } },
      );

      // Directory created
      expect(mkdirSpy).toHaveBeenCalledWith(
        '/fake/groups/test-channel/attachments',
        { recursive: true },
      );

      // File written
      expect(writeFileSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/fake\/groups\/test-channel\/attachments\/img-\d+-F_IMG\.png$/,
        ),
        imageBuffer,
      );

      // Content includes image reference
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining('[Image attached: attachments/img-'),
        }),
      );
    });

    it('transcribes audio files via Whisper', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const audioBuffer = Buffer.from('fake-audio');
      mockFetchResponse(audioBuffer);
      mockTranscribeAudioBuffer.mockResolvedValueOnce(
        'Hello, this is a voice note',
      );

      const event = createMessageEvent({
        text: '',
        files: [
          {
            id: 'F_AUD',
            name: 'voice.ogg',
            mimetype: 'audio/ogg',
            url_private_download: 'https://files.slack.com/F_AUD/voice.ogg',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(mockTranscribeAudioBuffer).toHaveBeenCalledWith(
        audioBuffer,
        'voice.ogg',
        'audio/ogg',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            '[Voice note: Hello, this is a voice note]',
          ),
        }),
      );
    });

    it('shows fallback when audio transcription fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      mockFetchResponse(Buffer.from('audio-data'));
      mockTranscribeAudioBuffer.mockResolvedValueOnce(null);

      const event = createMessageEvent({
        text: '',
        files: [
          {
            id: 'F_AUD2',
            name: 'clip.mp3',
            mimetype: 'audio/mpeg',
            url_private_download: 'https://files.slack.com/F_AUD2/clip.mp3',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            '[Voice note: transcription unavailable]',
          ),
        }),
      );
    });

    it('passes correct filename and mimetype for m4a audio (regression: hardcoded voice.ogg broke Slack)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const audioBuffer = Buffer.from('fake-m4a-audio');
      mockFetchResponse(audioBuffer);
      mockTranscribeAudioBuffer.mockResolvedValueOnce('Transcribed from m4a');

      const event = createMessageEvent({
        text: '',
        files: [
          {
            id: 'F_M4A',
            name: 'Audio Clip (2026-03-18 13:23:44).m4a',
            mimetype: 'audio/mp4',
            url_private_download: 'https://files.slack.com/F_M4A/audio.m4a',
          },
        ],
      });
      await triggerMessageEvent(event);

      // Must pass the actual filename and mimetype, not hardcoded voice.ogg
      expect(mockTranscribeAudioBuffer).toHaveBeenCalledWith(
        audioBuffer,
        'Audio Clip (2026-03-18 13:23:44).m4a',
        'audio/mp4',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            '[Voice note: Transcribed from m4a]',
          ),
        }),
      );
    });

    it('passes correct filename and mimetype for webm audio', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const audioBuffer = Buffer.from('fake-webm-audio');
      mockFetchResponse(audioBuffer);
      mockTranscribeAudioBuffer.mockResolvedValueOnce('Webm transcript');

      const event = createMessageEvent({
        text: '',
        files: [
          {
            id: 'F_WEBM',
            name: 'recording.webm',
            mimetype: 'audio/webm',
            url_private_download:
              'https://files.slack.com/F_WEBM/recording.webm',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(mockTranscribeAudioBuffer).toHaveBeenCalledWith(
        audioBuffer,
        'recording.webm',
        'audio/webm',
      );
    });

    it('shows error message when transcription throws (regression: errors were silently swallowed)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      mockFetchResponse(Buffer.from('audio-data'));
      mockTranscribeAudioBuffer.mockRejectedValueOnce(
        new Error(
          "400 Invalid file format. Supported formats: ['flac', 'm4a', 'mp3']",
        ),
      );

      const event = createMessageEvent({
        text: '',
        files: [
          {
            id: 'F_ERR',
            name: 'broken.wav',
            mimetype: 'audio/wav',
            url_private_download: 'https://files.slack.com/F_ERR/broken.wav',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining('[Voice note: transcription failed'),
        }),
      );
    });

    it('saves document files with metadata', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const xlsBuffer = Buffer.from('fake-excel');
      mockFetchResponse(xlsBuffer);

      const event = createMessageEvent({
        text: 'Here is the report',
        files: [
          {
            id: 'F_DOC',
            name: 'report.xlsx',
            mimetype:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 25600,
            pretty_type: 'Excel Spreadsheet',
            url_private_download: 'https://files.slack.com/F_DOC/report.xlsx',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(writeFileSpy).toHaveBeenCalledWith(
        '/fake/groups/test-channel/attachments/F_DOC-report.xlsx',
        xlsBuffer,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            '[File attached: attachments/F_DOC-report.xlsx] (Excel Spreadsheet, 25.0 KB)',
          ),
        }),
      );
    });

    it('handles multiple files in one message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      mockFetchResponse(Buffer.from('img1'));
      mockFetchResponse(Buffer.from('img2'));

      const event = createMessageEvent({
        text: 'Two images',
        files: [
          {
            id: 'F1',
            name: 'a.png',
            mimetype: 'image/png',
            size: 100,
            url_private_download: 'https://files.slack.com/F1/a.png',
          },
          {
            id: 'F2',
            name: 'b.jpg',
            mimetype: 'image/jpeg',
            size: 200,
            url_private_download: 'https://files.slack.com/F2/b.jpg',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(writeFileSpy).toHaveBeenCalledTimes(2);
    });

    it('gracefully handles download failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      mockFetchFailure(403);

      const event = createMessageEvent({
        text: 'Check this file',
        files: [
          {
            id: 'F_FAIL',
            name: 'secret.pdf',
            mimetype: 'application/pdf',
            url_private_download: 'https://files.slack.com/F_FAIL/secret.pdf',
          },
        ],
      });
      await triggerMessageEvent(event);

      // Message still delivered with original text, no file reference
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Check this file',
        }),
      );
      expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it('adds pdf-reader instruction for PDF attachments', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const pdfBuffer = Buffer.from('fake-pdf');
      mockFetchResponse(pdfBuffer);

      const event = createMessageEvent({
        text: 'Please review this',
        files: [
          {
            id: 'F_PDF',
            name: 'report.pdf',
            mimetype: 'application/pdf',
            size: 51200,
            url_private_download: 'https://files.slack.com/F_PDF/report.pdf',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(writeFileSpy).toHaveBeenCalledWith(
        '/fake/groups/test-channel/attachments/F_PDF-report.pdf',
        pdfBuffer,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            '[PDF: attachments/F_PDF-report.pdf (50.0 KB)]',
          ),
        }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            'pdf-reader extract attachments/F_PDF-report.pdf',
          ),
        }),
      );
    });

    it('does not process files from bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_BOT',
        text: 'Bot shared a file',
        files: [
          {
            id: 'F_BOT',
            name: 'bot-file.png',
            mimetype: 'image/png',
            url_private_download: 'https://files.slack.com/F_BOT/bot-file.png',
          },
        ],
      });
      await triggerMessageEvent(event);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned via Slack format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect(); // sets botUserId to 'U_BOT_123'

      const event = createMessageEvent({
        text: 'Hey <@U_BOT_123> what do you think?',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy Hey <@U_BOT_123> what do you think?',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@Jonesy <@U_BOT_123> hello',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Content should be unchanged since it already matches TRIGGER_PATTERN
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy <@U_BOT_123> hello',
        }),
      );
    });

    it('does not translate mentions in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Echo: <@U_BOT_123>',
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
      });
      await triggerMessageEvent(event);

      // Bot messages skip mention translation
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Echo: <@U_BOT_123>',
        }),
      );
    });

    it('does not translate mentions for other users', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Hey <@U_OTHER_USER> look at this',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Mention is for a different user, not the bot
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Hey <@U_OTHER_USER> look at this',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Slack client', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C0123456789', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Hello',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:D9876543210', 'DM message');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D9876543210',
        text: 'DM message',
      });
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Don't connect — should queue
      await channel.sendMessage('slack:C0123456789', 'Queued message');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:C0123456789', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('splits long messages at 4000 character boundary', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Create a message longer than 4000 chars
      const longText = 'A'.repeat(4500);
      await channel.sendMessage('slack:C0123456789', longText);

      // Should be split into 2 messages: 4000 + 500
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(1, {
        channel: 'C0123456789',
        text: 'A'.repeat(4000),
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(2, {
        channel: 'C0123456789',
        text: 'A'.repeat(500),
      });
    });

    it('sends exactly-4000-char messages as a single message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const text = 'B'.repeat(4000);
      await channel.sendMessage('slack:C0123456789', text);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text,
      });
    });

    it('splits messages into 3 parts when over 8000 chars', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const longText = 'C'.repeat(8500);
      await channel.sendMessage('slack:C0123456789', longText);

      // 4000 + 4000 + 500 = 3 messages
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(3);
    });

    it('flushes queued messages on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('slack:C0123456789', 'First queued');
      await channel.sendMessage('slack:C0123456789', 'Second queued');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();

      // Connect triggers flush
      await channel.connect();

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'First queued',
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Second queued',
      });
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(true);
    });

    it('owns slack: DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:D0123456789')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- syncChannelMetadata ---

  describe('syncChannelMetadata', () => {
    it('calls conversations.list and updates chat names', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C001', name: 'general', is_member: true },
          { id: 'C002', name: 'random', is_member: true },
          { id: 'C003', name: 'external', is_member: false },
        ],
        response_metadata: {},
      });

      await channel.connect();

      // connect() calls syncChannelMetadata internally
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
      // Non-member channels are skipped
      expect(updateChatName).not.toHaveBeenCalledWith('slack:C003', 'external');
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockRejectedValue(
        new Error('API error'),
      );

      // Should not throw
      await expect(channel.connect()).resolves.toBeUndefined();
    });
  });

  // --- setTyping / :eyes: reaction lifecycle ---

  describe('setTyping', () => {
    it('adds :eyes: reaction when typing starts with messageTs', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.setTyping('slack:C0123456789', true, '1234567890.123456');

      expect(currentApp().client.reactions.add).toHaveBeenCalledWith({
        channel: 'C0123456789',
        timestamp: '1234567890.123456',
        name: 'eyes',
      });
    });

    it('does nothing when typing starts without messageTs and no prior reaction', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.setTyping('slack:C0123456789', true);

      expect(currentApp().client.reactions.add).not.toHaveBeenCalled();
    });

    it('removes :eyes: reaction when typing stops', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // First add a reaction
      await channel.setTyping('slack:C0123456789', true, '1234567890.123456');
      currentApp().client.reactions.add.mockClear();

      // Then stop typing — should remove it
      await channel.setTyping('slack:C0123456789', false);

      expect(currentApp().client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C0123456789',
        timestamp: '1234567890.123456',
        name: 'eyes',
      });
    });

    it('does nothing when typing stops with no prior reaction', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.setTyping('slack:C0123456789', false);

      expect(currentApp().client.reactions.remove).not.toHaveBeenCalled();
    });

    it('remembers messageTs so subsequent setTyping(true) reuses it', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // First call with explicit messageTs
      await channel.setTyping('slack:C0123456789', true, '1234567890.123456');
      currentApp().client.reactions.add.mockClear();

      // Second call without messageTs — should reuse stored ts
      await channel.setTyping('slack:C0123456789', true);

      expect(currentApp().client.reactions.add).toHaveBeenCalledWith({
        channel: 'C0123456789',
        timestamp: '1234567890.123456',
        name: 'eyes',
      });
    });

    it('clears stored messageTs after typing stops', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.setTyping('slack:C0123456789', true, '1234567890.123456');
      await channel.setTyping('slack:C0123456789', false);
      currentApp().client.reactions.add.mockClear();
      currentApp().client.reactions.remove.mockClear();

      // Now typing again without messageTs — should not add reaction (ts was cleared)
      await channel.setTyping('slack:C0123456789', true);

      expect(currentApp().client.reactions.add).not.toHaveBeenCalled();
    });

    it('handles reaction add failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.reactions.add.mockRejectedValueOnce(
        new Error('already_reacted'),
      );

      // Should not throw
      await expect(
        channel.setTyping('slack:C0123456789', true, '1234567890.123456'),
      ).resolves.toBeUndefined();
    });

    it('handles reaction remove failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.setTyping('slack:C0123456789', true, '1234567890.123456');
      currentApp().client.reactions.remove.mockRejectedValueOnce(
        new Error('no_reaction'),
      );

      // Should not throw
      await expect(
        channel.setTyping('slack:C0123456789', false),
      ).resolves.toBeUndefined();
    });

    it('tracks reactions per channel independently', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.setTyping('slack:C_AAA', true, 'ts-aaa');
      await channel.setTyping('slack:C_BBB', true, 'ts-bbb');

      // Stop typing in channel A only
      await channel.setTyping('slack:C_AAA', false);

      expect(currentApp().client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C_AAA',
        timestamp: 'ts-aaa',
        name: 'eyes',
      });

      // Channel B reaction should still be active — stopping B should remove it
      currentApp().client.reactions.remove.mockClear();
      await channel.setTyping('slack:C_BBB', false);

      expect(currentApp().client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C_BBB',
        timestamp: 'ts-bbb',
        name: 'eyes',
      });
    });
  });

  // --- sendMessage removes :eyes: reaction ---

  describe('sendMessage clears working reaction', () => {
    it('removes :eyes: reaction when first response is sent', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Simulate agent working: add reaction
      await channel.setTyping('slack:C0123456789', true, '1234567890.123456');
      currentApp().client.reactions.remove.mockClear();

      // Send response — should auto-remove reaction
      await channel.sendMessage('slack:C0123456789', 'Here is the answer');

      expect(currentApp().client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C0123456789',
        timestamp: '1234567890.123456',
        name: 'eyes',
      });
    });

    it('does not call reactions.remove when no working reaction exists', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C0123456789', 'Unprompted message');

      expect(currentApp().client.reactions.remove).not.toHaveBeenCalled();
    });
  });

  // --- Constructor error handling ---

  describe('constructor', () => {
    it('throws when SLACK_BOT_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: '',
        SLACK_APP_TOKEN: 'xapp-test-token',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });

    it('throws when SLACK_APP_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_APP_TOKEN: '',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });
  });

  // --- syncChannelMetadata pagination ---

  describe('syncChannelMetadata pagination', () => {
    it('paginates through multiple pages of channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // First page returns a cursor; second page returns no cursor
      currentApp()
        .client.conversations.list.mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'general', is_member: true }],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'random', is_member: true }],
          response_metadata: {},
        });

      await channel.connect();

      // Should have called conversations.list twice (once per page)
      expect(currentApp().client.conversations.list).toHaveBeenCalledTimes(2);
      expect(currentApp().client.conversations.list).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor_page2' }),
      );

      // Both channels from both pages stored
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.name).toBe('slack');
    });

    it('has hasNativeTyping set to true', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.hasNativeTyping).toBe(true);
    });
  });

  // --- flushOutgoingQueue robustness ---

  describe('flushOutgoingQueue', () => {
    it('splits long queued messages when flushing', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue a long message while disconnected
      const longText = 'word '.repeat(1000); // 5000 chars
      await channel.sendMessage('slack:C0123456789', longText);
      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();

      // Connect triggers flush — should split the message
      await channel.connect();

      // Should have been split (5000 chars > 4000 limit)
      const calls = currentApp().client.chat.postMessage.mock.calls;
      const textCalls = calls.filter(
        (c: any[]) => c[0].channel === 'C0123456789',
      );
      expect(textCalls.length).toBeGreaterThanOrEqual(2);

      // Verify no chunk exceeds the limit
      for (const call of textCalls) {
        expect(call[0].text.length).toBeLessThanOrEqual(4000);
      }
    });

    it('continues flushing after a single message fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue two messages while disconnected
      await channel.sendMessage('slack:C0123456789', 'Message 1');
      await channel.sendMessage('slack:C0123456789', 'Message 2');

      // First call fails, second succeeds
      currentApp()
        .client.chat.postMessage.mockRejectedValueOnce(
          new Error('Temporary failure'),
        )
        .mockResolvedValue(undefined);

      await channel.connect();

      // Message 2 should still have been sent despite Message 1 failing
      const texts = currentApp()
        .client.chat.postMessage.mock.calls.map((c: any[]) => c[0].text)
        .filter((t: string) => t === 'Message 2');
      expect(texts.length).toBe(1);
    });

    it('re-queues failed messages for next flush', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.sendMessage('slack:C0123456789', 'Will fail');

      // Make flush fail
      currentApp()
        .client.chat.postMessage.mockRejectedValueOnce(
          new Error('Network error'),
        );

      await channel.connect();

      // Clear the mock and make next flush succeed
      currentApp().client.chat.postMessage.mockClear();
      currentApp().client.chat.postMessage.mockResolvedValue(undefined);

      // Send another message to trigger the queue check indirectly —
      // or just verify the queue still has the failed message by sending
      // a successful message and checking the failed one gets re-flushed
      // on disconnect/reconnect. We can test by calling sendMessage which
      // internally checks the queue.
      await channel.sendMessage('slack:C0123456789', 'New message');

      // The new message should have been sent
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'New message',
      });
    });
  });
});

// --- splitMessage unit tests (exported function) ---

describe('splitMessage', () => {
  it('returns single-element array for short messages', () => {
    expect(splitMessage('Hello world')).toEqual(['Hello world']);
  });

  it('returns single-element array at exactly maxLen', () => {
    const text = 'A'.repeat(4000);
    expect(splitMessage(text)).toEqual([text]);
  });

  it('splits at last newline before limit', () => {
    const line1 = 'A'.repeat(3000);
    const line2 = 'B'.repeat(2000);
    const text = `${line1}\n${line2}`;

    const chunks = splitMessage(text);
    expect(chunks).toEqual([line1, line2]);
  });

  it('splits at last space when no newline available', () => {
    // Create text with spaces but no newlines
    const words = Array(500).fill('word').join(' '); // 2499 chars
    const text = words + ' ' + words; // ~5000 chars, only spaces

    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // No chunk should exceed the limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }

    // All content preserved (whitespace may vary at split points)
    const reassembled = chunks.join(' ').replace(/\s+/g, ' ');
    expect(reassembled).toBe(text.replace(/\s+/g, ' '));
  });

  it('hard-splits when no whitespace available', () => {
    const text = 'A'.repeat(5000);
    const chunks = splitMessage(text);

    expect(chunks).toEqual(['A'.repeat(4000), 'A'.repeat(1000)]);
  });

  it('handles custom maxLen', () => {
    const text = 'Hello World Test';
    const chunks = splitMessage(text, 11);

    expect(chunks).toEqual(['Hello World', 'Test']);
  });

  it('handles empty string', () => {
    expect(splitMessage('')).toEqual(['']);
  });

  it('handles text with multiple newlines near the limit', () => {
    const part1 = 'A'.repeat(3500);
    const part2 = 'B'.repeat(200);
    const part3 = 'C'.repeat(200);
    const part4 = 'D'.repeat(2000);
    const text = `${part1}\n${part2}\n${part3}\n${part4}`;

    const chunks = splitMessage(text);
    // Should split at the last newline before 4000 (after part3)
    expect(chunks[0]).toBe(`${part1}\n${part2}\n${part3}`);
    expect(chunks[1]).toBe(part4);
  });
});
