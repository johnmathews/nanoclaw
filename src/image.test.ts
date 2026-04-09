import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// Mock sharp
vi.mock('sharp', () => {
  const mockSharp = vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-image-data')),
  }));
  return { default: mockSharp };
});

vi.mock('fs');

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  processImage,
  parseImageReferences,
  isImageMessage,
  loadImageData,
  cleanupImageFiles,
  inferMediaType,
} from './image.js';

describe('image processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  describe('isImageMessage', () => {
    it('returns true for image messages', () => {
      const msg = { message: { imageMessage: { mimetype: 'image/jpeg' } } };
      expect(isImageMessage(msg as any)).toBe(true);
    });

    it('returns false for non-image messages', () => {
      const msg = { message: { conversation: 'hello' } };
      expect(isImageMessage(msg as any)).toBe(false);
    });

    it('returns false for null message', () => {
      const msg = { message: null };
      expect(isImageMessage(msg as any)).toBe(false);
    });
  });

  describe('processImage', () => {
    it('resizes and saves image, returns content string', async () => {
      const buffer = Buffer.from('raw-image-data');
      const result = await processImage(
        buffer,
        '/tmp/groups/test',
        'Check this out',
      );

      expect(result).not.toBeNull();
      expect(result!.content).toMatch(
        /^\[Image: attachments\/img-\d+-[a-z0-9]+\.jpg\] Check this out$/,
      );
      expect(result!.relativePath).toMatch(
        /^attachments\/img-\d+-[a-z0-9]+\.jpg$/,
      );
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('returns content without caption when none provided', async () => {
      const buffer = Buffer.from('raw-image-data');
      const result = await processImage(buffer, '/tmp/groups/test', '');

      expect(result).not.toBeNull();
      expect(result!.content).toMatch(
        /^\[Image: attachments\/img-\d+-[a-z0-9]+\.jpg\]$/,
      );
    });

    it('returns null on empty buffer', async () => {
      const result = await processImage(
        Buffer.alloc(0),
        '/tmp/groups/test',
        '',
      );

      expect(result).toBeNull();
    });

    it('returns null on null buffer', async () => {
      const result = await processImage(null as any, '/tmp/groups/test', '');
      expect(result).toBeNull();
    });

    it('creates attachments directory with recursive flag', async () => {
      const buffer = Buffer.from('raw-image-data');
      await processImage(buffer, '/tmp/groups/test', '');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        '/tmp/groups/test/attachments',
        { recursive: true },
      );
    });

    it('writes resized buffer to correct path', async () => {
      const buffer = Buffer.from('raw-image-data');
      await processImage(buffer, '/tmp/groups/test', '');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/tmp\/groups\/test\/attachments\/img-\d+-[a-z0-9]+\.jpg$/,
        ),
        Buffer.from('resized-image-data'),
      );
    });
  });

  describe('parseImageReferences', () => {
    it('extracts image paths from message content', () => {
      const messages = [
        { content: '[Image: attachments/img-123.jpg] hello' },
        { content: 'plain text' },
        { content: '[Image: attachments/img-456.jpg]' },
      ];
      const refs = parseImageReferences(messages as any);

      expect(refs).toEqual([
        { relativePath: 'attachments/img-123.jpg', mediaType: 'image/jpeg' },
        { relativePath: 'attachments/img-456.jpg', mediaType: 'image/jpeg' },
      ]);
    });

    it('returns empty array when no images', () => {
      const messages = [{ content: 'just text' }];
      expect(parseImageReferences(messages as any)).toEqual([]);
    });

    it('extracts multiple images from a single message', () => {
      const messages = [
        {
          content:
            '[Image: attachments/img-1.jpg] first [Image: attachments/img-2.jpg] second',
        },
      ];
      const refs = parseImageReferences(messages as any);
      expect(refs).toHaveLength(2);
    });

    it('matches Slack image format [Image attached: ...]', () => {
      const messages = [
        { content: '[Image attached: attachments/img-SLACK1.png]' },
      ];
      const refs = parseImageReferences(messages as any);
      expect(refs).toHaveLength(1);
      expect(refs[0].relativePath).toBe('attachments/img-SLACK1.png');
    });

    it('infers correct media type from file extension', () => {
      const messages = [
        { content: '[Image: attachments/photo.jpg]' },
        { content: '[Image attached: attachments/screenshot.png]' },
        { content: '[Image attached: attachments/animation.gif]' },
        { content: '[Image attached: attachments/photo.webp]' },
      ];
      const refs = parseImageReferences(messages as any);
      expect(refs).toEqual([
        { relativePath: 'attachments/photo.jpg', mediaType: 'image/jpeg' },
        {
          relativePath: 'attachments/screenshot.png',
          mediaType: 'image/png',
        },
        {
          relativePath: 'attachments/animation.gif',
          mediaType: 'image/gif',
        },
        { relativePath: 'attachments/photo.webp', mediaType: 'image/webp' },
      ]);
    });

    it('defaults to image/jpeg for unknown extensions', () => {
      const messages = [{ content: '[Image: attachments/photo.bmp]' }];
      const refs = parseImageReferences(messages as any);
      expect(refs[0].mediaType).toBe('image/jpeg');
    });

    it('handles empty content gracefully', () => {
      const messages = [{ content: '' }];
      expect(parseImageReferences(messages as any)).toEqual([]);
    });

    it('does not match malformed references', () => {
      const messages = [
        { content: '[Image: ]' },
        { content: '[Image: not-attachments/img.jpg]' },
        { content: 'Image: attachments/img.jpg' },
      ];
      expect(parseImageReferences(messages as any)).toEqual([]);
    });
  });

  describe('inferMediaType', () => {
    it('maps common image extensions correctly', () => {
      expect(inferMediaType('photo.jpg')).toBe('image/jpeg');
      expect(inferMediaType('photo.jpeg')).toBe('image/jpeg');
      expect(inferMediaType('screenshot.png')).toBe('image/png');
      expect(inferMediaType('animation.gif')).toBe('image/gif');
      expect(inferMediaType('modern.webp')).toBe('image/webp');
    });

    it('defaults to image/jpeg for unknown extensions', () => {
      expect(inferMediaType('file.bmp')).toBe('image/jpeg');
      expect(inferMediaType('file.tiff')).toBe('image/jpeg');
      expect(inferMediaType('noext')).toBe('image/jpeg');
    });

    it('is case-insensitive', () => {
      expect(inferMediaType('PHOTO.JPG')).toBe('image/jpeg');
      expect(inferMediaType('SCREENSHOT.PNG')).toBe('image/png');
    });
  });

  describe('loadImageData', () => {
    it('reads files and returns base64-encoded data', () => {
      const imageBuffer = Buffer.from('raw-image-bytes');
      vi.mocked(fs.readFileSync).mockReturnValue(imageBuffer);
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      const attachments = [
        { relativePath: 'attachments/img-1.jpg', mediaType: 'image/jpeg' },
        { relativePath: 'attachments/img-2.png', mediaType: 'image/png' },
      ];

      const result = loadImageData(attachments, '/groups/test');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        mediaType: 'image/jpeg',
        data: imageBuffer.toString('base64'),
      });
      expect(result[1]).toEqual({
        mediaType: 'image/png',
        data: imageBuffer.toString('base64'),
      });
    });

    it('deletes each file after reading it into memory', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('data'));
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      const attachments = [
        { relativePath: 'attachments/img-1.jpg', mediaType: 'image/jpeg' },
        { relativePath: 'attachments/img-2.jpg', mediaType: 'image/jpeg' },
      ];

      loadImageData(attachments, '/groups/test');

      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/groups/test/attachments/img-1.jpg',
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/groups/test/attachments/img-2.jpg',
      );
    });

    it('still returns data even if delete fails', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('data'));
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('EPERM');
      });

      const attachments = [
        { relativePath: 'attachments/img-1.jpg', mediaType: 'image/jpeg' },
      ];

      const result = loadImageData(attachments, '/groups/test');
      expect(result).toHaveLength(1);
    });

    it('reads from correct absolute paths', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('data'));
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      const attachments = [
        { relativePath: 'attachments/img-123.jpg', mediaType: 'image/jpeg' },
      ];

      loadImageData(attachments, '/srv/apps/nanoclaw/groups/main');

      expect(fs.readFileSync).toHaveBeenCalledWith(
        '/srv/apps/nanoclaw/groups/main/attachments/img-123.jpg',
      );
    });

    it('skips missing files and logs error', () => {
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes('missing')) {
          throw new Error('ENOENT');
        }
        return Buffer.from('data');
      });

      const attachments = [
        { relativePath: 'attachments/exists.jpg', mediaType: 'image/jpeg' },
        { relativePath: 'attachments/missing.jpg', mediaType: 'image/jpeg' },
        {
          relativePath: 'attachments/also-exists.jpg',
          mediaType: 'image/jpeg',
        },
      ];

      const result = loadImageData(attachments, '/groups/test');

      expect(result).toHaveLength(2);
      expect(result[0].mediaType).toBe('image/jpeg');
      expect(result[1].mediaType).toBe('image/jpeg');
    });

    it('returns empty array for empty input', () => {
      const result = loadImageData([], '/groups/test');
      expect(result).toHaveLength(0);
    });

    it('returns empty array when all files are missing', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const attachments = [
        { relativePath: 'attachments/gone.jpg', mediaType: 'image/jpeg' },
      ];

      const result = loadImageData(attachments, '/groups/test');
      expect(result).toHaveLength(0);
    });
  });

  describe('cleanupImageFiles', () => {
    it('deletes files without reading them', () => {
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      const attachments = [
        { relativePath: 'attachments/img-1.jpg', mediaType: 'image/jpeg' },
        { relativePath: 'attachments/img-2.png', mediaType: 'image/png' },
      ];

      cleanupImageFiles(attachments, '/groups/test');

      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/groups/test/attachments/img-1.jpg',
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/groups/test/attachments/img-2.png',
      );
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('handles missing files gracefully', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const attachments = [
        { relativePath: 'attachments/gone.jpg', mediaType: 'image/jpeg' },
      ];

      expect(() =>
        cleanupImageFiles(attachments, '/groups/test'),
      ).not.toThrow();
    });

    it('handles empty input', () => {
      cleanupImageFiles([], '/groups/test');
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
