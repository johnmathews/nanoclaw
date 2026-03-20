/**
 * Extracted utility functions from the agent-runner.
 */

import fs from 'fs';

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RateLimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resets_at?: number;
  rate_limit_type?: string;
  utilization?: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  rateLimits?: RateLimitSnapshot[];
}

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
export const PROGRESS_START_MARKER = '---NANOCLAW_PROGRESS_START---';
export const PROGRESS_END_MARKER = '---NANOCLAW_PROGRESS_END---';

export const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading files',
  Write: 'Writing code',
  Edit: 'Editing code',
  Bash: 'Running command',
  Grep: 'Searching codebase',
  Glob: 'Searching for files',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching web content',
  Task: 'Managing tasks',
  TaskOutput: 'Reading task output',
  TodoWrite: 'Updating todos',
  NotebookEdit: 'Editing notebook',
  TeamCreate: 'Starting subagent',
  SendMessage: 'Messaging subagent',
  ToolSearch: 'Looking up tools',
  Skill: 'Running skill',
};

export function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

export function writeProgress(toolName: string): void {
  // Map tool name to a friendly label
  let label: string;
  if (toolName.startsWith('mcp__')) {
    // MCP tools: mcp__server__tool_name → use the tool part
    const parts = toolName.split('__');
    const server = parts[1] || '';
    const tool = parts.slice(2).join('__');
    label = `Using ${server}: ${tool}`;
  } else {
    label = TOOL_LABELS[toolName] || `Using ${toolName}`;
  }

  console.log(PROGRESS_START_MARKER);
  console.log(JSON.stringify({ text: label }));
  console.log(PROGRESS_END_MARKER);
}

export function formatSlashCommandError(errorText: string, availableCommands: string[]): string {
  if (availableCommands.length === 0) return errorText;
  return `${errorText}\n\nAvailable commands: ${availableCommands.join(', ')}`;
}

/** Built-in SDK slash commands (stable across versions). */
const SDK_COMMANDS = ['/clear', '/compact', '/done'];

/** Host-side intercepted commands that don't go through the SDK. */
const HOST_COMMANDS = ['/usage'];

/**
 * Discover installed skill commands from the skills directory.
 * Each subdirectory under the skills path is a skill (e.g., 'status' → '/status').
 */
export function discoverSkillCommands(skillsDir: string): string[] {
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => `/${e.name}`);
  } catch {
    return [];
  }
}

export function formatSkillsList(sdkCommands: string[], skillsDir?: string): string {
  const skillCommands = skillsDir ? discoverSkillCommands(skillsDir) : [];
  // Merge all sources, deduplicate
  const all = new Set([...SDK_COMMANDS, ...HOST_COMMANDS, ...sdkCommands, ...skillCommands]);
  const sorted = [...all].sort();

  const lines = sorted.map((cmd) => `• ${cmd}`);
  return `*Available Commands*\n\n${lines.join('\n')}`;
}

export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

export function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}
