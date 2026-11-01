/**
 * The ESLint-instance ban (`ESLINT_INSTANCE_BAN` in `eslint.config.js`), fired on fixtures: an
 * `ESLint` may be constructed only through `repoEslint`, because one constructed with caching off
 * deletes `<cwd>/.eslintcache` on `lintFiles` — the developer's lint cache, when `cwd` is the repo.
 *
 * `bun run lint` proves the tree holds no such construction today. This proves the rule can FIRE on
 * every way of reaching the class, that type imports and the other members (`Linter`, `RuleTester`)
 * stay allowed, and that `ESLINT_INSTANCE_FILES` is exact: every listed file exists and still
 * constructs one, and is exempt from this ban and nothing else.
 *
 * Integration tier: it loads the repo's whole ESLint config.
 */

import { readFileSync } from 'node:fs';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { ESLINT_INSTANCE_FILES } from '../../../../eslint.config.js';
import { BAN_RULES, banLinter } from '../eslint-clean-files.js';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');

const [STATIC_BAN, DYNAMIC_BAN] = BAN_RULES;

const banFindings = banLinter(REPO_ROOT);

const A_TEST = 'packages/cli/test/second-linter.test.ts';

/** Every way to reach `ESLint`, and the rule that must report it. */
const SHAPES: ReadonlyArray<readonly [what: string, code: string, rule: string]> = [
  ['a named import', "import { ESLint } from 'eslint';\nexport const E = ESLint;\n", STATIC_BAN],
  ['a renamed import', "import { ESLint as Linting } from 'eslint';\nexport const E = Linting;\n", STATIC_BAN],
  ['loadESLint', "import { loadESLint } from 'eslint';\nexport const load = loadESLint;\n", STATIC_BAN],
  ['the default import', "import eslint from 'eslint';\nexport const E = eslint.ESLint;\n", STATIC_BAN],
  ['a namespace import', "import * as eslint from 'eslint';\nexport const E = eslint.ESLint;\n", STATIC_BAN],
  ['a re-export', "export { ESLint } from 'eslint';\n", STATIC_BAN],
  ['the legacy entry', "import { FlatESLint } from 'eslint/use-at-your-own-risk';\nexport const E = FlatESLint;\n", STATIC_BAN],
  ['a TypeScript import-equals', "import eslint = require('eslint');\nexport const E = eslint.ESLint;\n", DYNAMIC_BAN],
  ['a lazy import', "export const load = (): Promise<unknown> => import('eslint');\n", DYNAMIC_BAN],
  ['a lazy import as a template literal', 'export const load = (): Promise<unknown> => import(`eslint`);\n', DYNAMIC_BAN],
  ['a lazy import of the legacy entry', "export const load = (): Promise<unknown> => import('eslint/use-at-your-own-risk');\n", DYNAMIC_BAN],
  ['a require', "export const eslint: unknown = require('eslint');\n", DYNAMIC_BAN],
  ['createRequire called in place', "import { createRequire } from 'node:module';\nexport const eslint: unknown = createRequire(import.meta.url)('eslint');\n", DYNAMIC_BAN],
  ['a require made by createRequire', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const eslint: unknown = require('eslint');\n", DYNAMIC_BAN],
  ['a createRequire result under another name', "import { createRequire } from 'node:module';\nconst requireFn = createRequire(import.meta.url);\nexport const eslint: unknown = requireFn('eslint');\n", DYNAMIC_BAN],
  ['a renamed createRequire', "import { createRequire as cr } from 'node:module';\nexport const eslint: unknown = cr(import.meta.url)('eslint');\n", DYNAMIC_BAN],
  ['createRequire off the module object', "import nodeModule from 'node:module';\nexport const eslint: unknown = nodeModule.createRequire(import.meta.url)('eslint');\n", DYNAMIC_BAN],
  ['require.call', "export const eslint: unknown = require.call(null, 'eslint');\n", DYNAMIC_BAN],
  ['a createRequire result named req', "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const eslint: unknown = req('eslint');\n", DYNAMIC_BAN],
];

describe('the ESLint-instance ban', () => {
  it.each(SHAPES)('fires on %s', async (_what, code, rule) => {
    const findings = await banFindings(A_TEST, code);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`${rule}: `);
    expect(findings[0]).toContain('repoEslint');
  });

  it.each([
    ['product source', 'packages/cli/src/second-linter.ts'],
    ['a dev tool script', 'packages/dev-tools/second-linter.mjs'],
    ['a .mts test helper', 'packages/cli/test/helpers/second-linter.mts'],
    ['.mts product source', 'packages/cli/src/second-linter.mts'],
    ['the archive module', 'packages/utils/src/archive/second-linter.ts'],
    ['the VatError base class', 'packages/utils/src/errors/vat-error.ts'],
  ])('fires in %s', async (_where, file) => {
    expect(await banFindings(file, "import { ESLint } from 'eslint';\nexport const E = ESLint;\n")).toEqual([expect.stringContaining(`${STATIC_BAN}: `)]);
    expect(await banFindings(file, "export const load = () => import('eslint');\n")).toEqual([expect.stringContaining(`${DYNAMIC_BAN}: `)]);
  });

  it.each([
    ['require', "const { ESLint } = require('eslint');\nmodule.exports = ESLint;\n"],
    ['module.require', "const { ESLint } = module.require('eslint');\nmodule.exports = ESLint;\n"],
  ])('fires on %s in a CommonJS rule module', async (_what, code) => {
    expect(await banFindings('packages/utils/eslint/rules/second-linter.cjs', code)).toEqual([expect.stringContaining(`${DYNAMIC_BAN}: `)]);
  });

  it('allows a type import and the members that construct no ESLint', async () => {
    const code = [
      "import type { ESLint } from 'eslint';",
      "import { Linter, RuleTester, type Rule } from 'eslint';",
      "import js from '@eslint/js';",
      "import scope from 'eslint-scope';",
      'export const all: unknown[] = [Linter, RuleTester, js, scope];',
      'export type Both = ESLint.Options | Rule.RuleModule;',
      '',
    ].join('\n');

    expect(await banFindings(A_TEST, code)).toEqual([]);
  });

  describe.each(ESLINT_INSTANCE_FILES)('the exempt file %s', (file) => {
    it('exists and still constructs an ESLint', () => {
      expect(readFileSync(safePath.join(REPO_ROOT, file), 'utf8')).toContain('new ESLint(');
    });

    it('may import ESLint', async () => {
      expect(await banFindings(file, "import { ESLint } from 'eslint';\nexport const E = ESLint;\n")).toEqual([]);
    });

    it('keeps every other restriction of the two rules', async () => {
      expect(await banFindings(file, "import yaml from 'js-yaml';\nexport const load = yaml.load;\n")).toEqual([expect.stringContaining(`${STATIC_BAN}: `)]);
      expect(await banFindings(file, "export const load = (): Promise<unknown> => import('tar');\n")).toEqual([expect.stringContaining(`${DYNAMIC_BAN}: `)]);
    });
  });
});
