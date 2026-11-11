/**
 * The pure half of the parse limits: the defaults, how rows are counted, which
 * thrown values are a stack breach, the worker-death refusal, and the heap
 * measure and ceiling the pool's sampler enforces `heapMb` with.
 */

import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import type { ParseResult } from '../src/link-parser.js';
import {
  heapBounds,
  heapBreached,
  countOutputRows,
  exceedsHeapLimit,
  expandedSize,
  isParseLimitError,
  isParseWorkerDiedError,
  isPerRunParseRefusal,
  isStackOverflow,
  memoryBoundedPool,
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

describe('expandedSize over a !!set and a !!omap', () => {
  // `JSON.stringify` writes a `Set` or a `Map` as `{}`, but the codec carries
  // every member to the parent (`frontmatter-codec.ts`, nodes `s` and `m`), so
  // counting what JSON writes let a million members through as one row.
  const limits = resolveParseLimits(undefined);

  it('sizes a !!set as the list of its members and a !!omap as the mapping of its entries', () => {
    const value = yaml.parse('s: !!set {x, y}\nm: !!omap [{p: 1}, {q: [2, 3]}]') as Record<string, unknown>;

    expect(value['s']).toBeInstanceOf(Set);
    expect(value['m']).toBeInstanceOf(Map);
    // {"s":["x","y"],"m":{"p":1,"q":[2,3]}}: two entries, two members, two entries, two elements.
    expect(expandedSize(value)).toStrictEqual({ rows: 8, bytes: Buffer.byteLength('{"s":["x","y"],"m":{"p":1,"q":[2,3]}}'), depth: 3 });
  });

  it('refuses a !!set of 20,000 members at outputRows (16,384)', () => {
    const set = new Set<number>();
    for (let member = 0; member < 20_000; member += 1) set.add(member);

    expect(outputBreach(withFrontmatter({ s: set }), limits)).toStrictEqual({ limit: 'outputRows', found: 20_001 });
  });

  it('refuses a !!omap of 20,000 entries at outputRows (16,384)', () => {
    const map = new Map<string, number>();
    for (let entry = 0; entry < 20_000; entry += 1) map.set(`k${String(entry)}`, entry);

    expect(outputBreach(withFrontmatter({ m: map }), limits)).toStrictEqual({ limit: 'outputRows', found: 20_001 });
  });

  it('refuses the round-3 probe shape, decoded by yaml: one member, one entry, each a list of 20,000 items', () => {
    const items = Array.from({ length: 20_000 }, () => '0').join(',');
    const value = yaml.parse(`s: !!set\n  ? [${items}]\nm: !!omap\n  - k: [${items}]\n`) as Record<string, unknown>;

    // Two entries, one member, one entry, and 20,000 elements under each.
    expect(outputBreach(withFrontmatter(value), limits)).toStrictEqual({ limit: 'outputRows', found: 40_004 });
  });

  it('refuses 3,000 levels nested inside a !!set at outputDepth', () => {
    // The mapping, the set, then 3,000 lists.
    expect(outputBreach(withFrontmatter({ s: new Set([nestedMapping(3001)['a']]) }), limits)).toStrictEqual({ limit: 'outputDepth', found: 3002 });
  });

  it('refuses 3,000 levels nested inside a !!omap key at outputDepth', () => {
    expect(outputBreach(withFrontmatter({ m: new Map([[nestedMapping(3001)['a'], 1]]) }), limits)).toStrictEqual({ limit: 'outputDepth', found: 3002 });
  });

  it('refuses a !!set or a !!omap that contains itself, whose depth has no end', () => {
    const set = new Set<unknown>();
    set.add(set);
    const map = new Map<unknown, unknown>();
    map.set('self', map);

    expect(outputBreach(withFrontmatter({ s: set }), limits)).toStrictEqual({ limit: 'outputDepth', found: Number.POSITIVE_INFINITY });
    expect(outputBreach(withFrontmatter({ m: map }), limits)).toStrictEqual({ limit: 'outputDepth', found: Number.POSITIVE_INFINITY });
  });

  it('counts a list aliased into several sets at its full size each time', () => {
    const value = yaml.parse('a: &x [1, 2, 3]\ns: !!set {? *x}\nt: !!set {? *x}') as Record<string, unknown>;

    // Three entries; the list's three elements under each of its three uses; one member per set.
    expect(expandedSize(value).rows).toBe(3 + 9 + 2);
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
    expect(heapBounds({ heap_size_limit: (2048 + 96) * MIB }, 96, 1024)).toStrictEqual({ appliedMb: 1024, ceilingMb: 2048, stopMb: 1536 });
    expect(heapBounds({ heap_size_limit: 4192 * MIB }, 96, 48)).toStrictEqual({ appliedMb: 48, ceilingMb: 4096, stopMb: 72 });
    // A flag lowering V8's ceiling to 512 MiB (CI's): the job is stopped at half of it,
    // keeping the same headroom below a ceiling the pool could not raise.
    expect(heapBounds({ heap_size_limit: (512 + 96) * MIB }, 96, 1024)).toStrictEqual({ appliedMb: 256, ceilingMb: 512, stopMb: 384 });
    // A flag so low that the ceiling cannot hold the floor AND the sampler's headroom: half of it.
    expect(heapBounds({ heap_size_limit: (64 + 96) * MIB }, 96, 1024)).toStrictEqual({ appliedMb: 32, ceilingMb: 64, stopMb: 32 });
  });

  it('never applies less than the young generation, while the ceiling leaves the sampler its headroom', () => {
    // The sampler counts the whole used heap, and the young generation alone
    // holds up to its own size (96 MiB) in garbage: measured on Node 26, a cold
    // worker parsing an ordinary 34 KB document peaks at 54 to 68 MiB used, so
    // under a 128 MiB flag (half: 64) about one parse in ten was refused.
    expect(heapBounds({ heap_size_limit: (128 + 96) * MIB }, 96, 1024)).toStrictEqual({ appliedMb: 96, ceilingMb: 128, stopMb: 96 });
    expect(heapBounds({ heap_size_limit: (160 + 96) * MIB }, 96, 1024)).toStrictEqual({ appliedMb: 96, ceilingMb: 160, stopMb: 128 });
    // Never past what the pool was configured with.
    expect(heapBounds({ heap_size_limit: (128 + 96) * MIB }, 96, 48)).toStrictEqual({ appliedMb: 48, ceilingMb: 128, stopMb: 72 });
  });

  it('stops a job no collection has vouched for halfway from the bound to V8\'s ceiling, never inside the sampler\'s headroom', () => {
    // Under a process-wide flag that lifts V8's ceiling, the stop still sits below twice heapMb.
    expect(heapBounds({ heap_size_limit: 4192 * MIB }, 96, 1024).stopMb).toBe(1536);
    expect(heapBounds({ heap_size_limit: (192 + 96) * MIB }, 96, 1024)).toStrictEqual({ appliedMb: 96, ceilingMb: 192, stopMb: 144 });
    // Where halfway would leave less than the sampler's 32 MiB below the ceiling, the headroom wins…
    expect(heapBounds({ heap_size_limit: (144 + 96) * MIB }, 96, 1024)).toStrictEqual({ appliedMb: 96, ceilingMb: 144, stopMb: 112 });
    // …and the stop is never below the bound itself.
    expect(heapBounds({ heap_size_limit: (50 + 96) * MIB }, 96, 1024)).toStrictEqual({ appliedMb: 25, ceilingMb: 50, stopMb: 25 });
  });

  it('counts the stop from the ceiling the pool set when no sample could read one', () => {
    expect(heapBounds({ heap_size_limit: 0 }, 96, 1024)).toStrictEqual({ appliedMb: 1024, ceilingMb: 2048, stopMb: 1536 });
  });
});

describe('a heap breach', () => {
  // Defaults: the bound 1,024 MiB, the stop 1,536, V8's ceiling 2,048, a 96 MiB young generation.
  const bounds = { appliedMb: 1024, ceilingMb: 2048, stopMb: 1536 };
  const sample = (mb: number) => ({ used_heap_size: mb * MIB });

  it('is never declared at or below the bound, whatever came before', () => {
    expect(heapBreached(sample(1024), 1600 * MIB, bounds, 96)).toBe(false);
    expect(heapBreached(sample(400), undefined, bounds, 96)).toBe(false);
  });

  it('is not declared on a heap still rising past the bound: no collection has yet said what of it is garbage', () => {
    // Measured: a 10,000-level blockquote holds 420-460 MiB live, yet on a
    // loaded host its used heap rose to 1,079 MiB before any collection ran.
    expect(heapBreached(sample(1079), 1018 * MIB, bounds, 96)).toBe(false);
    expect(heapBreached(sample(1100), undefined, bounds, 96)).toBe(false);
  });

  it('is not declared after a drop a young-generation collection alone could make', () => {
    // A scavenge frees at most the young generation, so the old generation's
    // garbage may still be counted.
    expect(heapBreached(sample(1100), 1196 * MIB, bounds, 96)).toBe(false);
  });

  it('is declared past the bound right after a drop only an old-generation collection makes: what is left is held', () => {
    expect(heapBreached(sample(1100), 1197 * MIB, bounds, 96)).toBe(true);
    expect(heapBreached(sample(1025), 1500 * MIB, bounds, 96)).toBe(true);
  });

  it('is declared past the stop whatever came before, so V8\'s ceiling is never left to stop a job', () => {
    expect(heapBreached(sample(1537), 1500 * MIB, bounds, 96)).toBe(true);
    expect(heapBreached(sample(1537), undefined, bounds, 96)).toBe(true);
    expect(heapBreached(sample(1536), 1500 * MIB, bounds, 96)).toBe(false);
  });

  it('reads any drop as an old-generation collection when the young generation is unknown, so it refuses sooner, never later', () => {
    expect(heapBreached(sample(1100), 1101 * MIB, bounds, 0)).toBe(true);
  });
});

describe('the heap refusal', () => {
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

  it('names V8\'s ceiling as the last sample read it, when V8 stopped a sampled worker first', () => {
    const ceiling = ParseLimitError.heapCeiling({ appliedMb: 256, ceilingMb: 512, stopMb: 384 }, 1024);

    expect(ceiling.limit).toBe('heapMb');
    expect(ceiling.bound).toMatch(/^V8's own heap ceiling, 512 MiB heap — above the 256 MiB the pool's heap sampler enforces/);
    expect(ceiling.bound).not.toMatch(/^256 MiB/);
    // Under a floored bound the ceiling is not twice it: named as read, never derived.
    expect(ParseLimitError.heapCeiling({ appliedMb: 96, ceilingMb: 128, stopMb: 96 }, 1024).bound).toMatch(/^V8's own heap ceiling, 128 MiB heap — above the 96 MiB/);
  });
});

describe('memoryBoundedPool', () => {
  // A width-4 pool at the default 1,024 MiB limit asks V8 for 4 × 2,048 MiB of
  // worker heap ceilings; the bound holds that, plus a 1,024 MiB main-thread
  // reserve, inside the machine's memory.
  it.each([
    { label: 'a 64 GiB machine leaves the width alone', memoryMb: 65_536, expected: { size: 4, heapMb: 1024 } },
    { label: 'a 16 GiB machine fits 7, so 4 stands', memoryMb: 16_384, expected: { size: 4, heapMb: 1024 } },
    { label: 'an 8 GiB machine fits 3', memoryMb: 8192, expected: { size: 3, heapMb: 1024 } },
    { label: 'a 4 GiB container fits 1', memoryMb: 4096, expected: { size: 1, heapMb: 1024 } },
    { label: 'a 2 GiB container lowers the heap, never the width below 1', memoryMb: 2048, expected: { size: 1, heapMb: 512 } },
    { label: 'a 1 GiB container floors the heap', memoryMb: 1024, expected: { size: 1, heapMb: 96 } },
  ])('$label', ({ memoryMb, expected }) => {
    expect(memoryBoundedPool({ size: 4, heapMb: 1024 }, memoryMb * MIB)).toStrictEqual(expected);
  });

  it('caps a pinned width of any size at the same bound', () => {
    expect(memoryBoundedPool({ size: 100_000, heapMb: 1024 }, 8192 * MIB)).toStrictEqual({ size: 3, heapMb: 1024 });
  });

  it('never raises a heap the caller set below what fits', () => {
    expect(memoryBoundedPool({ size: 1, heapMb: 64 }, 2048 * MIB)).toStrictEqual({ size: 1, heapMb: 64 });
  });
});
