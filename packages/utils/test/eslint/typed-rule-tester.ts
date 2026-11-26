/**
 * The type-aware twin of `rule-tester.ts`: a `RuleTester` whose cases get a real TypeScript
 * program, for the rules that ask the type checker rather than read syntax
 * (`content-key-opaque`).
 *
 * Every case is parsed through typescript-eslint's project service against
 * `fixtures/typed-program/tsconfig.json`. A case's `filename` must sit under {@link TYPED_FIXTURE_DIR}
 * (use {@link typedCaseFile}); the file need not exist on disk, the service opens it with the case's
 * code. The fixture holds no `.ts` file of its own, so nothing in it joins the package's program.
 *
 * Importing `rule-tester.ts` runs its `RuleTester.describe`/`it` override, so a failing case throws
 * into the enclosing `it` here as well.
 */

import * as tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import { expect } from 'vitest';

import { resolveFromImportMeta } from '../../src/fs.js';
import { safePath } from '../../src/path-utils.js';

import { loadLocalRule, type RuleCases } from './rule-tester.js';

/** The directory holding the typed cases' `tsconfig.json`. */
export const TYPED_FIXTURE_DIR = resolveFromImportMeta(import.meta.url, 'fixtures', 'typed-program');

/** Where a typed case's file may sit, relative to the fixture: the shapes of a repo's source paths. */
const TYPED_CASE_GLOBS = ['*.ts', '*/*.ts', 'packages/*/src/*.ts', 'packages/*/test/*.ts'];

/** An absolute case filename under the typed fixture, from its path relative to it. */
export function typedCaseFile(relative: string): string {
  return safePath.join(TYPED_FIXTURE_DIR, relative);
}

/** One RuleTester whose every case is typed by the fixture's program. */
export const typedRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
    parser: tsParser,
    parserOptions: {
      // A case's file is not on disk, so no tsconfig `include` matches it: the service types it
      // in its default project, under the fixture's compiler options. Globs here take no `**`.
      projectService: {
        allowDefaultProject: TYPED_CASE_GLOBS,
        defaultProject: 'tsconfig.json',
      },
      tsconfigRootDir: TYPED_FIXTURE_DIR,
    },
  },
});

/** {@link expectRulePasses} for a type-aware rule: run its case table under the typed tester. */
export function expectTypedRulePasses(name: string, cases: RuleCases): void {
  const rule = loadLocalRule(`${name}.cjs`);
  expect(() => { typedRuleTester.run(name, rule, cases); }).not.toThrow();
}
