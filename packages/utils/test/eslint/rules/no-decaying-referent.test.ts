/**
 * `no-decaying-referent` — comments under `src/` may not cite an issue/PR
 * number, an ISO date, or a named person. The VALID cases pin what must NOT
 * fire (hex-ish tokens, six-digit numbers, years without a month, test files,
 * non-src files), and the INVALID ones pin one report per comment block even
 * when the block carries several referents.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-decaying-referent';
const SRC = '/repo/packages/resources/src/projection/identity.ts';
const TEST = '/repo/packages/resources/test/identity.test.ts';
const NOT_SRC = '/repo/packages/resources/scripts/generate.ts';

const CASES: RuleCases = {
  valid: [
    { code: '// keep the rule, not the history\nconst a = 1;', filename: SRC },
    { code: '/** The root is resolved once per run. */\nconst a = 1;', filename: SRC },
    // A number that is not an issue reference.
    { code: '// port 8080 and 5 retries\nconst a = 1;', filename: SRC },
    { code: '// css #123456 is a colour, six digits\nconst a = 1;', filename: SRC },
    { code: '// item#1 is a single digit\nconst a = 1;', filename: SRC },
    { code: '// see &#39; entities\nconst a = 1;', filename: SRC },
    // A year alone, or a version, is not a date.
    { code: '// ES2024 target since 2024\nconst a = 1;', filename: SRC },
    { code: '// v2024.1 and 2024-1-1 are not ISO dates\nconst a = 1;', filename: SRC },
    // A date glued into an identifier or a path segment names a thing, not a day:
    // a JSON Schema dialect, a sweep directory.
    { code: '// $schema: https://json-schema.org/draft/2020-12/schema\nconst a = 1;', filename: SRC },
    { code: '// the draft/2019-09 dialect\nconst a = 1;', filename: SRC },
    { code: '// see sweep-2026-09-12/report.md\nconst a = 1;', filename: SRC },
    // Names are matched as whole words, case-sensitively.
    { code: '// jeffrey the variable, not the person\nconst a = 1;', filename: SRC },
    { code: '// the Jeffersonian reading\nconst a = 1;', filename: SRC },
    // Tests and non-src files are out of scope.
    { code: '// fixed in #145 on 2026-08-22 by Jeff\nconst a = 1;', filename: TEST },
    { code: '// fixed in #145 on 2026-08-22\nconst a = 1;', filename: NOT_SRC },
    // Dates allowed by option.
    { code: '// re-derived 2026-08-22\nconst a = 1;', filename: SRC, options: [{ allowDates: true }] },
    // A name removed from the list is no longer a referent.
    { code: '// Jeff ruled\nconst a = 1;', filename: SRC, options: [{ names: [] }] },
    // Not a comment: the string is data.
    { code: "const a = '#145 on 2026-08-22 by Jeff';", filename: SRC },
    // A `@vendor-claim reviewed=<date>` line is read by the structure gate's
    // freshness check — a date with a mechanism behind it is not a decaying one.
    { code: '// @vendor-claim reviewed=2026-09-06 verify=re-fetch the page\nconst a = 1;', filename: SRC },
    {
      code: '/**\n * The vendor documents a 30 MB ceiling.\n *\n * @vendor-claim reviewed=2026-07-29 verify=upload two bundles either side of it\n */\nconst a = 1;',
      filename: SRC,
    },
  ],
  invalid: [
    { code: '// fixed in #145\nconst a = 1;', filename: SRC, errors: [{ messageId: 'decayingReferent', data: { kind: 'an issue or PR number', referent: '#145' } }] },
    { code: '// see PR #42\nconst a = 1;', filename: SRC, errors: [{ messageId: 'decayingReferent', data: { kind: 'an issue or PR number', referent: '#42' } }] },
    { code: '// tracked as #1234\nconst a = 1;', filename: SRC, errors: [{ messageId: 'decayingReferent' }] },
    { code: '// re-derived 2026-08-22\nconst a = 1;', filename: SRC, errors: [{ messageId: 'decayingReferent', data: { kind: 'a date', referent: '2026-08-22' } }] },
    { code: '// stale since 2026-08\nconst a = 1;', filename: SRC, errors: [{ messageId: 'decayingReferent', data: { kind: 'a date', referent: '2026-08' } }] },
    { code: '// Jeff ruled this way\nconst a = 1;', filename: SRC, errors: [{ messageId: 'decayingReferent', data: { kind: 'a person', referent: 'Jeff' } }] },
    // A configured extra name.
    { code: '// Alice asked for this\nconst a = 1;', filename: SRC, options: [{ names: ['Jeff', 'Alice'] }], errors: [{ messageId: 'decayingReferent', data: { kind: 'a person', referent: 'Alice' } }] },
    // Block comments, JSDoc included, and only ONE report per block however many referents it holds.
    {
      code: '/**\n * Added in #113, revised #145 on 2026-09-06 (Jeff).\n */\nconst a = 1;',
      filename: SRC,
      errors: [{ messageId: 'decayingReferent', data: { kind: 'an issue or PR number', referent: '#113' }, line: 2 }],
    },
    // The report lands on the referent's own line inside a multi-line block.
    {
      code: '/*\n * first line clean\n * second cites 2026-01-01\n */\nconst a = 1;',
      filename: SRC,
      errors: [{ messageId: 'decayingReferent', data: { kind: 'a date', referent: '2026-01-01' }, line: 3 }],
    },
    // Two separate comments are two reports.
    {
      code: '// #145\nconst a = 1;\n// #146\nconst b = 2;',
      filename: SRC,
      errors: [{ messageId: 'decayingReferent' }, { messageId: 'decayingReferent' }],
    },
    // allowDates leaves the OTHER classes armed.
    { code: '// #145 on 2026-08-22\nconst a = 1;', filename: SRC, options: [{ allowDates: true }], errors: [{ messageId: 'decayingReferent', data: { kind: 'an issue or PR number', referent: '#145' } }] },
    // Windows separators still resolve to src.
    { code: '// #145\nconst a = 1;', filename: String.raw`C:\repo\packages\cli\src\bin.ts`, errors: [{ messageId: 'decayingReferent' }] },
    // The `@vendor-claim` exemption covers ONLY its own line: a date elsewhere
    // in the same block is still reported, at its own position.
    {
      code: '/**\n * Re-verified on 2026-07-30.\n *\n * @vendor-claim reviewed=2026-07-30 verify=re-fetch\n */\nconst a = 1;',
      filename: SRC,
      errors: [{ messageId: 'decayingReferent', data: { kind: 'a date', referent: '2026-07-30' }, line: 2, column: 19 }],
    },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
