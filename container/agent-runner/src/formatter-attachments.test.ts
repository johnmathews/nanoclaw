/**
 * Voice and PDF attachment rendering.
 *
 * There is no speech model and no pdftotext in the container, so if the host's
 * preprocessed text is not rendered inline the agent's only options are "a
 * voice note arrived" plus a path it would have to decode itself. A failure
 * has to surface too: silently dropping the reason is how a user gets ignored
 * after sending a voice message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './mailbox/sqlite/connection.js';
import { formatMessages } from './formatter.js';
import type { MessageInRow } from './mailbox/sqlite/connection.js';

function row(attachments: unknown[]): MessageInRow {
  return {
    id: 'm-1',
    seq: 2,
    kind: 'chat',
    timestamp: '2026-11-04T12:00:00.000Z',
    status: 'pending',
    platform_id: 'C1',
    channel_type: 'slack',
    thread_id: null,
    content: JSON.stringify({ text: 'see attached', sender: 'John', attachments }),
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 0,
    trigger: 1,
    source_session_id: null,
    on_wake: 0,
  } as unknown as MessageInRow;
}

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('voice attachments', () => {
  it('renders the transcription inline', () => {
    const out = formatMessages([row([{ type: 'audio', name: 'note.ogg', transcription: 'buy milk' }])]);
    expect(out).toContain('[voice: note.ogg]');
    expect(out).toContain('Transcription: buy milk');
  });

  it('surfaces a transcription failure rather than staying silent', () => {
    const out = formatMessages([row([{ type: 'audio', name: 'note.ogg', transcriptionError: 'whisper down' }])]);
    expect(out).toContain('Transcription failed: whisper down');
  });

  it('keeps the saved path alongside the transcript when there is one', () => {
    const out = formatMessages([
      row([{ type: 'audio', name: 'note.ogg', localPath: 'inbox/m-1/note.ogg', transcription: 'hi' }]),
    ]);
    expect(out).toContain('/workspace/inbox/m-1/note.ogg');
    expect(out).toContain('Transcription: hi');
  });
});

describe('PDF attachments', () => {
  it('renders extracted text in a CDATA section', () => {
    const out = formatMessages([row([{ type: 'document', name: 'doc.pdf', extractedText: 'page one' }])]);
    expect(out).toContain('[pdf: doc.pdf]');
    expect(out).toContain('<pdf_text><![CDATA[page one]]></pdf_text>');
  });

  it('neutralizes a CDATA terminator inside the document', () => {
    // A PDF containing "]]>" would otherwise close the section early and the
    // remainder would be parsed as markup.
    const out = formatMessages([row([{ type: 'document', name: 'x.pdf', extractedText: 'before ]]> after' }])]);
    expect(out).toContain('before ]]&gt; after');
    expect(out).not.toContain('before ]]> after');
  });

  it('surfaces an extraction failure', () => {
    const out = formatMessages([row([{ type: 'document', name: 'x.pdf', pdfExtractionError: 'pdftotext missing' }])]);
    expect(out).toContain('PDF extraction failed: pdftotext missing');
  });
});

describe('ordinary attachments', () => {
  it('still renders a plain file by path', () => {
    const out = formatMessages([row([{ type: 'image', name: 'p.jpg', localPath: 'inbox/m-1/p.jpg' }])]);
    expect(out).toContain('[image: p.jpg — saved to /workspace/inbox/m-1/p.jpg]');
  });
});
