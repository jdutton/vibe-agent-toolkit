/* eslint-disable security/detect-non-literal-fs-filename -- test reads and writes temp dirs from computed paths */
import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeContentKey, type KeyedContent } from '../src/content-key.js';
import { parseHtmlContent } from '../src/html-link-parser.js';
import { parseMarkdownContent } from '../src/link-parser.js';
import { ParseCache, parseKeyed } from '../src/parse-cache.js';
import {
  __readParseTimingSnapshot,
  __setParseTimingForTest,
  __writeParseTimingDumpForTest,
  PARSE_KIND_SHAPES,
  ParsePass,
  ParserKind,
  type ParseTimingDump,
  type ParseTimingKind,
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

/** Key a string for {@link parseKeyed}, exactly as `readContentWithKey` would. */
function keyFor(content: string, parserKind: 'markdown' | 'html' = 'markdown'): KeyedContent {
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
function groupOf(dump: ParseTimingDump, kind: string): ParseTimingKind {
  const group = dump.kinds.find((one) => one.kind === kind);
  if (group === undefined) throw new Error(`dump carries no '${kind}' group`);
  return group;
}

/** Every pass row's `calls` for one kind, in dump order. Excludes the total. */
function callsOf(dump: ParseTimingDump, kind: string): number[] {
  return groupOf(dump, kind).passes.map((row) => row.calls);
}

/** `count` repeated `length` times — what an all-parses-charged group looks like. */
function repeated(length: number, count: number): number[] {
  return Array.from({ length }, () => count);
}

/** Read a written dump back off disk. */
async function readDump(path: string): Promise<ParseTimingDump> {
  return JSON.parse(await fs.readFile(path, 'utf-8')) as ParseTimingDump;
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
    await fs.rm(tempDir, { recursive: true, force: true });
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
      expect(callsOf(snapshot, 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 3));
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
      expect(callsOf(snapshot, 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 2));
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
      expect(dump.dumpVersion).toBe(2);
      expect(dump.pid).toBe(process.pid);
      expect(dump.cache).toEqual({ hits: 0, misses: 0 });
      expect(dump.kinds.map((group) => group.kind)).toEqual(KIND_ORDER);
      expect(groupOf(dump, 'markdown').passes.map((row) => row.pass)).toEqual(MARKDOWN_PASS_ORDER);
      expect(groupOf(dump, 'html').passes.map((row) => row.pass)).toEqual(HTML_PASS_ORDER);
      expect(callsOf(dump, 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 2));
      expect(callsOf(dump, 'html')).toEqual(repeated(HTML_PASS_ORDER.length, 3));
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
      expect(dump.process.wallMs).toBeGreaterThan(groupOf(dump, 'markdown').total.elapsedMs);
    });

    it('emits every kind and every pass even when nothing was parsed at all', async () => {
      const dump = await readDump(__writeParseTimingDumpForTest() ?? '');

      expect(dump.kinds.map((group) => group.kind)).toEqual(KIND_ORDER);
      expect(callsOf(dump, 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 0));
      expect(callsOf(dump, 'html')).toEqual(repeated(HTML_PASS_ORDER.length, 0));
      expect(groupOf(dump, 'markdown').documents.count).toBe(0);
      expect(groupOf(dump, 'html').documents.count).toBe(0);
    });

    it('does not overwrite a dump already filed under this pid', async () => {
      parseSample(1);
      const first = __writeParseTimingDumpForTest();
      parseSample(1);
      const second = __writeParseTimingDumpForTest();

      expect(second).not.toBe(first);
      await expect(fs.readdir(tempDir)).resolves.toHaveLength(2);

      // The first dump still reports ONE document; the second reports two.
      expect(groupOf(await readDump(first ?? ''), 'markdown').documents.count).toBe(1);
      expect(groupOf(await readDump(second ?? ''), 'markdown').documents.count).toBe(2);
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
      expect(callsOf(snapshot, 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 1));
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
      const keyed = keyFor(SAMPLE_DOC);
      await parseKeyed(keyed, cache);
      // Zero the accumulators so the second call's effect stands alone.
      __setParseTimingForTest(tempDir);

      await parseKeyed(keyed, cache);

      const snapshot = __readParseTimingSnapshot();
      expect(snapshot.cache).toEqual({ hits: 1, misses: 0 });
      expect(callsOf(snapshot, 'markdown')).toEqual(repeated(MARKDOWN_PASS_ORDER.length, 0));
      expect(groupOf(snapshot, 'markdown').documents.count).toBe(0);
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
    });
  });
});
