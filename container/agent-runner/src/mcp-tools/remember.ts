/**
 * remember MCP tool (learning & memory feature #1).
 *
 * Curates two budgeted memory files that are injected into your system prompt
 * every session: MEMORY.md (operational lessons) and USER.md (user profile).
 *
 * The container can't hold the authoritative file text (the composed CLAUDE.md
 * is read-only and the host is the single writer of the source files), so this
 * is a round-trip tool — same shape as ask_user_question: write a `remember`
 * system action to outbound.db, poll inbound.db for the host's reply.
 *
 * At the budget limit the host rejects the edit and returns the current entries
 * so you can consolidate or remove before adding. That pressure is the point —
 * keep memory small and high-signal.
 */
import { findResponseById, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const POLL_TIMEOUT_MS = 30_000;

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `rem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RememberFrame {
  ok: boolean;
  target: string;
  op: string;
  error?: string;
  current?: string;
  chars?: number;
  budget?: number;
}

export const remember: McpToolDefinition = {
  tool: {
    name: 'remember',
    description:
      "Curate your persistent memory. Two targets: 'memory' (MEMORY.md — operational lessons, conventions, how-to knowledge) and 'user' (USER.md — durable facts about the user: preferences, identity, goals). Three ops: 'add' (append a new one-line entry — pass `text`), 'replace' (pass `match` = a unique substring of the entry to change + `replacement`), 'remove' (pass `match` = a unique substring of the entry to delete). " +
      'Each file has a hard character budget; if an add/replace would exceed it the tool returns the current entries so you can consolidate or remove first. ' +
      "DON'T store: trivia, anything web-searchable, large code blocks, or session-only ephemera. DO store: corrections, user preferences, durable conventions, and lessons that will matter next session. Keep entries short and atomic — one fact per entry.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', enum: ['memory', 'user'], description: "Which file: 'memory' or 'user'" },
        op: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'The operation' },
        text: { type: 'string', description: 'op=add: the new entry text (one short fact)' },
        match: {
          type: 'string',
          description: 'op=replace|remove: a substring that uniquely identifies exactly one existing entry',
        },
        replacement: { type: 'string', description: 'op=replace: the new entry text' },
      },
      required: ['target', 'op'],
    },
  },
  async handler(args) {
    const target = args.target as string;
    const op = args.op as string;
    if (target !== 'memory' && target !== 'user') return err("target must be 'memory' or 'user'");
    if (op !== 'add' && op !== 'replace' && op !== 'remove') return err("op must be 'add', 'replace', or 'remove'");
    if (op === 'add' && !(args.text as string)?.trim()) return err('add requires `text`');
    if ((op === 'replace' || op === 'remove') && !(args.match as string)?.trim()) {
      return err(`${op} requires \`match\` (a unique substring of the entry)`);
    }
    if (op === 'replace' && !(args.replacement as string)?.trim()) return err('replace requires `replacement`');

    const requestId = generateId();
    const r = getSessionRouting();

    writeMessageOut({
      id: requestId,
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        action: 'remember',
        requestId,
        target,
        op,
        text: (args.text as string) ?? null,
        match: (args.match as string) ?? null,
        replacement: (args.replacement as string) ?? null,
      }),
    });

    log(`remember: ${target}/${op} (${requestId})`);

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const resp = findResponseById(`rem-resp-${requestId}`);
      if (resp) {
        markCompleted([resp.id]);
        const frame = JSON.parse(resp.content).frame as RememberFrame;
        if (frame.ok) {
          return ok(`Saved to ${target} (${frame.chars}/${frame.budget} chars used).`);
        }
        if (frame.error === 'budget_exceeded') {
          return err(
            `${target} is at its ${frame.budget}-char budget (${frame.chars} used). Consolidate or remove an entry before adding. Current entries:\n\n${frame.current ?? ''}`,
          );
        }
        if (frame.error === 'no_match' || frame.error === 'ambiguous_match') {
          return err(
            `${frame.error === 'no_match' ? 'No entry matched' : 'More than one entry matched'} that substring. Current entries:\n\n${frame.current ?? ''}`,
          );
        }
        return err(`remember failed: ${frame.error ?? 'unknown'}`);
      }
      await sleep(500);
    }

    log(`remember timeout: ${requestId}`);
    return err('remember timed out waiting for the host (30s).');
  },
};

registerTools([remember]);
