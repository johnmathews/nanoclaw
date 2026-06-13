import { describe, expect, it } from 'vitest';

import { applyMemoryOp } from './budget.js';

describe('applyMemoryOp — add', () => {
  it('appends a new entry as a line', () => {
    const r = applyMemoryOp('first fact', 'add', { text: 'second fact' }, 2200);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('first fact\nsecond fact');
    expect(r.chars).toBe('first fact\nsecond fact'.length);
  });

  it('adds to an empty file', () => {
    const r = applyMemoryOp('', 'add', { text: 'only fact' }, 2200);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('only fact');
  });

  it('collapses embedded newlines so one add is one entry/line', () => {
    const r = applyMemoryOp('', 'add', { text: 'line one\nline two' }, 2200);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('line one line two');
  });

  it('rejects empty text', () => {
    const r = applyMemoryOp('x', 'add', { text: '   ' }, 2200);
    expect(r).toMatchObject({ ok: false, error: 'empty_text' });
  });

  it('rejects an add that would exceed budget and does not mutate', () => {
    const current = 'a'.repeat(20);
    const r = applyMemoryOp(current, 'add', { text: 'b'.repeat(20) }, 30);
    expect(r).toMatchObject({ ok: false, error: 'budget_exceeded', budget: 30 });
    expect(r.content).toBeUndefined();
    expect(r.chars).toBe(current.length);
  });

  it('allows an add that exactly hits the budget', () => {
    // 'aaa' + '\n' + 'bb' = 6 chars
    const r = applyMemoryOp('aaa', 'add', { text: 'bb' }, 6);
    expect(r.ok).toBe(true);
    expect(r.chars).toBe(6);
  });
});

describe('applyMemoryOp — remove', () => {
  it('removes the uniquely matching entry', () => {
    const r = applyMemoryOp('apple pie\nbanana bread\ncherry cake', 'remove', { match: 'banana' }, 2200);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('apple pie\ncherry cake');
  });

  it('never fails on budget (only shrinks)', () => {
    const r = applyMemoryOp('keep\ndrop this one', 'remove', { match: 'drop' }, 1);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('keep');
  });

  it('rejects when nothing matches', () => {
    const r = applyMemoryOp('a\nb', 'remove', { match: 'zzz' }, 2200);
    expect(r).toMatchObject({ ok: false, error: 'no_match' });
  });

  it('rejects an ambiguous match', () => {
    const r = applyMemoryOp('cat one\ncat two', 'remove', { match: 'cat' }, 2200);
    expect(r).toMatchObject({ ok: false, error: 'ambiguous_match' });
  });

  it('rejects empty match', () => {
    const r = applyMemoryOp('a', 'remove', { match: '' }, 2200);
    expect(r).toMatchObject({ ok: false, error: 'empty_match' });
  });
});

describe('applyMemoryOp — replace', () => {
  it('replaces the uniquely matching entry by substring', () => {
    const r = applyMemoryOp('likes tea\ndislikes noise', 'replace', { match: 'tea', replacement: 'likes coffee now' }, 2200);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('likes coffee now\ndislikes noise');
  });

  it('rejects when the replacement pushes over budget', () => {
    const r = applyMemoryOp('short', 'replace', { match: 'short', replacement: 'x'.repeat(50) }, 10);
    expect(r).toMatchObject({ ok: false, error: 'budget_exceeded' });
  });

  it('rejects ambiguous match', () => {
    const r = applyMemoryOp('foo 1\nfoo 2', 'replace', { match: 'foo', replacement: 'bar' }, 2200);
    expect(r).toMatchObject({ ok: false, error: 'ambiguous_match' });
  });

  it('rejects missing replacement', () => {
    const r = applyMemoryOp('foo', 'replace', { match: 'foo' }, 2200);
    expect(r).toMatchObject({ ok: false, error: 'empty_replacement' });
  });
});

describe('applyMemoryOp — guards', () => {
  it('rejects an unknown op', () => {
    // @ts-expect-error intentionally bad op
    const r = applyMemoryOp('a', 'destroy', {}, 2200);
    expect(r).toMatchObject({ ok: false, error: 'invalid_op' });
  });
});
