/**
 * The pure half of the parse limits: the defaults, how rows are counted, which
 * thrown values are a stack breach, the worker-death refusal, and the heap
 * measure and ceiling the pool's sampler enforces `heapMb` with.
 */

import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import type { ParseResult } from '../src/link-parser.js';
import {
  appliedHeapLimitMb,
  countOutputRows,
  exceedsHeapLimit,
  expandedSize,
  isParseLimitError,
  isParseWorkerDiedError,
  isPerRunParseRefusal,
  isStackOverflow,
  outputBreach,
  ParseLimitError,
  ParseWorkerDiedError,
  resolveParseLimits,
  workerHeapCeilingMb,
} from '../src/parse-limits.js';

const MIB = 1_048_576;

describe('the default parse limits', () => {
  it('allow 30 s of wall clock: the slowest realistic shape (9.3 s) plus a cold parser load under load', () => {
    expect(resolveParseLimits(undefined).timeMs).toBe(30_000);
  });
});

describe('countOutputRows', () => {
  it('counts nested arrays, so one heading over 20,000 subheadings is 20,001 rows', () => {
    const children = Array.from({ length: 20_000 }, (_, index) => ({ level: 2, text: `h${String(index)}`, children: [] }));
    const facts = { links: [], headings: [{ level: 1, text: 'top', children }] };

    expect(countOutputRows(facts)).toBe(20_001);
    expect(countOutputRows(facts)).toBeGreaterThan(resolveParseLimits(undefined).outputRows);
  });

  it('counts arrays inside objects inside arrays, and skips scalars', () => {
    expect(countOutputRows({ a: [{ b: [1, 2] }, 3], c: 'x', d: { e: [4] } })).toBe(5);
  });
});

/**
 * What the store writes for a value: its `JSON.stringify` (the projection's
 * `json` column), every array element and every mapping entry a row.
 *
 * @param value - An acyclic decoded value
 * @returns The rows and bytes of its stored JSON
 */
function storedSize(value: unknown): { rows: number; bytes: number } {
  const json = JSON.stringify(value);
  let rows = 0;
  const pending: unknown[] = [JSON.parse(json)];
  while (pending.length > 0) {
    const next = pending.pop();
    // No spread: a binary's JSON is millions of elements.
    if (typeof next !== 'object' || next === null) continue;
    const children: unknown[] = Array.isArray(next) ? next : Object.values(next);
    rows += children.length;
    for (const child of children) pending.push(child);
  }
  return { rows, bytes: Buffer.byteLength(json) };
}

describe('expandedSize', () => {
  it.each([
    ['a plain mapping', 'title: x\ntags: [a, b]\nmeta: {n: 1, ok: true, none: null}'],
    ['strings JSON escapes and multi-byte text', 'q: "say \\"hi\\"\\n\\ttab"\nu: "été 😀"\nc: "\\u0001"'],
    ['numbers JSON spells differently', 'inf: .inf\nnan: .nan\nneg: -0\nbig: 1e21\nsmall: 0.000001'],
    ['a !!timestamp', 'when: !!timestamp 2001-12-14t21:59:43.10-05:00'],
    ['a !!set and a !!omap, which JSON writes as {}', 's: !!set {x, y}\nm: !!omap [{p: 1}]'],
    ['a !!binary', 'b: !!binary aGVsbG8gd29ybGQgMTIzNDU2Nzg5MA=='],
    ['an aliased anchor, written out at every use', 'a: &x [1, {k: v}]\nb: *x\nc: [*x, *x]'],
    ['empty containers', 'a: []\nb: {}\nc: [[], {}]'],
  ])('measures exactly the rows and bytes the store writes for %s', (_label, source) => {
    const value: unknown = yaml.parse(source);
    const size = expandedSize(value);

    expect({ rows: size.rows, bytes: size.bytes }).toStrictEqual(storedSize(value));
  });

  it('counts a binary as its JSON shape: one row per byte, and the bytes of its digits', () => {
    // `Buffer`'s JSON is {"type":"Buffer","data":[104,105]}: 2 entries + 2 elements.
    expect(expandedSize(Buffer.from('hi'))).toStrictEqual({ rows: 4, bytes: 34, depth: 2 });
  });

  it('refuses the 3.9 MB !!binary probe, which the store writes as 11.8 MB of JSON', () => {
    // Round 3's probe: its base64 counted at its own length (3.9 MB) passed
    // every output cap, and the store wrote three times that.
    const base64 = Buffer.alloc(3 * 1024 * 1024 - 200_000, 255).toString('base64');
    const frontmatter = yaml.parse(`a: !!binary ${base64}`) as Record<string, unknown>;

    expect(outputBreach(withFrontmatter(frontmatter), resolveParseLimits(undefined))).toStrictEqual({ limit: 'outputRows', found: 2_945_728 + 2 + 1 });
    expect(outputBreach(withFrontmatter(frontmatter), resolveParseLimits({ outputRows: 10_000_000 }))).toStrictEqual({
      limit: 'outputBytes',
      found: storedSize(frontmatter).bytes + Buffer.byteLength(JSON.stringify({ links: [], headings: [], estimatedTokenCount: 0 })),
    });
  });

  it('counts every use of an anchor at the anchor\'s full size', () => {
    const once = expandedSize(yaml.parse('a: &x [1, 2, 3]'));
    const thrice = expandedSize(yaml.parse('a: &x [1, 2, 3]\nb: *x\nc: *x'));

    // Each mapping entry is a row, and each element of every use.
    expect(once.rows).toBe(1 + 3);
    expect(thrice.rows).toBe(3 + 9);
    expect(thrice.bytes).toBeGreaterThan(once.bytes * 2);
  });

  it('sizes a billion-laughs shape in time linear in its encoding', () => {
    const levels = ['l0: &l0 [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]'];
    for (let level = 1; level < 9; level += 1) {
      const alias = `*l${String(level - 1)}`;
      levels.push(`l${String(level)}: &l${String(level)} [${Array.from({ length: 10 }, () => alias).join(', ')}]`);
    }
    const value: unknown = yaml.parse(levels.join('\n'), { maxAliasCount: -1 });

    expect(expandedSize(value).rows).toBeGreaterThan(1_000_000_000);
  });

  it('counts a cyclic back-reference once, never forever', () => {
    const size = expandedSize(yaml.parse('a: &x [1, *x]'));

    // One mapping entry, two elements; the back-reference is not expanded.
    expect(size.rows).toBe(3);
    expect(Number.isFinite(size.bytes)).toBe(true);
  });

  it('sizes a list of 200,000 items with no spread', () => {
    expect(expandedSize({ a: Array.from({ length: 200_000 }, () => 1) }).rows).toBe(200_001);
  });

  it('measures depth as JSON nests it: the mapping itself is level 1, and an alias nests its target', () => {
    expect(expandedSize({ title: 'x' }).depth).toBe(1);
    expect(expandedSize({ a: [[1]] }).depth).toBe(3);
    expect(expandedSize(yaml.parse('x: &x [[1]]\ny: {z: *x}')).depth).toBe(4);
  });

  it('gives a cyclic back-reference unbounded depth: no writer of JSON can write it out', () => {
    expect(expandedSize(yaml.parse('a: &x [1, *x]')).depth).toBe(Number.POSITIVE_INFINITY);
  });
});

/**
 * @param frontmatter - A decoded frontmatter value
 * @returns A parse result carrying it and nothing else
 */
function withFrontmatter(frontmatter: Record<string, unknown>): ParseResult {
  return { links: [], headings: [], frontmatter, content: '', sizeBytes: 0, estimatedTokenCount: 0 };
}

/**
 * @param levels - Containers to nest, the mapping included
 * @returns A mapping whose JSON nests exactly `levels` deep
 */
function nestedMapping(levels: number): Record<string, unknown> {
  let inner: unknown = 1;
  for (let level = 1; level < levels; level += 1) inner = [inner];
  return { a: inner };
}

describe('outputBreach on frontmatter depth', () => {
  const limits = resolveParseLimits(undefined);

  it('admits a mapping that nests as deep as SQLite reads JSON (1,000 levels)', () => {
    expect(outputBreach(withFrontmatter(nestedMapping(1000)), limits)).toBeUndefined();
  });

  it('refuses one level deeper as an output breach naming the depth', () => {
    expect(outputBreach(withFrontmatter(nestedMapping(1001)), limits)).toStrictEqual({ limit: 'outputDepth', found: 1001 });
  });

  it('refuses a cyclic anchor, whose depth has no end', () => {
    expect(outputBreach(withFrontmatter(yaml.parse('a: &x [*x]') as Record<string, unknown>), limits)?.limit).toBe('outputDepth');
  });

  it('names the depth found in the refusal', () => {
    const error = new ParseLimitError('outputDepth', 1000, 2000);

    expect(error.bound).toBe('1000 levels of nesting; this document nests 2000');
  });

  it('is never set looser than the store can read', () => {
    expect(() => resolveParseLimits({ outputDepth: 1001 })).toThrow(/outputDepth/);
  });
});

describe('isStackOverflow', () => {
  it('recognises the engine overflow itself', () => {
    let error: unknown;
    const descend = (depth: number): number => descend(depth + 1) + 1;
    try {
      descend(0);
    } catch (thrown) {
      error = thrown;
    }

    expect(isStackOverflow(error)).toBe(true);
  });

  it("recognises yaml's wrapping of an overflow (a YAMLParseError coded RESOURCE_EXHAUSTION)", () => {
    // 8,000 levels overflow the main thread's stack inside yaml's composer,
    // which catches the RangeError and re-raises it as a YAMLParseError.
    const source = `a: ${'['.repeat(8000)}${']'.repeat(8000)}\n`;
    let error: unknown;
    try {
      yaml.parse(source);
    } catch (thrown) {
      error = thrown;
    }

    expect((error as { name?: unknown }).name).toBe('YAMLParseError');
    expect(isStackOverflow(error)).toBe(true);
  });

  it('does not take an ordinary YAML syntax error for an overflow', () => {
    let error: unknown;
    try {
      yaml.parse('a: [unclosed');
    } catch (thrown) {
      error = thrown;
    }

    expect(isStackOverflow(error)).toBe(false);
    expect(isStackOverflow(new RangeError('Invalid array length'))).toBe(false);
  });
});

describe('ParseWorkerDiedError', () => {
  it('is coded, names the exit, and is a per-run refusal beside a limit breach', () => {
    const died = new ParseWorkerDiedError({ exitCode: 1 });

    expect(died.code).toBe('PARSE_WORKER_DIED');
    expect(died.message).toContain('exited unexpectedly with code 1');
    expect(isParseWorkerDiedError(died)).toBe(true);
    expect(isParseLimitError(died)).toBe(false);
    expect(isPerRunParseRefusal(died)).toBe(true);
    expect(isPerRunParseRefusal(new ParseLimitError('timeMs', 1))).toBe(true);
    expect(isPerRunParseRefusal(new Error('a parser bug'))).toBe(false);
  });

  it('names the error a worker died of, and keeps it as the cause', () => {
    const cause = Object.assign(new Error('boom'), { code: 'ERR_SOMETHING' });
    const died = new ParseWorkerDiedError({ cause });

    expect(died.message).toContain('ERR_SOMETHING');
    expect(died.cause).toBe(cause);
  });

  it('survives the trip as plain data, by its code', () => {
    const plain = { ...new ParseWorkerDiedError({ exitCode: 3 }), code: 'PARSE_WORKER_DIED' };

    expect(isPerRunParseRefusal(plain)).toBe(true);
  });
});

describe('the heap measure', () => {
  it('is the whole used heap, so it never understates the old generation', () => {
    // Young-generation bytes count: subtracting the young generation at its
    // 96 MiB ceiling left a worker's old generation unseen up to V8's ceiling.
    expect(exceedsHeapLimit({ used_heap_size: 33 * MIB }, 32)).toBe(true);
    expect(exceedsHeapLimit({ used_heap_size: 32 * MIB }, 32)).toBe(false);
  });

  it('sets V8\'s own ceiling well above heapMb, so the sampler always stops a job first', () => {
    // V8 reaching a worker's ceiling is process-fatal under fast allocation, so
    // the ceiling is headroom past heapMb, never heapMb itself.
    expect(workerHeapCeilingMb(48)).toBe(96);
    expect(workerHeapCeilingMb(1024)).toBe(2048);
  });

  it('names the limit that applied, a lower process-wide --max-old-space-size included', () => {
    // heap_size_limit is the old generation's ceiling plus the young generation's.
    expect(appliedHeapLimitMb({ heap_size_limit: (2048 + 96) * MIB }, 96, 1024)).toBe(1024);
    expect(appliedHeapLimitMb({ heap_size_limit: 4192 * MIB }, 96, 48)).toBe(48);
    // A flag lowering V8's ceiling to 64 MiB: the job is stopped at half of it,
    // keeping the same headroom below a ceiling the pool could not raise.
    expect(appliedHeapLimitMb({ heap_size_limit: (64 + 96) * MIB }, 96, 1024)).toBe(32);
  });

  it('says in the refusal when a process-wide flag lowered the limit', () => {
    const lowered = ParseLimitError.heap(32, 1024);

    expect(lowered.limit).toBe('heapMb');
    expect(lowered.bound).toContain('32 MiB heap');
    expect(lowered.bound).toContain('--max-old-space-size');
    expect(ParseLimitError.heap(1024, 1024).bound).toBe('1024 MiB heap');
  });

  it('never names the configured limit as the one that applied when no sample ever read it', () => {
    // V8 can stop a worker at its own ceiling before any sample lands (a parent
    // blocked past the stall window), and a process-wide flag may have lowered
    // that ceiling: the applied value is then unknown, and the refusal says so.
    const unsampled = ParseLimitError.heapCeiling(undefined, 1024);

    expect(unsampled.limit).toBe('heapMb');
    expect(unsampled.bound).not.toContain('1024 MiB heap');
    expect(unsampled.bound).toContain('before the pool\'s heap sampler read it');
    expect(unsampled.bound).toContain('--max-old-space-size');
  });

  it('names V8\'s ceiling, twice the sampler\'s bound, when V8 stopped a sampled worker first', () => {
    const ceiling = ParseLimitError.heapCeiling(256, 1024);

    expect(ceiling.limit).toBe('heapMb');
    expect(ceiling.bound).toMatch(/^V8's own heap ceiling, 512 MiB heap/);
    expect(ceiling.bound).not.toMatch(/^256 MiB/);
  });
});
