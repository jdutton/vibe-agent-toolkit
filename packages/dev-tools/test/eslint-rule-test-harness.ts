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

/** Shared RuleTester instance with our default languageOptions. */
export const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
  },
});

export type RuleCases = Parameters<RuleTester['run']>[2];
