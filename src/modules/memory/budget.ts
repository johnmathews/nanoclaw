/**
 * Pure memory-file edit logic for the `remember` tool. No I/O — takes the
 * current file text, applies one operation, and returns either the new text or
 * a typed failure. The host handler (actions.ts) does the file/DB I/O around
 * this; keeping the rules pure makes them exhaustively unit-testable.
 *
 * Model: a memory file is a list of entries, one per non-empty line (Hermes
 * keeps entries short and atomic). `replace`/`remove` match by a UNIQUE
 * substring of a single entry — not exact text — so the agent doesn't have to
 * echo a whole entry to edit it. Budget is a hard char cap on the whole file;
 * `add`/`replace` that would exceed it fail and the caller hands the current
 * entries back so the agent consolidates before retrying.
 */

export type MemoryOp = 'add' | 'replace' | 'remove';

export interface MemoryOpParams {
  /** op=add: the entry text to append. */
  text?: string;
  /** op=replace|remove: unique substring identifying exactly one entry. */
  match?: string;
  /** op=replace: the replacement entry text. */
  replacement?: string;
}

export type MemoryOpError =
  | 'empty_text'
  | 'empty_match'
  | 'empty_replacement'
  | 'no_match'
  | 'ambiguous_match'
  | 'budget_exceeded'
  | 'invalid_op';

export interface MemoryOpResult {
  ok: boolean;
  /** New full file content (op succeeded). */
  content?: string;
  /** Failure code (op rejected). */
  error?: MemoryOpError;
  /** Char count of the resulting/current file — always populated. */
  chars: number;
  budget: number;
}

/** A line is an "entry" if it has non-whitespace content. */
function isEntry(line: string): boolean {
  return line.trim().length > 0;
}

function indicesMatching(lines: string[], match: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isEntry(lines[i]) && lines[i].includes(match)) out.push(i);
  }
  return out;
}

/** Normalize to a clean newline-joined block of entries (no blank lines, single trailing newline-free join). */
function render(lines: string[]): string {
  return lines.filter(isEntry).join('\n');
}

function fail(error: MemoryOpError, current: string, budget: number): MemoryOpResult {
  return { ok: false, error, chars: current.length, budget };
}

function succeed(content: string, budget: number): MemoryOpResult {
  return { ok: true, content, chars: content.length, budget };
}

export function applyMemoryOp(current: string, op: MemoryOp, params: MemoryOpParams, budget: number): MemoryOpResult {
  const lines = current.split('\n');

  if (op === 'add') {
    const text = (params.text ?? '').trim();
    if (!text) return fail('empty_text', current, budget);
    // Entry text is single-line; collapse any embedded newlines so one add =
    // one entry (keeps replace/remove-by-line invariant intact).
    const entry = text.replace(/\s*\n\s*/g, ' ');
    const next = render([...lines, entry]);
    if (next.length > budget) return fail('budget_exceeded', current, budget);
    return succeed(next, budget);
  }

  if (op === 'remove') {
    const match = (params.match ?? '').trim();
    if (!match) return fail('empty_match', current, budget);
    const hits = indicesMatching(lines, match);
    if (hits.length === 0) return fail('no_match', current, budget);
    if (hits.length > 1) return fail('ambiguous_match', current, budget);
    const next = render(lines.filter((_, i) => i !== hits[0]));
    // remove only shrinks — never a budget failure.
    return succeed(next, budget);
  }

  if (op === 'replace') {
    const match = (params.match ?? '').trim();
    if (!match) return fail('empty_match', current, budget);
    const replacement = (params.replacement ?? '').trim();
    if (!replacement) return fail('empty_replacement', current, budget);
    const hits = indicesMatching(lines, match);
    if (hits.length === 0) return fail('no_match', current, budget);
    if (hits.length > 1) return fail('ambiguous_match', current, budget);
    const entry = replacement.replace(/\s*\n\s*/g, ' ');
    const updated = [...lines];
    updated[hits[0]] = entry;
    const next = render(updated);
    if (next.length > budget) return fail('budget_exceeded', current, budget);
    return succeed(next, budget);
  }

  return fail('invalid_op', current, budget);
}
