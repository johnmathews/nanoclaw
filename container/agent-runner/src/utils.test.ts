import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sanitizeFilename,
  generateFallbackName,
  parseTranscript,
  formatTranscriptMarkdown,
  formatSlashCommandError,
  writeOutput,
  writeProgress,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  PROGRESS_START_MARKER,
  PROGRESS_END_MARKER,
  TOOL_LABELS,
  type ParsedMessage,
  type ContainerOutput,
} from './utils.js';

// ─── sanitizeFilename ───────────────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('lowercases input', () => {
    expect(sanitizeFilename('Hello World')).toBe('hello-world');
  });

  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(sanitizeFilename('file@name#here')).toBe('file-name-here');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeFilename('---trimmed---')).toBe('trimmed');
  });

  it('limits to 50 chars', () => {
    const long = 'a'.repeat(100);
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toBe('a'.repeat(50));
  });

  it('handles empty string', () => {
    expect(sanitizeFilename('')).toBe('');
  });

  it('handles all-special-character input', () => {
    expect(sanitizeFilename('!@#$%^&*()')).toBe('');
  });

  it('collapses consecutive special chars into a single hyphen', () => {
    expect(sanitizeFilename('hello   world')).toBe('hello-world');
  });
});

// ─── generateFallbackName ───────────────────────────────────────────────────

describe('generateFallbackName', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns string matching conversation-HHMM pattern', () => {
    const result = generateFallbackName();
    expect(result).toMatch(/^conversation-\d{4}$/);
  });

  it('uses zero-padded hours and minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 1, 3, 7, 0));
    expect(generateFallbackName()).toBe('conversation-0307');
    vi.useRealTimers();
  });

  it('handles midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 1, 0, 0, 0));
    expect(generateFallbackName()).toBe('conversation-0000');
    vi.useRealTimers();
  });

  it('handles 23:59', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 1, 23, 59, 0));
    expect(generateFallbackName()).toBe('conversation-2359');
    vi.useRealTimers();
  });
});

// ─── parseTranscript ────────────────────────────────────────────────────────

describe('parseTranscript', () => {
  it('parses user messages with string content', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'Hello there' } });
    const result = parseTranscript(line);
    expect(result).toEqual([{ role: 'user', content: 'Hello there' }]);
  });

  it('parses user messages with array content (multimodal)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ text: 'Part 1' }, { text: ' Part 2' }] },
    });
    const result = parseTranscript(line);
    expect(result).toEqual([{ role: 'user', content: 'Part 1 Part 2' }]);
  });

  it('parses assistant messages (filters text blocks)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', name: 'Read' },
          { type: 'text', text: ' world' },
        ],
      },
    });
    const result = parseTranscript(line);
    expect(result).toEqual([{ role: 'assistant', content: 'Hello world' }]);
  });

  it('skips non-user/assistant entries', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: '123' }),
      JSON.stringify({ type: 'user', message: { content: 'Hello' } }),
    ].join('\n');
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('skips empty lines', () => {
    const input = '\n\n' + JSON.stringify({ type: 'user', message: { content: 'Test' } }) + '\n\n';
    const result = parseTranscript(input);
    expect(result).toHaveLength(1);
  });

  it('handles malformed JSON lines gracefully (no throw)', () => {
    const input = 'not json at all\n{invalid json}\n' +
      JSON.stringify({ type: 'user', message: { content: 'Valid' } });
    const result = parseTranscript(input);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Valid');
  });

  it('returns empty array for empty input', () => {
    expect(parseTranscript('')).toEqual([]);
  });

  it('handles mixed valid/invalid lines', () => {
    const lines = [
      '{bad}',
      JSON.stringify({ type: 'user', message: { content: 'One' } }),
      'also bad',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Two' }] } }),
      '',
    ].join('\n');
    const result = parseTranscript(lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'user', content: 'One' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'Two' });
  });

  it('skips user messages with empty text content', () => {
    const line = JSON.stringify({ type: 'user', message: { content: '' } });
    const result = parseTranscript(line);
    expect(result).toEqual([]);
  });

  it('handles array content blocks with missing text field', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'image' }, { text: 'hello' }] },
    });
    const result = parseTranscript(line);
    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

// ─── formatTranscriptMarkdown ───────────────────────────────────────────────

describe('formatTranscriptMarkdown', () => {
  const sampleMessages: ParsedMessage[] = [
    { role: 'user', content: 'Hi there' },
    { role: 'assistant', content: 'Hello!' },
  ];

  it('includes title in heading', () => {
    const md = formatTranscriptMarkdown(sampleMessages, 'My Topic');
    expect(md).toContain('# My Topic');
  });

  it('falls back to "Conversation" when no title', () => {
    const md = formatTranscriptMarkdown(sampleMessages);
    expect(md).toContain('# Conversation');
  });

  it('falls back to "Conversation" when title is null', () => {
    const md = formatTranscriptMarkdown(sampleMessages, null);
    expect(md).toContain('# Conversation');
  });

  it('labels user messages as "User"', () => {
    const md = formatTranscriptMarkdown(sampleMessages);
    expect(md).toContain('**User**: Hi there');
  });

  it('labels assistant messages with assistantName', () => {
    const md = formatTranscriptMarkdown(sampleMessages, null, 'Nano');
    expect(md).toContain('**Nano**: Hello!');
  });

  it('labels assistant messages as "Assistant" when no assistantName', () => {
    const md = formatTranscriptMarkdown(sampleMessages);
    expect(md).toContain('**Assistant**: Hello!');
  });

  it('truncates messages over 2000 chars with "..."', () => {
    const longContent = 'x'.repeat(3000);
    const messages: ParsedMessage[] = [{ role: 'user', content: longContent }];
    const md = formatTranscriptMarkdown(messages);
    expect(md).toContain('x'.repeat(2000) + '...');
    expect(md).not.toContain('x'.repeat(2001));
  });

  it('includes archive timestamp', () => {
    const md = formatTranscriptMarkdown(sampleMessages);
    expect(md).toContain('Archived:');
  });

  it('includes horizontal rule separator', () => {
    const md = formatTranscriptMarkdown(sampleMessages);
    expect(md).toContain('---');
  });
});

// ─── writeOutput ────────────────────────────────────────────────────────────

describe('writeOutput', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wraps JSON in OUTPUT_START/END markers', () => {
    const output: ContainerOutput = { status: 'success', result: 'done' };
    writeOutput(output);
    expect(logs[0]).toBe(OUTPUT_START_MARKER);
    expect(logs[1]).toBe(JSON.stringify(output));
    expect(logs[2]).toBe(OUTPUT_END_MARKER);
  });

  it('outputs exactly 3 lines', () => {
    writeOutput({ status: 'error', result: null, error: 'fail' });
    expect(logs).toHaveLength(3);
  });

  it('includes optional fields in JSON', () => {
    const output: ContainerOutput = {
      status: 'success',
      result: null,
      newSessionId: 'sess-123',
    };
    writeOutput(output);
    const parsed = JSON.parse(logs[1]);
    expect(parsed.newSessionId).toBe('sess-123');
  });
});

// ─── writeProgress ──────────────────────────────────────────────────────────

describe('writeProgress', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps known tool names to friendly labels', () => {
    writeProgress('Read');
    const payload = JSON.parse(logs[1]);
    expect(payload.text).toBe('Reading files');

    logs.length = 0;
    writeProgress('Bash');
    const payload2 = JSON.parse(logs[1]);
    expect(payload2.text).toBe('Running command');
  });

  it('maps all defined tool labels correctly', () => {
    for (const [tool, label] of Object.entries(TOOL_LABELS)) {
      logs.length = 0;
      writeProgress(tool);
      const payload = JSON.parse(logs[1]);
      expect(payload.text).toBe(label);
    }
  });

  it('handles MCP tools (mcp__server__tool)', () => {
    writeProgress('mcp__nanoclaw__send_message');
    const payload = JSON.parse(logs[1]);
    expect(payload.text).toBe('Using nanoclaw: send_message');
  });

  it('handles MCP tools with double underscores in tool name', () => {
    writeProgress('mcp__server__tool__subtool');
    const payload = JSON.parse(logs[1]);
    expect(payload.text).toBe('Using server: tool__subtool');
  });

  it('falls back to "Using {toolName}" for unknown tools', () => {
    writeProgress('CustomTool');
    const payload = JSON.parse(logs[1]);
    expect(payload.text).toBe('Using CustomTool');
  });

  it('wraps output in PROGRESS_START/END markers', () => {
    writeProgress('Read');
    expect(logs[0]).toBe(PROGRESS_START_MARKER);
    expect(logs[2]).toBe(PROGRESS_END_MARKER);
  });

  it('outputs exactly 3 lines', () => {
    writeProgress('Bash');
    expect(logs).toHaveLength(3);
  });
});

// ─── formatSlashCommandError ──────────────────────────────────────────────────

describe('formatSlashCommandError', () => {
  it('returns error unchanged when no commands available', () => {
    expect(formatSlashCommandError('Unknown skill: skills', [])).toBe('Unknown skill: skills');
  });

  it('appends available commands to error message', () => {
    const result = formatSlashCommandError('Unknown skill: skills', ['/compact', '/clear', '/done']);
    expect(result).toBe('Unknown skill: skills\n\nAvailable commands: /compact, /clear, /done');
  });

  it('uses fallback error text when original is empty', () => {
    const result = formatSlashCommandError('Session command failed.', ['/compact']);
    expect(result).toContain('Available commands: /compact');
  });
});
