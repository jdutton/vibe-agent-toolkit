/* eslint-disable security/detect-non-literal-fs-filename -- test reads and writes temp dirs from computed paths */
import { promises as fs } from 'node:fs';

import { normalizedTmpdir, removeScratchDir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeContentKey, type ParsableContent } from '../src/content-key.js';
import { parseHtmlContent } from '../src/html-link-parser.js';
import { parseMarkdownContent } from '../src/link-parser.js';
import type { DocumentParserKind } from '../src/mime-type.js';
import { ParseCache, parseKeyed } from '../src/parse-cache.js';
import {
  __readParseTimingSnapshot,
  __setParseTimingForTest,
  __writeParseTimingDumpForTest,
  PARSE_KIND_SHAPES,
  parseTimingStart,
  ParsePass,
  ParserKind,
  type ParseThreadTiming,
  type ParseTimingDump,
  type ParseTimingKind,
  recordTierPass,
  TIER_PASS_NAMES,
  TierPass,
} from '../src/parse-timing.js';

// ---------------------------------------------------------------------------
// Fixtures — external constants, never derived from the code under test.
// ---------------------------------------------------------------------------

/**
 * Exercises every instrumented markdown pass: frontmatter and headings
 * (ast-facts), a dangling reference (unresolved-references), a fenced block
 * (code-context ranges + measure-content) and an `@`-prefixed token
 * (lexical-references).
 */
const SAMPLE_DOC = `---
title: Sample
---

# Heading

See [the other doc](./other.md) and [dangling][nope]. Ping @octocat.

\`\`\`ts
const answer = 1;
\`\`\`
`;

/** Byte length of {@link SAMPLE_DOC} — what every markdown parse is told to attribute. */
const SAMPLE_BYTES = Buffer.byteLength(SAMPLE_DOC, 'utf-8');

/**
 * Exercises every instrumented HTML pass: a document parse5 must build a tree
 * for, elements the walk has to visit, an `id` anchor and a link to classify.
 */
const SAMPLE_HTML = `<!doctype html>
<html>
  <body>
    <h1 id="top">Heading</h1>
    <p>Prose with <a href="./other.html">a link</a>.</p>
    <img src="./picture.png" alt="">
  </body>
</html>
`;

/** Byte length of {@link SAMPLE_HTML}. */
const SAMPLE_HTML_BYTES = Buffer.byteLength(SAMPLE_HTML, 'utf-8');

/** The markdown group's pass names, in the exact order the dump contract fixes. */
const MARKDOWN_PASS_ORDER = [
  'estimate-tokens',
  'remark-processor',
  'remark-parse',
  'micromark-tokenize',
  'ast-facts',
  'unresolved-references',
  'code-context-ranges',
  'lexical-references',
  'measure-content',
];

/** The HTML group's pass names, in the exact order the dump contract fixes. */
const HTML_PASS_ORDER = ['parse5-parse', 'element-walk', 'estimate-tokens', 'measure-content'];

/** The kind groups, in the exact order the dump contract fixes. */
const KIND_ORDER = ['markdown', 'html'];

/** The tier row a failed or successful cache open is charged to. */
const CACHE_READ_IO = 'cache-read-io';

/** The tier row a cache HIT's JSON.parse, validation and rehydrate are charged to. */
const CACHE_READ_DECODE = 'cache-read-decode';

/** The tier row a cache write is charged to. */
const CACHE_WRITE = 'cache-write';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse {@link SAMPLE_DOC} `times` times through the instrumented parser. */
function parseSample(times: number): void {
  for (let index = 0; index < times; index += 1) {
    parseMarkdownContent(SAMPLE_DOC, SAMPLE_BYTES);
  }
}

/** Parse {@link SAMPLE_HTML} `times` times through the instrumented parser. */
function parseHtmlSample(times: number): void {
  for (let index = 0; index < times; index += 1) {
    parseHtmlContent(SAMPLE_HTML, SAMPLE_HTML_BYTES);
  }
}

/**
 * Key a string for {@link parseKeyed}, exactly as `readContentWithKey` would.
 *
 * Returns the NARROWED `ParsableContent` rather than a bare `KeyedContent`:
 * `parseKeyed` refuses a `none` blob at the type level, and the wide type made
 * every call site here an error nothing surfaced (test files are not
 * typechecked — `tsconfig.test.json` is broken).
 */
function keyFor(content: string, parserKind: DocumentParserKind = 'markdown'): ParsableContent {
  const bytes = Buffer.from(content, 'utf-8');
  return {
    content,
    // What a BOM-less UTF-8 read reports: the encoding was defaulted to, not
    // stated, and nothing had to be substituted.
    decoding: { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 },
    key: computeContentKey(bytes, parserKind),
    parserKind,
    byteLength: bytes.byteLength,
  };
}

/**
 * One kind's group out of a dump, failing loudly when the seam omitted it.
 *
 * Every group is always emitted, even at zero — a reader must never have to
 * distinguish "absent" from "zero" — so a missing group is a contract break and
 * not something a test should silently tolerate.
 */
function groupOf(thread: ParseThreadTiming, kind: string): ParseTimingKind {
  const group = thread.kinds.find((one) => one.kind === kind);
  if (group === undefined) throw new Error(`dump carries no '${kind}' group`);
  return group;
}

/** Every pass row's `calls` for one kind, in dump order. Excludes the total. */
function callsOf(thread: ParseThreadTiming, kind: string): number[] {
  return groupOf(thread, kind).passes.map((row) => row.calls);
}

/**
 * One tier row out of a dump, failing loudly when the seam omitted it.
 *
 * Same contract as {@link groupOf}: every tier row is always emitted, even at
 * zero, so a missing one is a contract break rather than a state to tolerate.
 */
function tierRowOf(thread: ParseThreadTiming, pass: string): { calls: number; elapsedMs: number } {
  const row = thread.tier.find((one) => one.pass === pass);
  if (row === undefined) throw new Error(`dump carries no '${pass}' tier row`);
  return row;
}

/** Every tier row's `calls`, in dump order. */
function tierCallsOf(thread: ParseThreadTiming): number[] {
  return thread.tier.map((row) => row.calls);
}

/** `count` repeated `length` times — what an all-parses-charged group looks like. */
function repeated(length: number, count: number): number[] {
  return Array.from({ length }, () => count);
}

/**
 * What `count` markdown parses charge, with the ONE opt-in row still at zero.
 *
 * `micromark-tokenize` is charged only when `VAT_PARSE_TIMING_SPLIT` names an
 * order (`parse-tokenize-probe.ts`), because the probe re-tokenizes and would
 * otherwise change `markdown-total` on every run of the instrument. Every other
 * markdown pass is charged once per parse, so spelling the exception out here
 * keeps "all passes are charged" a single readable claim rather than a list.
 */
function markdownCalls(count: number): number[] {
  return MARKDOWN_PASS_ORDER.map((pass) => (pass === 'micromark-tokenize' ? 0 : count));
}

/**
 * Parse one document twice through `cache`, and snapshot only the SECOND parse.
 *
 * The accumulators are zeroed between the two calls, so what comes back
 * describes a warm hit and nothing else. Without that reset the cold parse's
 * passes and its cache write are still in the counters, and a test asserting
 * "a hit charges no parse" would be asserting against the cold run's numbers.
 *
 * @param cache - The store to warm and then hit
 * @param directory - Where the re-armed seam writes, if a test asks it to
 * @returns The accumulator state produced by the second parse alone
 */
async function snapshotOfWarmParse(
  cache: ParseCache,
  directory: string,
): Promise<ParseThreadTiming> {
  const keyed = keyFor(SAMPLE_DOC);
  await parseKeyed(keyed, cache);
  __setParseTimingForTest(directory);
  await parseKeyed(keyed, cache);
  return __readParseTimingSnapshot();
}

/** Read a written dump back off disk. */
async function readDump(path: string): Promise<ParseTimingDump> {
  return JSON.parse(await fs.readFile(path, 'utf-8')) as ParseTimingDump;
}

/**
 * The WRITING thread's record out of a dump, failing loudly if it is absent.
 *
 * Always first and always present — it is the denominator for every "what did
 * the serial thread pay" question — so its absence is a contract break rather
 * than a state a test should tolerate.
 *
 * ⚠️ Keyed on position, deliberately NOT on `threadId === 0`. Vitest runs each
 * test file in a worker thread, so the thread accumulating here reports a
 * POSITIVE `threadId` and a test that looked for zero would find nothing. In a
 * real vat process the writer is the main thread and the two agree; the position
 * is what holds in both.
 *
 * @param dump - A dump read back off disk
 * @returns The writing thread's counters
 */
function writerThreadOf(dump: ParseTimingDump): ParseThreadTiming {
  const writer = dump.threads[0];
  if (writer === undefined) throw new Error('dump carries no thread record at all');
  return writer;
}

describe('parse timing seam', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-parse-timing-'));
  });

  afterEach(async () => {
    // Always leave the seam off: it is module-level state shared by every test
    // in this file, and an enabled seam would leak into the next one.
    __setParseTimingForTest(null);
    await removeScratchDir(tempDir);
  });

  describe('disabled', () => {
    it('accumulates nothing and writes nothing when the seam is off', () => {
      // `vitest.setup.js` deletes every VAT_* variable before any module loads,
      // so the module-load gate is off — this is the shipped default state.
      parseSample(3);
      parseHtmlSample(3);

      const snapshot = __readParseTimingSnapshot();
      expect(callsOf(snapshot, 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 0));
      expect(callsOf(snapshot, 'html')).toEqual(repeated(HTML_PASS_ORDER.length, 0));
      expect(groupOf(snapshot, 'markdown').documents).toEqual({ count: 0, bytes: 0 });
      expect(groupOf(snapshot, 'html').documents).toEqual({ count: 0, bytes: 0 });
      expect(snapshot.cache).toEqual({ hits: 0, misses: 0 });
      expect(__writeParseTimingDumpForTest()).toBeNull();
    });

    it('leaves no dump file behind in a directory it was never pointed at', async () => {
      parseSample(1);
      __writeParseTimingDumpForTest();

      await expect(fs.readdir(tempDir)).resolves.toEqual([]);
    });
  });

  describe('enabled', () => {
    beforeEach(() => {
      __setParseTimingForTest(tempDir);
    });

    it('charges every markdown pass on each markdown parse', () => {
      parseSample(3);

      const snapshot = __readParseTimingSnapshot();
      expect(callsOf(snapshot, 'markdown')).toEqual(markdownCalls(3));
      expect(groupOf(snapshot, 'markdown').documents).toEqual({
        count: 3,
        bytes: SAMPLE_BYTES * 3,
      });
    });

    it('charges every HTML pass on each HTML parse', () => {
      // The reason this file exists in its current shape: an HTML parse used to
      // charge nothing at all, so a tree made of HTML measured as a tree that
      // barely parses.
      parseHtmlSample(4);

      const snapshot = __readParseTimingSnapshot();
      expect(callsOf(snapshot, 'html')).toEqual(repeated(HTML_PASS_ORDER.length, 4));
      expect(groupOf(snapshot, 'html').documents).toEqual({
        count: 4,
        bytes: SAMPLE_HTML_BYTES * 4,
      });
      expect(groupOf(snapshot, 'html').total.elapsedMs).toBeGreaterThan(0);
    });

    it('keeps the two kinds apart rather than pooling them', () => {
      // The fixture can distinguish: 2 markdown and 5 HTML parses. A seam that
      // pooled them would show 7 everywhere, and a seam that counted only
      // markdown would show 2 and call the HTML work free.
      parseSample(2);
      parseHtmlSample(5);

      const snapshot = __readParseTimingSnapshot();
      expect(groupOf(snapshot, 'markdown').documents.count).toBe(2);
      expect(groupOf(snapshot, 'html').documents.count).toBe(5);
      expect(callsOf(snapshot, 'markdown')).toEqual(markdownCalls(2));
      expect(callsOf(snapshot, 'html')).toEqual(repeated(HTML_PASS_ORDER.length, 5));
      expect(groupOf(snapshot, 'markdown').total.calls).toBe(2);
      expect(groupOf(snapshot, 'html').total.calls).toBe(5);
    });

    it('brackets each kind with its OWN total, kept out of the pass rows', () => {
      parseSample(5);
      parseHtmlSample(5);

      const snapshot = __readParseTimingSnapshot();
      for (const kind of KIND_ORDER) {
        const group = groupOf(snapshot, kind);
        // The total is a field, never a row: there is no way to sum the rows a
        // reader is given and accidentally include the bracket around them.
        expect(group.passes.map((row) => row.pass)).not.toContain(group.total.pass);
        expect(group.total.pass).toBe(`${kind}-total`);
        const summed = group.passes.reduce((sum, row) => sum + row.elapsedMs, 0);
        expect(group.total.elapsedMs).toBeGreaterThanOrEqual(summed);
        for (const row of group.passes) expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('round-trips the exact dump contract through JSON', async () => {
      parseSample(2);
      parseHtmlSample(3);

      const path = __writeParseTimingDumpForTest();
      expect(path).not.toBeNull();

      const dump = await readDump(path ?? '');
      expect(dump.pid).toBe(process.pid);
      expect(writerThreadOf(dump).cache).toEqual({ hits: 0, misses: 0 });
      expect(writerThreadOf(dump).kinds.map((group) => group.kind)).toEqual(KIND_ORDER);
      expect(groupOf(writerThreadOf(dump), 'markdown').passes.map((row) => row.pass)).toEqual(MARKDOWN_PASS_ORDER);
      expect(groupOf(writerThreadOf(dump), 'html').passes.map((row) => row.pass)).toEqual(HTML_PASS_ORDER);
      expect(callsOf(writerThreadOf(dump), 'markdown')).toEqual(markdownCalls(2));
      expect(callsOf(writerThreadOf(dump), 'html')).toEqual(repeated(HTML_PASS_ORDER.length, 3));
    });

    it('reports process wall and CPU time, so the wall-timed passes can be judged', async () => {
      parseSample(1);

      const dump = await readDump(__writeParseTimingDumpForTest() ?? '');
      // Read at dump time from the process, so the only safe assertions are that
      // they exist, are finite and are lifetime figures rather than zero.
      expect(dump.process.wallMs).toBeGreaterThan(0);
      expect(dump.process.cpuUserMs).toBeGreaterThan(0);
      expect(dump.process.cpuSystemMs).toBeGreaterThanOrEqual(0);
      // The process has been alive far longer than the parse it just did, which
      // is exactly why this must never be read as a parse duration.
      expect(dump.process.wallMs).toBeGreaterThan(groupOf(writerThreadOf(dump), 'markdown').total.elapsedMs);
    });

    it('emits every kind and every pass even when nothing was parsed at all', async () => {
      const dump = await readDump(__writeParseTimingDumpForTest() ?? '');

      expect(writerThreadOf(dump).kinds.map((group) => group.kind)).toEqual(KIND_ORDER);
      expect(callsOf(writerThreadOf(dump), 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 0));
      expect(callsOf(writerThreadOf(dump), 'html')).toEqual(repeated(HTML_PASS_ORDER.length, 0));
      expect(groupOf(writerThreadOf(dump), 'markdown').documents.count).toBe(0);
      expect(groupOf(writerThreadOf(dump), 'html').documents.count).toBe(0);
    });

    it('does not overwrite a dump already filed under this pid', async () => {
      parseSample(1);
      const first = __writeParseTimingDumpForTest();
      parseSample(1);
      const second = __writeParseTimingDumpForTest();

      expect(second).not.toBe(first);
      await expect(fs.readdir(tempDir)).resolves.toHaveLength(2);

      // The first dump still reports ONE document; the second reports two.
      expect(groupOf(writerThreadOf(await readDump(first ?? '')), 'markdown').documents.count).toBe(1);
      expect(groupOf(writerThreadOf(await readDump(second ?? '')), 'markdown').documents.count).toBe(2);
    });
  });

  describe('cache attribution', () => {
    let cache: ParseCache;

    beforeEach(() => {
      __setParseTimingForTest(tempDir);
      cache = new ParseCache({ cacheDir: safePath.join(tempDir, 'cache'), enabled: true });
    });

    it('counts a miss and the parse work it caused', async () => {
      await parseKeyed(keyFor(SAMPLE_DOC), cache);

      const snapshot = __readParseTimingSnapshot();
      expect(snapshot.cache).toEqual({ hits: 0, misses: 1 });
      expect(callsOf(snapshot, 'markdown')).toEqual(markdownCalls(1));
      expect(groupOf(snapshot, 'markdown').documents.count).toBe(1);
    });

    it('routes an HTML miss to the HTML group, not to markdown', async () => {
      // The cache counts every parser kind. Before HTML was instrumented this
      // miss produced a document count of zero and no passes anywhere, which
      // read as "the cache missed and parsing was free".
      await parseKeyed(keyFor(SAMPLE_HTML, 'html'), cache);

      const snapshot = __readParseTimingSnapshot();
      expect(snapshot.cache).toEqual({ hits: 0, misses: 1 });
      expect(groupOf(snapshot, 'html').documents.count).toBe(1);
      expect(groupOf(snapshot, 'markdown').documents.count).toBe(0);
      expect(callsOf(snapshot, 'html')).toEqual(repeated(HTML_PASS_ORDER.length, 1));
      expect(callsOf(snapshot, 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 0));
    });

    it('counts a hit without charging any pass', async () => {
      const snapshot = await snapshotOfWarmParse(cache, tempDir);

      expect(snapshot.cache).toEqual({ hits: 1, misses: 0 });
      expect(callsOf(snapshot, 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 0));
      expect(groupOf(snapshot, 'markdown').documents.count).toBe(0);
    });
  });

  describe('the tier section', () => {
    beforeEach(() => {
      __setParseTimingForTest(tempDir);
    });

    it('charges the slot it is given and nothing else', () => {
      recordTierPass(TierPass.CacheReadIo, parseTimingStart());
      recordTierPass(TierPass.CacheReadIo, parseTimingStart());
      recordTierPass(TierPass.WireDispatch, parseTimingStart());

      const snapshot = __readParseTimingSnapshot();
      expect(tierRowOf(snapshot, CACHE_READ_IO).calls).toBe(2);
      expect(tierRowOf(snapshot, 'wire-dispatch').calls).toBe(1);
      expect(tierRowOf(snapshot, CACHE_READ_DECODE).calls).toBe(0);
    });

    it('keeps tier work OUT of every parser kind group', () => {
      // The whole reason this is a top-level section rather than a third
      // `kinds[]` entry. `kinds` means "parser kinds" to every consumer, so
      // dispatch time folded in there would land in "which parser dominates" —
      // the exact denominator bug `ca99aedb` fixed one level up.
      parseSample(2);
      recordTierPass(TierPass.WireDispatch, parseTimingStart());

      const snapshot = __readParseTimingSnapshot();
      const tierNames = new Set(TIER_PASS_NAMES);
      for (const group of snapshot.kinds) {
        for (const row of group.passes) expect(tierNames.has(row.pass)).toBe(false);
        expect(tierNames.has(group.total.pass)).toBe(false);
      }
      // And the kinds' own arithmetic is untouched by a tier charge.
      expect(callsOf(snapshot, 'markdown')).toEqual(markdownCalls(2));
    });

    it('emits every tier row in declared order even when nothing charged one', async () => {
      const dump = await readDump(__writeParseTimingDumpForTest() ?? '');

      expect(writerThreadOf(dump).tier.map((row) => row.pass)).toEqual([...TIER_PASS_NAMES]);
      expect(tierCallsOf(writerThreadOf(dump))).toEqual(repeated(TIER_PASS_NAMES.length, 0));
    });

    it('accumulates nothing when the seam is off', () => {
      __setParseTimingForTest(null);

      recordTierPass(TierPass.CacheWrite, parseTimingStart());

      const snapshot = __readParseTimingSnapshot();
      expect(tierCallsOf(snapshot)).toEqual(repeated(TIER_PASS_NAMES.length, 0));
    });
  });

  describe('tier attribution through the real cache', () => {
    let cache: ParseCache;

    beforeEach(() => {
      __setParseTimingForTest(tempDir);
      cache = new ParseCache({ cacheDir: safePath.join(tempDir, 'cache'), enabled: true });
    });

    it('charges a MISS for the read attempt and the write, and decodes nothing', async () => {
      await parseKeyed(keyFor(SAMPLE_DOC), cache);

      const snapshot = __readParseTimingSnapshot();
      // The read was attempted and failed (ENOENT), so the IO bracket ran...
      expect(tierRowOf(snapshot, CACHE_READ_IO).calls).toBe(1);
      // ...but there were no bytes to decode, which is what makes the two
      // brackets separate rows rather than one `cache-read`. A miss and a hit
      // cost completely different things and must not average together.
      expect(tierRowOf(snapshot, CACHE_READ_DECODE).calls).toBe(0);
      expect(tierRowOf(snapshot, CACHE_WRITE).calls).toBe(1);
    });

    it('charges a HIT for both halves of the read, and writes nothing', async () => {
      const snapshot = await snapshotOfWarmParse(cache, tempDir);

      expect(snapshot.cache).toEqual({ hits: 1, misses: 0 });
      expect(tierRowOf(snapshot, CACHE_READ_IO).calls).toBe(1);
      expect(tierRowOf(snapshot, CACHE_READ_DECODE).calls).toBe(1);
      // ⭐ This pair IS arm A of the transport experiment: a hit's parent-side
      // cost is exactly `cache-read-io` + `cache-read-decode`, and nothing else.
      expect(tierRowOf(snapshot, CACHE_READ_DECODE).elapsedMs).toBeGreaterThan(0);
      expect(tierRowOf(snapshot, CACHE_WRITE).calls).toBe(0);
    });

    it('charges no read at all when the cache is disabled', async () => {
      const disabled = new ParseCache({ cacheDir: safePath.join(tempDir, 'off'), enabled: false });

      await parseKeyed(keyFor(SAMPLE_DOC), disabled);

      const snapshot = __readParseTimingSnapshot();
      // A disabled cache short-circuits before touching the disk. Charging the
      // bracket anyway would publish a per-document read cost for a run that
      // never read anything — the arm-A number would be measured on air.
      expect(tierRowOf(snapshot, CACHE_READ_IO).calls).toBe(0);
      expect(tierRowOf(snapshot, CACHE_WRITE).calls).toBe(0);
    });
  });

  describe('the declared shape', () => {
    it('exports each kind and its pass names in the order the dump fixes', () => {
      expect(PARSE_KIND_SHAPES.map((shape) => shape.kind)).toEqual(KIND_ORDER);
      expect([...(PARSE_KIND_SHAPES[0]?.passNames ?? [])]).toEqual(MARKDOWN_PASS_ORDER);
      expect([...(PARSE_KIND_SHAPES[1]?.passNames ?? [])]).toEqual(HTML_PASS_ORDER);
    });

    it('aligns the declared slots with the flat accumulator, so nothing can drift', () => {
      // The hot path indexes ONE flat array by `ParsePass`, while the dump is
      // built from `PARSE_KIND_SHAPES`. If a slot were added to one and not the
      // other, a pass would be timed and never reported — or reported and never
      // timed — and every number in the dump would still look plausible.
      let expectedSlot = 0;
      for (const shape of PARSE_KIND_SHAPES) {
        expect(shape.firstPassSlot).toBe(expectedSlot);
        expect(shape.totalSlot).toBe(expectedSlot + shape.passNames.length);
        expectedSlot = shape.totalSlot + 1;
      }
      // Every slot the enum declares belongs to exactly one kind, and the kinds
      // account for all of them.
      expect(expectedSlot).toBe(Object.keys(ParsePass).length);
    });

    it('indexes the kind shapes by the same slot the document counters use', () => {
      expect(PARSE_KIND_SHAPES[ParserKind.Markdown]?.kind).toBe('markdown');
      expect(PARSE_KIND_SHAPES[ParserKind.Html]?.kind).toBe('html');
      // The positional pin above names each slot it knows about, so on its own it
      // stays green when a THIRD slot is added and left unshaped — the document
      // counters would index past the end of `PARSE_KIND_SHAPES` and that kind's
      // documents would vanish from the dump. Length is what closes it.
      expect(PARSE_KIND_SHAPES).toHaveLength(Object.keys(ParserKind).length);
    });

    it('names one tier pass per declared tier slot, in slot order', () => {
      // Same drift hazard the kind shapes are pinned against, one section over:
      // the hot path indexes a flat array by `TierPass` and the dump is built
      // from `TIER_PASS_NAMES`. A slot added to one and not the other is timed
      // and never reported, or reported and never timed, and the dump still
      // looks well-formed either way.
      expect(TIER_PASS_NAMES).toHaveLength(Object.keys(TierPass).length);
      for (const [name, slot] of Object.entries(TierPass)) {
        expect(TIER_PASS_NAMES[slot], `slot ${String(slot)} (${name})`).toBeDefined();
      }
      expect(new Set(TIER_PASS_NAMES).size).toBe(TIER_PASS_NAMES.length);
    });

    it('shares no pass NAME with any parser kind, so no row can be charged twice', () => {
      // `markdown` and `html` deliberately share `estimate-tokens` because they
      // run the same operation. A tier row sharing a parser's name would not be
      // that — it would be a row a reader could sum into the wrong denominator.
      const parserNames = new Set(
        PARSE_KIND_SHAPES.flatMap((shape) => [...shape.passNames, shape.totalName]),
      );
      for (const name of TIER_PASS_NAMES) expect(parserNames.has(name)).toBe(false);
    });

    it('instruments only the kinds a parser exists for — `none` has no slot', () => {
      // `content-key.ts`'s ParserKind is a routing answer with three members;
      // this module's is a list of instrumented parsers with two. The names
      // collide and the sets deliberately do not. Pinned so that a later reader
      // reconciling the two names does not "fix" the difference by adding a
      // group to the dump as a drive-by.
      //
      // 🚨 The reason is NOT "no parser runs, so there is nothing to bracket" —
      // that was written here and in `ParserKind`'s docstring and is false.
      // `blob-population.ts`'s `unparsedFacts` runs findLexicalReferences,
      // measureContent and estimateTokens over the full content of every
      // non-prose file. See `ParserKind` for the measured bound (~0.8 s of a
      // 16 s cold adopter run) and for why adding the group is a real decision —
      // it moves the dump's shape, so the lab's strict schema refuses every dump
      // and every stored report written before it — rather than a correction
      // anyone should make in passing.
      expect(PARSE_KIND_SHAPES.map((shape) => shape.kind)).not.toContain('none');
    });
  });
});
