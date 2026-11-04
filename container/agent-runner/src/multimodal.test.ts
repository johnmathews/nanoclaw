/**
 * Image attachment → content block extraction.
 *
 * Two things are load-bearing. The path guard: `localPath` comes from a
 * message that a remote user influenced, and this function reads whatever it
 * points at and ships the bytes to the model — so an escape would exfiltrate
 * container files. And the skip rules: every skip has to leave the attachment
 * still reachable as the formatter's path reference, never silently vanish.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { extractImageBlocks, setWorkspaceRootForTests } from './multimodal.js';
import type { MessageInRow } from './db/messages-in.js';

let root: string;

function row(attachments: unknown[], kind = 'chat'): MessageInRow {
  return {
    id: 'm-1',
    kind,
    timestamp: '2026-11-05T00:00:00.000Z',
    content: JSON.stringify({ text: 'see this', attachments }),
  } as unknown as MessageInRow;
}

function writeImage(rel: string, bytes: number): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes, 7));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-multimodal-'));
  setWorkspaceRootForTests(root);
});
afterEach(() => {
  setWorkspaceRootForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('extractImageBlocks', () => {
  it('returns a base64 image block for a supported image', () => {
    writeImage('inbox/m-1/p.png', 10);
    const blocks = extractImageBlocks([
      row([{ type: 'image', mimeType: 'image/png', localPath: 'inbox/m-1/p.png', name: 'p.png' }]),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect((blocks[0] as { source: { data: string } }).source.data).toBe(Buffer.alloc(10, 7).toString('base64'));
  });

  it('refuses a localPath that escapes the workspace', () => {
    // The guard that matters: this function reads the path and ships the bytes
    // to the model, so an escape is an exfiltration primitive.
    const blocks = extractImageBlocks([
      row([{ type: 'image', mimeType: 'image/png', localPath: '../../../etc/passwd' }]),
    ]);
    expect(blocks).toHaveLength(0);
  });

  it('refuses an absolute localPath', () => {
    expect(
      extractImageBlocks([row([{ type: 'image', mimeType: 'image/png', localPath: '/etc/passwd' }])]),
    ).toHaveLength(0);
  });

  it('skips an unsupported image mime', () => {
    writeImage('inbox/m-1/p.bmp', 10);
    expect(
      extractImageBlocks([row([{ type: 'image', mimeType: 'image/bmp', localPath: 'inbox/m-1/p.bmp' }])]),
    ).toHaveLength(0);
  });

  it('skips a non-image attachment', () => {
    writeImage('inbox/m-1/a.ogg', 10);
    expect(
      extractImageBlocks([row([{ type: 'audio', mimeType: 'audio/ogg', localPath: 'inbox/m-1/a.ogg' }])]),
    ).toHaveLength(0);
  });

  it('skips an oversize image rather than blowing the request', () => {
    writeImage('inbox/m-1/big.png', 5 * 1024 * 1024);
    expect(
      extractImageBlocks([row([{ type: 'image', mimeType: 'image/png', localPath: 'inbox/m-1/big.png' }])]),
    ).toHaveLength(0);
  });

  it('honours the host-side skipMultimodal opt-out', () => {
    writeImage('inbox/m-1/p.png', 10);
    expect(
      extractImageBlocks([
        row([{ type: 'image', mimeType: 'image/png', localPath: 'inbox/m-1/p.png', skipMultimodal: true }]),
      ]),
    ).toHaveLength(0);
  });

  it('skips a missing file without throwing', () => {
    expect(
      extractImageBlocks([row([{ type: 'image', mimeType: 'image/png', localPath: 'inbox/m-1/gone.png' }])]),
    ).toHaveLength(0);
  });

  it('ignores rows that are not chat kinds, and malformed content', () => {
    writeImage('inbox/m-1/p.png', 10);
    const att = [{ type: 'image', mimeType: 'image/png', localPath: 'inbox/m-1/p.png' }];
    expect(extractImageBlocks([row(att, 'task')])).toHaveLength(0);
    expect(extractImageBlocks([{ id: 'x', kind: 'chat', content: 'not json' } as unknown as MessageInRow])).toHaveLength(
      0,
    );
  });

  it('collects across several messages and attachments', () => {
    writeImage('inbox/m-1/a.png', 4);
    writeImage('inbox/m-1/b.jpg', 4);
    const blocks = extractImageBlocks([
      row([{ type: 'image', mimeType: 'image/png', localPath: 'inbox/m-1/a.png' }]),
      row([{ type: 'image', mimeType: 'image/jpeg', localPath: 'inbox/m-1/b.jpg' }]),
    ]);
    expect(blocks).toHaveLength(2);
  });
});
