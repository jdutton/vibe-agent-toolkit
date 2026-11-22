import { describe, expect, it } from 'vitest';

import { SkillTextFactsSchema } from '../../src/schemas/skill-text-facts.js';
import { skillTextFactsOf } from '../../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';

const FACTS = skillTextFactsOf(
  ['---', 'description: x', '---', '# Title', 'as of March 2024 requires `a:b`', '`get_me` mcp__x__get_me'].join('\n'),
  SKILL_TEXT_DECLARATION,
);

describe('SkillTextFactsSchema', () => {
  it('accepts the core output through a JSON round trip', () => {
    expect(FACTS.matches.length).toBeGreaterThan(2);
    const stored = JSON.stringify(FACTS);
    const roundTripped: unknown = JSON.parse(stored);
    expect(SkillTextFactsSchema.parse(roundTripped)).toEqual(FACTS);
  });

  const first = FACTS.matches[0];
  it.each([
    ['an extra key', { ...FACTS, extra: 1 }],
    ['an extra match key', { ...FACTS, matches: [{ ...first, extras: {} }] }],
    ['a zero line count', { ...FACTS, lineCount: 0 }],
    ['an undefined h1', { ...FACTS, h1: undefined }],
    ['an unknown family', { ...FACTS, matches: [{ ...first, family: 'nope' }] }],
    ['an unknown pattern', { ...FACTS, matches: [{ ...first, patternId: 'nope' }] }],
    ['a pattern of another family', { ...FACTS, matches: [{ ...first, family: 'nonPortableCommand' }] }],
    ['an ordinal out of place', { ...FACTS, matches: [{ ...first, ordinal: 1 }] }],
    ['a zero line', { ...FACTS, matches: [{ ...first, line: 0 }] }],
    ['a fractional line', { ...FACTS, matches: [{ ...first, line: 1.5 }] }],
    [
      'families out of emission order',
      { ...FACTS, matches: [...FACTS.matches].reverse().map((match, ordinal) => ({ ...match, ordinal })) },
    ],
  ])('rejects %s', (_label, value) => {
    expect(SkillTextFactsSchema.safeParse(value).success).toBe(false);
  });
});
