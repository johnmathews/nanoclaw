/**
 * Fork additions to the bridge: reaction and button inbound synthesis, and
 * host-side voice/PDF preprocessing.
 *
 * The preprocessing contract is the interesting one — a failure must land on
 * the entry as an error field rather than throwing, because the caller is in
 * the middle of building an inbound message and a throw would drop the whole
 * message rather than just its transcript.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transcribeAudio = vi.fn();
const extractPdfText = vi.fn();
vi.mock('../transcription.js', () => ({
  isTranscribableMime: (m: string) => m.startsWith('audio/'),
  transcribeAudio: (...a: unknown[]) => transcribeAudio(...a),
  TranscriptionError: class TranscriptionError extends Error {},
}));
vi.mock('../pdf-extract.js', () => ({
  isPdfMime: (m: string) => m === 'application/pdf',
  extractPdfText: (...a: unknown[]) => extractPdfText(...a),
  PdfExtractionError: class PdfExtractionError extends Error {},
}));

import { buildNcv2Inbound, buildReactionInbound, maybePdfExtract, maybeTranscribe } from './chat-sdk-bridge.js';

const ids = { now: () => new Date('2026-11-04T12:00:00.000Z'), idGen: () => 'fixed-id' };

beforeEach(() => vi.clearAllMocks());

describe('buildReactionInbound', () => {
  const base = {
    emoji: ':tada:',
    rawEmoji: 'tada',
    added: true,
    targetMessageId: 'msg-1',
    threadId: 'slack:C1:111',
    userId: 'U1',
    userName: 'John',
    ...ids,
  };

  it('keeps the structured payload query_reactions filters on', () => {
    const inbound = buildReactionInbound(base);
    const content = inbound.content as Record<string, any>;
    expect(content.reaction).toEqual({
      emoji: ':tada:',
      rawEmoji: 'tada',
      added: true,
      targetMessageId: 'msg-1',
      threadId: 'slack:C1:111',
      userId: 'U1',
    });
  });

  it('is not a mention, so it never wakes a trigger-required channel on its own', () => {
    expect(buildReactionInbound(base).isMention).toBe(false);
  });

  it('distinguishes adding from removing in the readable text', () => {
    expect(String((buildReactionInbound(base).content as Record<string, any>).text)).toContain('reacted');
    expect(String((buildReactionInbound({ ...base, added: false }).content as Record<string, any>).text)).toContain(
      'removed reaction',
    );
  });
});

describe('buildNcv2Inbound', () => {
  const base = { actionId: 'approve', value: 'yes', userId: 'U1', userName: 'John', messageId: 'm-1', ...ids };

  it('is a mention — a click is a direct address and should wake the agent', () => {
    expect(buildNcv2Inbound(base).isMention).toBe(true);
  });

  it('carries the action payload and omits an empty value from the text', () => {
    const withValue = buildNcv2Inbound(base).content as Record<string, any>;
    expect(withValue.action).toEqual({ actionId: 'approve', value: 'yes', userId: 'U1', messageId: 'm-1' });
    expect(String(withValue.text)).toContain('value="yes"');
    const noValue = buildNcv2Inbound({ ...base, value: '' }).content as Record<string, any>;
    expect(String(noValue.text)).not.toContain('value=');
  });
});

describe('maybeTranscribe', () => {
  it('stamps a transcript onto an audio entry', async () => {
    transcribeAudio.mockResolvedValue({ text: 'hello there' });
    const entry: Record<string, unknown> = { mimeType: 'audio/ogg', name: 'note.ogg' };
    await maybeTranscribe(entry, Buffer.from('x'));
    expect(entry.transcription).toBe('hello there');
  });

  it('records the failure instead of throwing, so the message still lands', async () => {
    transcribeAudio.mockRejectedValue(new Error('whisper down'));
    const entry: Record<string, unknown> = { mimeType: 'audio/ogg', name: 'note.ogg' };
    await expect(maybeTranscribe(entry, Buffer.from('x'))).resolves.toBeUndefined();
    expect(entry.transcriptionError).toBe('whisper down');
    expect(entry.transcription).toBeUndefined();
  });

  it('ignores a non-audio attachment', async () => {
    const entry: Record<string, unknown> = { mimeType: 'image/png' };
    await maybeTranscribe(entry, Buffer.from('x'));
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(entry.transcription).toBeUndefined();
  });
});

describe('maybePdfExtract', () => {
  it('stamps extracted text onto a PDF entry', async () => {
    extractPdfText.mockResolvedValue('page one');
    const entry: Record<string, unknown> = { mimeType: 'application/pdf', name: 'doc.pdf' };
    await maybePdfExtract(entry, Buffer.from('x'));
    expect(entry.extractedText).toBe('page one');
  });

  it('records the failure instead of throwing', async () => {
    extractPdfText.mockRejectedValue(new Error('pdftotext missing'));
    const entry: Record<string, unknown> = { mimeType: 'application/pdf', name: 'doc.pdf' };
    await expect(maybePdfExtract(entry, Buffer.from('x'))).resolves.toBeUndefined();
    expect(entry.pdfExtractionError).toBe('pdftotext missing');
  });

  it('ignores a non-PDF attachment', async () => {
    const entry: Record<string, unknown> = { mimeType: 'text/plain' };
    await maybePdfExtract(entry, Buffer.from('x'));
    expect(extractPdfText).not.toHaveBeenCalled();
  });
});
