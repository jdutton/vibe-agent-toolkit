/**
 * The skill-text record is bounded on its own terms, never by the parse output
 * caps: a record past the bound refuses nothing and changes no fact of the
 * parse; the caches decline to keep it, and a stored blob says so.
 */

import { describe, expect, it } from 'vitest';

import { parseMarkdownContent, type ParseResult } from '../../src/link-parser.js';
import {
  countOutputRows,
  outputBreach,
  resolveParseLimits,
  SKILL_TEXT_HELD_LIMITS,
  skillTextHeld,
  storableUnderDefaultLimits,
} from '../../src/parse-limits.js';
import { blobConditionsFor, blobRowFor, skillTextRowsFor } from '../../src/projection/blob-facts.js';
import { blobReferencesFor } from '../../src/projection/blob-references.js';
import { blobFactsReader, blobResourceFactsOf } from '../../src/projection/blob-resource-facts.js';
import { blobSectionsFor } from '../../src/projection/blob-sections.js';
import type { BlobScopedRows } from '../../src/projection/store.js';
import type { SkillTextFacts } from '../../src/schemas/skill-text-facts.js';
import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';

import { PAST_BOUND_MATCHES } from './past-bound.js';

const KEY = `markdown.${'b'.repeat(64)}`;

/**
 * A record of `count` imperative matches, each with `matchText`.
 *
 * @param count - How many matches
 * @param matchText - Each match's text
 * @returns The record
 */
function recordOf(count: number, matchText = 'You should x.'): SkillTextFacts {
  const { family, id } = SKILL_TEXT_DECLARATION.imperative;
  return {
    lineCount: count + 1,
    h1: null,
    matches: Array.from({ length: count }, (_, ordinal) => ({ ordinal, family, patternId: id, line: ordinal + 1, matchText })),
  };
}

const SMALL = '# Big\n\nSee [a](./a.md).\n';

/**
 * A small document's real parse carrying a record one match past the bound: the
 * real document's parse is the integration tier's (`skill-text-held-bound`),
 * too slow for this one.
 *
 * @returns The parse
 */
function pastBound(): ParseResult {
  return { ...parseMarkdownContent(SMALL, SMALL.length), skillText: recordOf(PAST_BOUND_MATCHES) };
}

/**
 * The blob tier's rows for one parse with its record in place of the parse's own.
 *
 * @param parsed - The parse
 * @param record - The record the rows carry
 * @returns The rows
 */
function rowsWith(parsed: ParseResult, record: SkillTextFacts): BlobScopedRows {
  const skillText = skillTextRowsFor(KEY, record);
  return {
    blobs: [blobRowFor(KEY, parsed.sizeBytes, { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 }, { ...parsed, skillText: record })],
    blobReferences: blobReferencesFor(KEY, parsed),
    blobSections: blobSectionsFor(KEY, parsed.content, parsed.headings),
    blobConditions: blobConditionsFor(KEY, parsed),
    harnessBlobFacts: [],
    harnessBlobImports: [],
    skillTextFacts: [skillText.facts],
    skillTextMatches: skillText.matches,
  };
}

describe('the skill-text record is not counted against the parse output caps', () => {
  it('a parse whose record alone crosses outputRows and outputBytes breaches neither', () => {
    const limits = resolveParseLimits(undefined);
    const parsed = { ...pastBound(), skillText: recordOf(PAST_BOUND_MATCHES, 'x'.repeat(300)) };
    expect(countOutputRows({ skillText: parsed.skillText }), 'the record alone must cross the row cap').toBeGreaterThan(limits.outputRows);
    expect(Buffer.byteLength(JSON.stringify(parsed.skillText)), 'and the byte cap').toBeGreaterThan(limits.outputBytes);
    expect(outputBreach(parsed, limits)).toBeUndefined();
  });

  it('is not filed in the parse cache past its bound, and is filed at it', () => {
    const parsed = pastBound();
    expect(storableUnderDefaultLimits(parsed.sizeBytes, parsed)).toBe(false);
    expect(storableUnderDefaultLimits(parsed.sizeBytes, { ...parsed, skillText: recordOf(SKILL_TEXT_HELD_LIMITS.matches) })).toBe(true);
  });
});

describe('the bound the caches hold a record to', () => {
  it('holds a record at its match bound and not one match past it', () => {
    expect(skillTextHeld(recordOf(SKILL_TEXT_HELD_LIMITS.matches))).toBe(true);
    expect(skillTextHeld(recordOf(SKILL_TEXT_HELD_LIMITS.matches + 1))).toBe(false);
  });

  it('holds a record at its byte bound and not one byte past it', () => {
    const base = Buffer.byteLength(JSON.stringify(recordOf(1, '')));
    const room = SKILL_TEXT_HELD_LIMITS.bytes - base;
    expect(skillTextHeld(recordOf(1, 'a'.repeat(room)))).toBe(true);
    expect(skillTextHeld(recordOf(1, 'a'.repeat(room + 1)))).toBe(false);
  });
});

describe('a stored record past its bound', () => {
  it('is a facts row saying it is not held, with no match rows', () => {
    const rows = skillTextRowsFor(KEY, recordOf(PAST_BOUND_MATCHES));
    expect(rows.facts).toEqual({ blob: KEY, lineCount: PAST_BOUND_MATCHES + 1, h1: null, matchCount: PAST_BOUND_MATCHES, held: false });
    expect(rows.matches).toEqual([]);
  });

  it('reads back as no record, the rest of the blob\'s facts served', () => {
    const parsed = pastBound();
    const outcome = blobFactsReader(rowsWith(parsed, recordOf(PAST_BOUND_MATCHES)))(KEY);
    expect(outcome).toMatchObject({ kind: 'facts', facts: { contentKey: KEY, skillText: null } });
  });

  it('is no record in a cold resource\'s facts either, so cold and warm agree', () => {
    const parsed = pastBound();
    expect(blobResourceFactsOf(parsed, KEY).skillText).toBeNull();
    const atBound = recordOf(SKILL_TEXT_HELD_LIMITS.matches);
    expect(blobResourceFactsOf({ ...parsed, skillText: atBound }, KEY).skillText).toBe(atBound);
  });

  it('reads back in full at its bound', () => {
    const parsed = pastBound();
    const atBound = recordOf(SKILL_TEXT_HELD_LIMITS.matches);
    const outcome = blobFactsReader(rowsWith(parsed, atBound))(KEY);
    expect(outcome.kind === 'facts' && outcome.facts.skillText).toStrictEqual(atBound);
  });

  it('is uncovered when a record the rows say is not held has match rows', () => {
    const parsed = pastBound();
    const rows = rowsWith(parsed, recordOf(PAST_BOUND_MATCHES));
    const stray = skillTextRowsFor(KEY, recordOf(1)).matches;
    const outcome = blobFactsReader({ ...rows, skillTextMatches: stray })(KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('does not hold') });
  });
});
