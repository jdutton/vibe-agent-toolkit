/**
 * `index.cjs` refuses a malformed rule at LOAD time, so a rule that ships
 * without a description, without a boolean `recommended`, with a severity
 * outside `error | warn`, recommended without a severity, or with a `meta` but
 * no `create` fails every consumer's `eslint` run at startup rather than
 * landing silently outside `recommended` (or crashing the first lint that
 * reaches it). Nothing exercised those refusals: today's rules all pass, so
 * deleting `validateRuleDocs` left the manifest suite green. Each fixture
 * directory here holds exactly one offender.
 */

import { describe, expect, it } from 'vitest';

import { resolveFromImportMeta } from '../../src/fs.js';
import { safePath } from '../../src/path.js';

import { loadEslintModule } from './rule-tester.js';

interface Plugin {
  __internal: { discoverRules: (rulesDir: string) => Record<string, unknown> };
}

const { discoverRules } = loadEslintModule<Plugin>('index.cjs').__internal;
const FIXTURES = resolveFromImportMeta(import.meta.url, 'fixtures', 'malformed-rules');

describe('rule discovery refuses a malformed rule module at load time', () => {
  it.each([
    ['no-description', /no meta\.docs\.description/],
    ['recommended-not-boolean', /recommended as a boolean/],
    ['bad-severity', /outside 'error' \| 'warn'/],
    ['recommended-without-severity', /declares no meta\.docs\.recommendedSeverity/],
    ['meta-without-create', /no create/],
  ])('%s', (fixture, message) => {
    expect(() => discoverRules(safePath.join(FIXTURES, fixture))).toThrow(message);
  });

  it('admits a well-formed rule, keyed by basename — so the refusals above are not "everything throws"', () => {
    expect(Object.keys(discoverRules(safePath.join(FIXTURES, 'well-formed')))).toEqual(['rule']);
  });
});
