/**
 * Shared bits for testing local CJS ESLint rules from TypeScript.
 *
 * Test files keep their own describe/it scaffolding so SonarJS recognizes
 * them as real test files; only the createRequire wiring and RuleTester
 * construction are shared.
 */

import { createRequire } from 'node:module';

import { type Rule, RuleTester } from 'eslint';

const requireRule = createRequire(import.meta.url);

/** Load a CJS rule module from `packages/dev-tools/eslint-local-rules/<filename>`. */
export function loadLocalRule(filename: string): Rule.RuleModule {
  return requireRule(`../eslint-local-rules/${filename}`) as Rule.RuleModule;
}

/**
 * Run every RuleTester case INLINE instead of registering nested suites.
 *
 * `vitest.shared.ts` sets `globals: true`, so ESLint's RuleTester finds global
 * `describe`/`it` and defers each case as a nested test. Registering tests from
 * inside an already-running Vitest test silently drops them: `ruleTester.run()`
 * returned without throwing no matter what the rule did, so the assertions below
 * were structurally blind — a rule could be gutted and this suite stayed green.
 * (Verified: removing one entry from require-justified-skip's disabling-members
 * set left all 12 tests passing until this override was added.)
 *
 * Forcing both hooks to invoke their callback immediately makes a failing case
 * throw synchronously into the enclosing `it`, which is what the `.not.toThrow()`
 * assertions in the rule suites actually depend on.
 */
RuleTester.describe = (_name: string, callback: () => void): void => { callback(); };
RuleTester.it = (_name: string, callback: () => void): void => { callback(); };

/** Shared RuleTester instance with our default languageOptions. */
export const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
  },
});

export type RuleCases = Parameters<RuleTester['run']>[2];
