import { describe, expect, it } from 'vitest';

import { lf, recordsOf } from './core-helpers.js';

const DEPENDENT = lf(
  '---',
  'description: x',
  '---',
  'This requires `acme:vat-enterprise-org` and `acme:other`.',
  'It depends on ANTHROPIC_ADMIN_API_KEY.',
  'Also ANTHROPIC_API_KEY. Requires ANTHROPIC_API_KEY.',
  'Requires `acme:vat-enterprise-org` again.',
  'x'.repeat(70),
  '`acme:unintroduced` alone.',
  'Requires ANTHROPIC_ORG_KEY.',
);

describe('crossSkillAuth (whole text)', () => {
  it('records the distinct introduced tokens: sibling refs, then env keys, in text order', () => {
    expect(recordsOf(DEPENDENT, 'crossSkillAuth')).toEqual([
      ['sibling-skill-ref', 4, 'acme:vat-enterprise-org'],
      ['sibling-skill-ref', 4, 'acme:other'],
      ['anthropic-env-key', 5, 'ANTHROPIC_ADMIN_API_KEY'],
      ['anthropic-env-key', 10, 'ANTHROPIC_ORG_KEY'],
    ]);
  });

  it('looks back exactly the declared window', () => {
    const inside = `requires ${'x'.repeat(51)}\`a:b\``;
    const outside = `requires ${'x'.repeat(52)}\`a:b\``;
    expect(recordsOf(inside, 'crossSkillAuth')).toEqual([['sibling-skill-ref', 1, 'a:b']]);
    expect(recordsOf(outside, 'crossSkillAuth')).toEqual([]);
  });

  it('sees an intro in the frontmatter, as the whole-text lane does', () => {
    const text = lf('---', 'description: requires', '---', '`a:b` here');
    expect(recordsOf(text, 'crossSkillAuth')).toEqual([['sibling-skill-ref', 4, 'a:b']]);
    expect(recordsOf(text, 'crossSkillAuthBody')).toEqual([]);
  });
});

describe('crossSkillAuthBody (the frontmatter parser body)', () => {
  it('records over the body, lines counted from the body', () => {
    expect(recordsOf(DEPENDENT, 'crossSkillAuthBody')).toEqual([
      ['sibling-skill-ref', 1, 'acme:vat-enterprise-org'],
      ['sibling-skill-ref', 1, 'acme:other'],
      ['anthropic-env-key', 2, 'ANTHROPIC_ADMIN_API_KEY'],
      ['anthropic-env-key', 7, 'ANTHROPIC_ORG_KEY'],
    ]);
  });

  it('normalizes CRLF, a lone CR and a BOM as the parser does', () => {
    const text = `${String.fromCodePoint(0xfe_ff)}---\r\ndescription: x\r\n---  \rline one\r\nrequires \`a:b\``;
    expect(recordsOf(text, 'crossSkillAuthBody')).toEqual([['sibling-skill-ref', 2, 'a:b']]);
  });

  it('has no body without both fences', () => {
    expect(recordsOf('requires `a:b`', 'crossSkillAuthBody')).toEqual([]);
    expect(recordsOf(lf('---', 'requires `a:b`'), 'crossSkillAuthBody')).toEqual([]);
    expect(recordsOf(lf('----', 'x', '---', 'requires `a:b`'), 'crossSkillAuthBody')).toEqual([]);
  });
});

describe('imperativeBody', () => {
  it('records second-person openers outside fences and quotes, body-relative', () => {
    const long = `You must ${'y'.repeat(100)}`;
    const text = lf(
      '---',
      'name: x',
      '---',
      'You should do X.',
      '```',
      'You can skip',
      '```',
      '> You must quote',
      '  You will indent',
      'you may lower',
      long,
      'Your call',
    );
    expect(recordsOf(text, 'imperativeBody')).toEqual([
      ['second-person-opener', 1, 'You should do X.'],
      ['second-person-opener', 7, 'you may lower'],
      ['second-person-opener', 8, long.slice(0, 80)],
    ]);
  });

  it('has no body without frontmatter', () => {
    expect(recordsOf('You should do X.', 'imperativeBody')).toEqual([]);
  });
});
