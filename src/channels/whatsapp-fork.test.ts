/**
 * WhatsApp fork behaviours.
 *
 * Two failure modes with severe, quiet consequences:
 *   - Wiping auth on a graceful shutdown. Presents as "scan the QR again" and
 *     cannot be undone; this install has been through it.
 *   - Delivering an attachment as a host path the container cannot open, so
 *     the agent sees a reference it can never fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transcribeAudio = vi.fn();
const extractPdfText = vi.fn();
vi.mock('./chat-sdk-bridge.js', () => ({
  // Mirrors the real helpers' contract: mutate the entry, never throw.
  maybeTranscribe: async (entry: Record<string, unknown>, buf: Buffer) => {
    if (!String(entry.mimeType ?? '').startsWith('audio/')) return;
    try {
      entry.transcription = (await transcribeAudio(buf)) as string;
    } catch (err) {
      entry.transcriptionError = (err as Error).message;
    }
  },
  maybePdfExtract: async (entry: Record<string, unknown>, buf: Buffer) => {
    if (entry.mimeType !== 'application/pdf') return;
    try {
      entry.extractedText = (await extractPdfText(buf)) as string;
    } catch (err) {
      entry.pdfExtractionError = (err as Error).message;
    }
  },
}));

import { buildInboundAttachment, classifyConnectionClose } from './whatsapp.js';

// Baileys' loggedOut status code.
const LOGGED_OUT = 401;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('classifyConnectionClose', () => {
  it('preserves auth on a graceful shutdown — the regression that matters', () => {
    expect(classifyConnectionClose(undefined, true)).toBe('preserve');
    expect(classifyConnectionClose(428, true)).toBe('preserve');
  });

  it('wipes only on a real logout, even mid-shutdown', () => {
    expect(classifyConnectionClose(LOGGED_OUT, false)).toBe('wipe');
    expect(classifyConnectionClose(LOGGED_OUT, true)).toBe('wipe');
  });

  it('reconnects on an ordinary drop', () => {
    expect(classifyConnectionClose(428, false)).toBe('reconnect');
    expect(classifyConnectionClose(undefined, false)).toBe('reconnect');
  });
});

describe('buildInboundAttachment', () => {
  it('carries bytes the container can read, not a host path', () => {
    return buildInboundAttachment('image', 'photo.jpg', 'image/jpeg', Buffer.from('hello')).then((entry) => {
      expect(entry.data).toBe(Buffer.from('hello').toString('base64'));
      expect(entry.size).toBe(5);
      expect(entry).not.toHaveProperty('localPath');
    });
  });

  it('falls back to a type-derived mime so preprocessing can still dispatch', async () => {
    expect((await buildInboundAttachment('audio', 'n.ogg', undefined, Buffer.from('x'))).mimeType).toBe('audio/ogg');
    expect((await buildInboundAttachment('image', 'p.jpg', undefined, Buffer.from('x'))).mimeType).toBe('image/jpeg');
    expect((await buildInboundAttachment('document', 'd.bin', undefined, Buffer.from('x'))).mimeType).toBe(
      'application/octet-stream',
    );
  });

  it('transcribes a voice note', async () => {
    transcribeAudio.mockResolvedValue('hello there');
    const entry = await buildInboundAttachment('audio', 'note.ogg', 'audio/ogg', Buffer.from('x'));
    expect(entry.transcription).toBe('hello there');
  });

  it('extracts a PDF', async () => {
    extractPdfText.mockResolvedValue('page one');
    const entry = await buildInboundAttachment('document', 'doc.pdf', 'application/pdf', Buffer.from('x'));
    expect(entry.extractedText).toBe('page one');
  });

  it('still delivers the bytes when preprocessing fails', async () => {
    transcribeAudio.mockRejectedValue(new Error('whisper down'));
    const entry = await buildInboundAttachment('audio', 'note.ogg', 'audio/ogg', Buffer.from('x'));
    expect(entry.transcriptionError).toBe('whisper down');
    expect(entry.data).toBe(Buffer.from('x').toString('base64'));
  });
});
