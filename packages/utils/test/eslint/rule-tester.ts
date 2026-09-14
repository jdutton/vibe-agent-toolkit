/**
 * Shared harness for testing the CJS ESLint rules in `packages/utils/eslint/rules/`
 * from TypeScript.
 *
 * Every per-rule suite in `test/eslint/rules/<rule>.test.ts` imports from here:
 * the `createRequire` wiring that loads a `.cjs` rule, ONE configured
 * `RuleTester` (ESLint 9 flat config + the TypeScript parser), and the
 * `runRuleSuite` shape that gives each rule the same two assertions — a valid
 * `meta` and a passing RuleTester case table. Test files keep their own
 * `describe`/`it` scaffolding so SonarJS recognizes them as real test files.
 */

import { createRequire } from 'node:module';

import * as tsParser from '@typescript-eslint/parser';
import { type Rule, RuleTester } from 'eslint';
import { expect } from 'vitest';

const requireRule = createRequire(import.meta.url);

/** Load any CJS module from `packages/utils/eslint/<relative path>`. */
export function loadEslintModule<T>(relativePath: string): T {
  return requireRule(`../../eslint/${relativePath}`) as T;
}

/** Load any CJS module from `packages/utils/eslint/rules/<filename>`. */
export function loadLocalRuleModule<T>(filename: string): T {
  return loadEslintModule<T>(`rules/${filename}`);
}

/** Load a CJS rule module from `packages/utils/eslint/rules/<filename>`. */
export function loadLocalRule(filename: string): Rule.RuleModule {
  return loadLocalRuleModule<Rule.RuleModule>(filename);
}

/**
 * Run every RuleTester case INLINE instead of registering nested suites.
 *
 * `vitest.shared.ts` sets `globals: true`, so ESLint's RuleTester finds global
 * `describe`/`it` and defers each case as a nested test. Registering tests from
 * inside an already-running Vitest test silently drops them: `ruleTester.run()`
 * returned without throwing no matter what the rule did, so the assertions
 * were structurally blind — a rule could be gutted and the suite stayed green.
 * (Verified twice. Gutting a rule under test left every case passing until this
 * override was added; afterwards the same mutation fails with RuleTester's own
 * "Should have 1 error but had 0". The mutation was performed on a scratch COPY
 * of a rule, never on a shipped one.)
 *
 * Forcing both hooks to invoke their callback immediately makes a failing case
 * throw synchronously into the enclosing `it`, which is what the
 * `.not.toThrow()` assertions in the rule suites actually depend on.
 */
RuleTester.describe = (_name: string, callback: () => void): void => { callback(); };
RuleTester.it = (_name: string, callback: () => void): void => { callback(); };

/**
 * Shared RuleTester: ESLint 9 flat config, ES2024 modules, parsed by
 * `@typescript-eslint/parser` so a case may carry TypeScript syntax (`import
 * type`, `as`, type-position `import()`) without per-case `languageOptions`.
 * The parser is a strict superset of espree for the ESTree shapes the rules
 * visit, so plain-JS cases lint identically.
 */
export const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
    parser: tsParser,
  },
});

export type RuleCases = Parameters<RuleTester['run']>[2];
export type ValidCase = RuleCases['valid'][number];
export type InvalidCase = RuleCases['invalid'][number];

/** Title of the RuleTester leg every rule suite has — one string, so a grep finds them all. */
export const RULE_TESTER_CASES = 'passes RuleTester cases';

/**
 * Run one rule's case table and fail the enclosing `it` if any case does.
 *
 * `name` is the rule id without namespace and the file basename (`<name>.cjs`).
 * Called from inside each suite's own `it(RULE_TESTER_CASES, …)` rather than
 * registering that `it` here: SonarJS decides whether a file is a test file by
 * finding an `it`/`test` call in it, and a file whose only test lives in a
 * helper reads to it as empty. Whether every shipped rule has a well-formed
 * `meta` is asserted once, pack-wide, in `../rule-manifest.test.ts`.
 */
export function expectRulePasses(name: string, cases: RuleCases): void {
  const rule = loadLocalRule(`${name}.cjs`);
  expect(() => { ruleTester.run(name, rule, cases); }).not.toThrow();
}
