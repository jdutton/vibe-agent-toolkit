import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseMarkdownContent } from '../src/link-parser.js';
import {
  __readParseTimingSnapshot,
  __setParseTimingForTest,
  PARSE_KIND_SHAPES,
  ParserKind,
} from '../src/parse-timing.js';
import {
  __setTokenizeProbeForTest,
  markdownTokenizeEvents,
  parseTokenizeProbeOrder,
  tokenizeProbeOrder,
} from '../src/parse-tokenize-probe.js';

// ---------------------------------------------------------------------------
// Fixtures — external constants, never derived from the code under test.
// ---------------------------------------------------------------------------

/**
 * A document whose only interesting feature is a GFM construct CommonMark does
 * not have.
 *
 * `~~struck~~` tokenizes to `strikethrough` events ONLY when `remark-gfm`'s
 * micromark extension is in the parser's extension list. That is the property
 * the whole split measurement rests on: a probe that tokenized bare CommonMark
 * would do measurably less work than the parse it is being subtracted from, and
 * would report tree building as larger than it is — with every number still
 * looking plausible.
 */
const GFM_DOC = '# Heading\n\nProse with ~~struck~~ text.\n';

/** Byte length of {@link GFM_DOC} — what the parse is told to attribute. */
const GFM_BYTES = Buffer.byteLength(GFM_DOC, 'utf-8');

/** What the split row is called in the dump. */
const TOKENIZE_PASS = 'micromark-tokenize';

/** What the full remark parse is called in the dump. */
const REMARK_PARSE_PASS = 'remark-parse';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read one markdown pass row out of this thread's accumulators.
 *
 * @param pass - The pass name as the dump carries it
 * @returns Calls and elapsed ms for that row
 */
function markdownPass(pass: string): { calls: number; elapsedMs: number } {
  const snapshot = __readParseTimingSnapshot();
  const group = snapshot.kinds[ParserKind.Markdown];
  const row = group?.passes.find((candidate) => candidate.pass === pass);
  if (row === undefined) throw new Error(`no markdown pass named ${pass}`);
  return { calls: row.calls, elapsedMs: row.elapsedMs };
}

describe('the markdown tokenize/tree-build split probe', () => {
  // A real directory even though no test writes a dump: arming the seam creates
  // the directory eagerly, so a placeholder path turns every `beforeEach` into
  // an `ENOENT` on stderr — noise in the log a real failure has to compete with.
  let timingDirectory = '';

  beforeAll(async () => {
    timingDirectory = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-tokenize-probe-'));
  });

  afterAll(async () => {
    await fs.rm(timingDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    __setParseTimingForTest(timingDirectory);
    __setTokenizeProbeForTest(null);
  });

  afterEach(() => {
    __setTokenizeProbeForTest(null);
    __setParseTimingForTest(null);
  });

  describe('the gate', () => {
    it('is off when the environment says nothing', () => {
      expect(parseTokenizeProbeOrder(undefined)).toBeNull();
      expect(parseTokenizeProbeOrder('')).toBeNull();
    });

    it('reads the two orders the measurement needs', () => {
      expect(parseTokenizeProbeOrder('before')).toBe('before');
      expect(parseTokenizeProbeOrder('after')).toBe('after');
    });

    it('REFUSES an unrecognised value rather than silently measuring nothing', () => {
      // A typo that read as "off" would produce a run with an empty split row
      // in it, which is indistinguishable from a run where tokenizing is free.
      expect(() => parseTokenizeProbeOrder('yes')).toThrow(/VAT_PARSE_TIMING_SPLIT/);
      expect(() => parseTokenizeProbeOrder('Before')).toThrow(/VAT_PARSE_TIMING_SPLIT/);
    });

    it('defaults to off, so an ordinary timing run measures what it always did', () => {
      expect(tokenizeProbeOrder()).toBeNull();
    });
  });

  describe('what the probe tokenizes', () => {
    it('carries the SAME micromark extensions the measured parse uses', () => {
      const events = markdownTokenizeEvents(GFM_DOC);
      const types = new Set(events.map(([, token]) => token.type));
      expect(types.has('strikethrough')).toBe(true);
    });

    it('produces the events the tree builder would have been given', () => {
      // Not an empty list, and not a list that stopped at the first line: the
      // probe must walk the whole document or the subtraction is against a
      // fraction of the work.
      const events = markdownTokenizeEvents(GFM_DOC);
      expect(events.length).toBeGreaterThan(20);
      expect(events.some(([, token]) => token.type === 'atxHeading')).toBe(true);
    });
  });

  describe('charging the row', () => {
    it('charges nothing while the probe is off', () => {
      parseMarkdownContent(GFM_DOC, GFM_BYTES);
      expect(markdownPass(TOKENIZE_PASS)).toEqual({ calls: 0, elapsedMs: 0 });
      expect(markdownPass(REMARK_PARSE_PASS).calls).toBe(1);
    });

    it('charges once per document with the probe BEFORE the measured parse', () => {
      __setTokenizeProbeForTest('before');
      parseMarkdownContent(GFM_DOC, GFM_BYTES);
      parseMarkdownContent(GFM_DOC, GFM_BYTES);
      expect(markdownPass(TOKENIZE_PASS).calls).toBe(2);
      expect(markdownPass(REMARK_PARSE_PASS).calls).toBe(2);
    });

    it('charges once per document with the probe AFTER the measured parse', () => {
      __setTokenizeProbeForTest('after');
      parseMarkdownContent(GFM_DOC, GFM_BYTES);
      expect(markdownPass(TOKENIZE_PASS).calls).toBe(1);
    });

    it('lands INSIDE the markdown total, so the shares still sum', () => {
      __setTokenizeProbeForTest('after');
      parseMarkdownContent(GFM_DOC, GFM_BYTES);
      const snapshot = __readParseTimingSnapshot();
      const group = snapshot.kinds[ParserKind.Markdown];
      const attributed = (group?.passes ?? []).reduce((sum, row) => sum + row.elapsedMs, 0);
      expect(group?.total.elapsedMs ?? 0).toBeGreaterThanOrEqual(attributed);
    });
  });

  describe('the declared shape', () => {
    it('declares the split row immediately after the parse it divides', () => {
      const names = [...(PARSE_KIND_SHAPES[ParserKind.Markdown]?.passNames ?? [])];
      expect(names.indexOf(TOKENIZE_PASS)).toBe(names.indexOf(REMARK_PARSE_PASS) + 1);
    });

    it('publishes NO tree-build row, because nothing measures one', () => {
      // Tree building is `remark-parse` minus `micromark-tokenize`. Emitting it
      // as a row would let a reader take a derived remainder for a measurement.
      const names = [...(PARSE_KIND_SHAPES[ParserKind.Markdown]?.passNames ?? [])];
      expect(names.some((name) => name.includes('tree-build'))).toBe(false);
    });
  });
});
