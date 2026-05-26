import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub readEnvFile so the production .env's OPENAI_API_KEY doesn't leak into
// the maybeTranscribe path — we want the no-key branch so audio tests stay
// hermetic instead of hitting Whisper for real.
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import type { downloadMediaMessage } from '@whiskeysockets/baileys';
import { DisconnectReason } from '@whiskeysockets/baileys';

import { classifyConnectionClose, downloadInboundMedia } from './whatsapp.js';
import { resetTranscriptionCacheForTests } from '../transcription.js';

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  resetTranscriptionCacheForTests();
});

afterEach(() => {
  if (ORIGINAL_OPENAI_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
  resetTranscriptionCacheForTests();
});

// Minimal WAMessage stand-in — downloadInboundMedia only forwards it to the
// injected downloader, never inspects fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubMsg: any = { key: { id: 'wa-msg-1' } };

// Match Baileys' overloaded signature with an `as any` cast on the mock —
// the production function is generic over the `type` discriminator and
// vitest's `vi.fn` can't replicate that exactly. The runtime call only ever
// passes `'buffer'`, so widening the type is safe here.
function stubDownload(buffer: Buffer): typeof downloadMediaMessage {
  return vi.fn(async () => buffer) as unknown as typeof downloadMediaMessage;
}

describe('downloadInboundMedia', () => {
  it('returns an empty array when no media is present', async () => {
    const dl = stubDownload(Buffer.from('unused'));
    const out = await downloadInboundMedia(stubMsg, { conversation: 'text only' }, dl);
    expect(out).toEqual([]);
    expect(dl).not.toHaveBeenCalled();
  });

  it('produces a base64 image entry (no file written to disk)', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const dl = stubDownload(bytes);
    const out = await downloadInboundMedia(stubMsg, { imageMessage: { mimetype: 'image/jpeg' } }, dl);
    expect(out).toHaveLength(1);
    const [entry] = out;
    expect(entry.type).toBe('image');
    expect(entry.mimeType).toBe('image/jpeg');
    expect(entry.size).toBe(bytes.length);
    expect(entry.data).toBe(bytes.toString('base64'));
    expect(entry.name).toMatch(/^image-\d+\.jpg$/);
    // Critically: no localPath on the adapter side. session-manager's
    // extractAttachmentFiles is the one that adds localPath after spilling.
    expect(entry.localPath).toBeUndefined();
    // And no transcription work for an image.
    expect(entry.transcription).toBeUndefined();
    expect(entry.transcriptionError).toBeUndefined();
  });

  it('runs maybeTranscribe for audio messages (captures error when no API key)', async () => {
    const dl = stubDownload(Buffer.from('opus-bytes'));
    const out = await downloadInboundMedia(stubMsg, { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } }, dl);
    expect(out).toHaveLength(1);
    const [entry] = out;
    expect(entry.type).toBe('audio');
    expect(entry.mimeType).toBe('audio/ogg; codecs=opus');
    expect(entry.data).toBe(Buffer.from('opus-bytes').toString('base64'));
    // OPENAI_API_KEY was deleted in beforeEach, so transcription should
    // record the missing-key error rather than silently no-oping. This is
    // the contract that makes voice notes diagnosable end-to-end.
    expect(entry.transcriptionError).toContain('OPENAI_API_KEY');
    expect(entry.transcription).toBeUndefined();
  });

  it('runs maybePdfExtract for application/pdf documents', async () => {
    const dl = stubDownload(Buffer.alloc(0));
    const out = await downloadInboundMedia(
      stubMsg,
      {
        documentMessage: {
          fileName: 'spec.pdf',
          mimetype: 'application/pdf',
        },
      },
      dl,
    );
    expect(out).toHaveLength(1);
    const [entry] = out;
    expect(entry.type).toBe('document');
    expect(entry.name).toBe('spec.pdf');
    expect(entry.mimeType).toBe('application/pdf');
    // Empty buffer triggers a deterministic "Empty PDF buffer" error from
    // extractPdfText without spawning pdftotext — keeps the test hermetic.
    expect(entry.pdfExtractionError).toContain('Empty PDF buffer');
    expect(entry.extractedText).toBeUndefined();
  });

  it('rejects unsafe attacker-controlled filenames with the fallback name', async () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dl = stubDownload(Buffer.from('x'));
      const out = await downloadInboundMedia(
        stubMsg,
        {
          documentMessage: {
            fileName: '../../etc/passwd',
            mimetype: 'application/octet-stream',
          },
        },
        dl,
      );
      expect(out).toHaveLength(1);
      const [entry] = out;
      expect(entry.name).not.toBe('../../etc/passwd');
      expect(entry.name).toMatch(/^document-\d+$/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to the media-class default mime when Baileys omits mimetype', async () => {
    const dl = stubDownload(Buffer.from('x'));
    const out = await downloadInboundMedia(stubMsg, { videoMessage: {} }, dl);
    expect(out).toHaveLength(1);
    expect(out[0].mimeType).toBe('video/mp4');
  });

  it('continues past a failing downloader without throwing', async () => {
    const dl = vi.fn(async () => {
      throw new Error('decryption failed');
    }) as unknown as typeof downloadMediaMessage;
    const out = await downloadInboundMedia(stubMsg, { imageMessage: { mimetype: 'image/jpeg' } }, dl);
    expect(out).toEqual([]);
    expect(dl).toHaveBeenCalledTimes(1);
  });
});

describe('classifyConnectionClose', () => {
  // Regression: a previous build wiped store/auth on every graceful shutdown
  // because the disconnect handler treated `shouldReconnect === false` as
  // "logged out". The user would reach for the phone thinking WhatsApp
  // dropped them server-side; really, every service restart was eating its
  // own credentials. The classifier now isolates that decision so this test
  // can guard it.

  it('reconnects on a transient close while running', () => {
    expect(classifyConnectionClose(undefined, false)).toBe('reconnect');
    expect(classifyConnectionClose(DisconnectReason.connectionReplaced, false)).toBe('reconnect');
    expect(classifyConnectionClose(DisconnectReason.restartRequired, false)).toBe('reconnect');
  });

  it('wipes only on an actual server-side logout (401 / loggedOut)', () => {
    expect(classifyConnectionClose(DisconnectReason.loggedOut, false)).toBe('wipe');
  });

  it('preserves credentials on graceful shutdown — no matter the reason', () => {
    // Baileys reports `reason=undefined` for most clean closes, but even on
    // weirder shutdown-time codes we must never wipe.
    expect(classifyConnectionClose(undefined, true)).toBe('preserve');
    expect(classifyConnectionClose(DisconnectReason.connectionClosed, true)).toBe('preserve');
    expect(classifyConnectionClose(DisconnectReason.connectionLost, true)).toBe('preserve');
  });

  it('still wipes a logout that arrives during shutdown', () => {
    // If the server says loggedOut while we're shutting down, the creds are
    // already dead — keeping them only causes a 401 loop on next start.
    expect(classifyConnectionClose(DisconnectReason.loggedOut, true)).toBe('wipe');
  });
});
