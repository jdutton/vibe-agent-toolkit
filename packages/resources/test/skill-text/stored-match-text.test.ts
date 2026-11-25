/**
 * A match's text survives a store that holds TEXT as UTF-8: it is written
 * well-formed, with each lone surrogate recorded beside it, and read back as
 * the core emitted it, code unit for code unit.
 */

import { describe, expect, it } from 'vitest';

import { parseMarkdownContent } from '../../src/link-parser.js';
import { blobConditionsFor, blobRowFor, skillTextRowsFor } from '../../src/projection/blob-facts.js';
import { blobReferencesFor } from '../../src/projection/blob-references.js';
import { blobFactsReader } from '../../src/projection/blob-resource-facts.js';
import { blobSectionsFor } from '../../src/projection/blob-sections.js';
import { restoredMatchText, storedMatchText } from '../../src/projection/skill-text-match-text.js';
import { skillTextFactsOf } from '../../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';

const KEY = `markdown.${'e'.repeat(64)}`;
const EMOJI = '\u{1F600}';

/** A SKILL.md whose imperative sample (80 code units) ends on an emoji's high surrogate. */
const SPLIT_SAMPLE = `---\nname: s\n---\n# S\n\nYou should ${'a'.repeat(68)}${EMOJI} tail\n`;

describe('a match text through the store', () => {
  it.each([
    ['clean', 'as of March 2024'],
    ['a whole pair', `x${EMOJI}y`],
    ['a lone high surrogate at the end', `${'a'.repeat(79)}\uD83D`],
    ['a lone low surrogate at the start', '\uDE00abc'],
    ['two lone surrogates around a pair', `\uD83Da${EMOJI}b\uDE00`],
    ['a real U+FFFD beside a lone surrogate', '�\uD83D'],
  ])('%s: stored well-formed, read back exactly', (_case, text) => {
    const stored = storedMatchText(text);
    expect(stored.matchText.isWellFormed()).toBe(true);
    expect(stored.matchText).toHaveLength(text.length);
    expect(stored.loneSurrogates === null).toBe(text.isWellFormed());
    expect(restoredMatchText(stored.matchText, stored.loneSurrogates)).toBe(text);
  });

  it.each([
    ['an empty list', 'a�', []],
    ['an index the text holds no U+FFFD at', 'ab', [[0, 0xd8_3d]]],
    ['a code unit that is not a surrogate', 'a�', [[1, 0x61]]],
    ['indexes out of order', '��', [[1, 0xd8_3d], [0, 0xd8_3d]]],
  ] as const)('refuses %s', (_case, text, lone) => {
    expect(restoredMatchText(text, lone)).toBeUndefined();
  });

  it('the imperative sample cut inside a surrogate pair is the core\'s record after a stored round trip', () => {
    const parsed = parseMarkdownContent(SPLIT_SAMPLE, SPLIT_SAMPLE.length);
    const record = skillTextFactsOf(SPLIT_SAMPLE, SKILL_TEXT_DECLARATION);
    const sample = record.matches.find((match) => match.family === SKILL_TEXT_DECLARATION.imperative.family)?.matchText;
    expect(sample?.endsWith('\uD83D'), 'the sample must end on a lone high surrogate').toBe(true);
    const skillText = skillTextRowsFor(KEY, record);
    expect(skillText.matches.every((row) => row.matchText.isWellFormed())).toBe(true);
    const outcome = blobFactsReader({
      blobs: [blobRowFor(KEY, SPLIT_SAMPLE.length, { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 }, parsed)],
      blobReferences: blobReferencesFor(KEY, parsed),
      blobSections: blobSectionsFor(KEY, SPLIT_SAMPLE, parsed.headings),
      blobConditions: blobConditionsFor(KEY, parsed),
      skillTextFacts: [skillText.facts],
      skillTextMatches: skillText.matches,
    }).outcome(KEY);
    expect(outcome.kind === 'facts' && outcome.facts.skillText).toStrictEqual(record);
  });
});
