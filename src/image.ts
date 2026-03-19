import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { WAMessage } from '@whiskeysockets/baileys';

import { logger } from './logger.js';

const MAX_DIMENSION = 1024;
// Matches both WhatsApp [Image: attachments/...] and Slack [Image attached: attachments/...]
const IMAGE_REF_PATTERN = /\[Image(?:\s+attached)?: (attachments\/[^\]]+)\]/g;

export interface ProcessedImage {
  content: string;
  relativePath: string;
}

/** File-path reference extracted from message text. */
export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

/** Ready-to-send image data: base64-encoded, no file dependency. */
export interface LoadedImage {
  mediaType: string;
  data: string; // base64
}

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function inferMediaType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return EXTENSION_MEDIA_TYPES[ext] || 'image/jpeg';
}

export function isImageMessage(msg: WAMessage): boolean {
  return !!msg.message?.imageMessage;
}

export async function processImage(
  buffer: Buffer,
  groupDir: string,
  caption: string,
): Promise<ProcessedImage | null> {
  if (!buffer || buffer.length === 0) return null;

  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const filePath = path.join(attachDir, filename);
  fs.writeFileSync(filePath, resized);

  const relativePath = `attachments/${filename}`;
  const content = caption
    ? `[Image: ${relativePath}] ${caption}`
    : `[Image: ${relativePath}]`;

  return { content, relativePath };
}

export function parseImageReferences(
  messages: Array<{ content: string }>,
): ImageAttachment[] {
  const refs: ImageAttachment[] = [];
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    IMAGE_REF_PATTERN.lastIndex = 0;
    while ((match = IMAGE_REF_PATTERN.exec(msg.content)) !== null) {
      refs.push({
        relativePath: match[1],
        mediaType: inferMediaType(match[1]),
      });
    }
  }
  return refs;
}

/**
 * Reads image files from disk and returns base64-encoded data.
 * This is the critical step: images are loaded into memory on the HOST side
 * before being passed to the container, eliminating any file-based handoff.
 * Missing files are logged and skipped (never silently lost).
 */
export function loadImageData(
  attachments: ImageAttachment[],
  groupDir: string,
): LoadedImage[] {
  const loaded: LoadedImage[] = [];
  for (const att of attachments) {
    const absPath = path.join(groupDir, att.relativePath);
    try {
      const data = fs.readFileSync(absPath).toString('base64');
      loaded.push({ mediaType: att.mediaType, data });
      // Delete immediately after reading — the data is in memory now.
      // This prevents other container runs from cleaning up files that
      // belong to a different message's processing cycle.
      try {
        fs.unlinkSync(absPath);
      } catch {
        // Best-effort cleanup; file may already be gone
      }
    } catch (err) {
      logger.error(
        { path: absPath, err },
        'Image file missing from disk — cannot send to agent',
      );
    }
  }
  return loaded;
}
