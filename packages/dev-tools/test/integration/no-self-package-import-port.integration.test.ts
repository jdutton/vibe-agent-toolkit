/**
 * The `no-self-package-import` check in `vibe-agent-toolkit.config.yaml` replaces this repository's
 * usage of `local/no-self-package-import` (the per-package blocks `selfImportConfigs()` carried in
 * `eslint.config.js`). This proves the port exactly as strong as that usage, both ways (SPEC section
 * 11): over this repository's git content and over a corpus of every form the rule visits and every
 * form it skips, the `(file, line)` set the rule reports equals the check's findings, and the files
 * the check examines equal the files ESLint's own config resolution enables the rule for.
 *
 * The rule is configured exactly as the deleted block configured it: one block per workspace
 * package, files `packages/<dir>/src/**` `.ts` and `.cts`, option `packageName`, laid over the
 * repository's own config, so its global ignores and git-ignored patterns still decide the files.
 *
 * Integration tier: it runs the built `vat` and lints with ESLint's API.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import type { Linter } from 'eslint';
import picomatch from 'picomatch';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  expectRepositoryArm,
  portTempDirs,
  bothWays,
  byText,
  configOfShippedChecks,
  importEslintConfigSupport,
  localPlugin,
  markedLines,
  REPO_ROOT,
  ruleSide as portRuleSide,
  runCheck,
  runCheckOverRepository,
  vatQuery,
  writeCommittedTree,
  type CheckAnswer,
} from '../check-port-differential.js';
import { importRootEslintConfig, treeFiles } from '../eslint-clean-files.js';

const RULE = 'local/no-self-package-import';
const CHECK = { name: 'no-self-package-import', population: 'owned' } as const;

/** A workspace package as the deleted block read one: its directory under `packages/`, and its name. */
interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
}

const { workspacePackages } = await importEslintConfigSupport<{ readonly workspacePackages: () => WorkspacePackage[] }>();
/** The repository's own flat config, loaded once: the deleted blocks are laid over it. */
const { default: repoConfig } = await importRootEslintConfig<{ readonly default: Linter.Config[] }>();
const localRules = localPlugin(repoConfig);

/** The deleted `selfImportConfigs()`, verbatim but for its package list: one block per package. */
function selfImportBlocks(packages: readonly WorkspacePackage[]): Linter.Config[] {
  return packages.map(({ dir, name }) => ({
    files: [`packages/${dir}/src/**/*.ts`, `packages/${dir}/src/**/*.cts`],
    plugins: { local: localRules },
    rules: { [RULE]: ['error', { packageName: name }] },
  }));
}

/** The rule's side over one tree, under the repository's config plus the deleted blocks for `packages`. */
function ruleSide(root: string, packages: readonly WorkspacePackage[], candidates: readonly string[]): ReturnType<typeof portRuleSide> {
  return portRuleSide({ root, baseConfig: repoConfig, blocks: selfImportBlocks(packages), rule: RULE, candidates });
}

// ── The corpus ──────────────────────────────────────────────────────────────
// Every line the rule must report carries `// visits`; every form it skips is unmarked.

const CORPUS_PACKAGES: readonly WorkspacePackage[] = [
  { dir: 'a', name: '@acme/a' },
  // `_` is a LIKE wildcard: a check comparing with LIKE would report `@acme/bXx`.
  { dir: 'b', name: '@acme/b_x' },
  { dir: 'ab', name: '@acme/a-b' },
];

const VISITS = String.raw`import { one } from '@acme/a'; // visits
import type { Two } from '@acme/a/types'; // visits
import {
  three,
} from
  '@acme/a/three'; // visits
export { four } from '@acme/a'; // visits
export type { Five } from '@acme/a'; // visits
export * from '@acme/a/six'; // visits
export * as seven from '@acme/a'; // visits
import '@acme/a/side-effect'; // visits
import { type Eight } from "\x40acme/a"; // visits
export const nine = import('@acme/a'); // visits
export const ten = import(
  '@acme/a/ten' // visits
);
export const eleven = import('@acme/a', { with: { type: 'json' } }); // visits
export type Twelve = import('@acme/a').Twelve; // visits
export type Thirteen = typeof import(
  '@acme/a/thirteen' // visits
);
export function nested(): unknown {
  return require('@acme/a'); // visits
}
export const fourteen = (require)('@acme/a'); // visits
export const fifteen = require?.('@acme/a'); // visits
export const parenthesized = import(('@acme/a/parenthesized')); // visits, parenthesized
export const parenthesizedRequire = require(('@acme/a/parenthesized')); // visits, parenthesized
export const sixteen = require(
  '@acme/a/sixteen', // visits
);
declare module 'ambient-host' {
  import { inner } from '@acme/a/inner'; // visits
}
export const trailing = '@acme/a/'; // a string, not a reference
export const used = [one, three, four, nine, ten, eleven, fourteen, fifteen, sixteen, parenthesized, parenthesizedRequire];
export type Used = [Two, Five, Eight, Twelve, Thirteen];
`;

const SKIPS = `import eq = require('@acme/a');
declare module '@acme/a' {
  export const declared: number;
}
/** @type {import('@acme/a').X} */
export const jsdoc = 1;
export const template = import(\`@acme/a\`);
export const templateRequire = require(\`@acme/a\`);
export const twoArguments = require('@acme/a', 'extra');
export const noArguments = require();
import { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
export const viaCreate = load('@acme/a');
export const direct = createRequire(import.meta.url)('@acme/a');
export const prefixName = import('@acme/a-b');
export const sibling = import('@acme/b_x');
export const upperCase = import('@ACME/a');
export const concatenated = require('@acme/' + 'a');
export const member = module.require('@acme/a');
export const used = [eq];
`;

/** Files under a member's `src/` that a global ignore of `eslint.config.js` keeps from the rule. */
const GLOBALLY_IGNORED: Readonly<Record<string, string>> = {
  'packages/a/src/declarations.d.ts': "import '@acme/a';\n",
  'packages/a/src/declarations.d.cts': "import '@acme/a';\n",
  'packages/a/src/build.config.ts': "import '@acme/a';\n",
  'packages/a/src/test/fixtures/fixture.ts': "import '@acme/a';\n",
  'packages/a/src/test-fixtures/fixture.ts': "import '@acme/a';\n",
  'packages/a/src/transformer-fixtures/fixture.ts': "import '@acme/a';\n",
  'packages/a/src/resources/skills/evals/eval.ts': "import '@acme/a';\n",
};

/**
 * Files under a member's `src/` in directories git ignores as well as ESLint, tracked anyway
 * (`git add -f`): git content, so routed, and kept from the rule by the config's global ignores.
 */
const FORCE_TRACKED: Readonly<Record<string, string>> = {
  'packages/a/src/generated/emitted.ts': "import '@acme/a';\n",
  'packages/a/src/dist/built.ts': "import '@acme/a';\n",
  'packages/a/src/.tsc-staging/staged.ts': "import '@acme/a';\n",
};

const CORPUS: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': configOfShippedChecks([CHECK.name]),
  // The repository's own ignore file, so git and the config's git-ignored patterns agree here too.
  '.gitignore': readFileSync(safePath.join(REPO_ROOT, '.gitignore'), 'utf-8'),
  'package.json': `${JSON.stringify({ name: 'acme-root', private: true, workspaces: ['packages/*'] })}\n`,
  ...Object.fromEntries(CORPUS_PACKAGES.map(({ dir, name }) => [`packages/${dir}/package.json`, `${JSON.stringify({ name })}\n`])),
  'packages/a/src/visits.ts': VISITS,
  'packages/a/src/skips.ts': SKIPS,
  'packages/a/src/triple-slash.ts': '/// <reference types="@acme/a" />\n/// <reference path="./visits.ts" />\nexport const triple = 1;\n',
  'packages/a/src/named-require.ts': "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const named = require('@acme/a'); // visits\n",
  'packages/a/src/common.cts': "const self = require('@acme/a/common'); // visits\nimport eq = require('@acme/a/equals');\nexport = [self, eq];\n",
  'packages/a/src/arbitrary.d.css.ts': "import '@acme/a'; // visits\n",
  // Extensions the deleted block never named: no rule, no check.
  'packages/a/src/module.mts': "import '@acme/a';\n",
  'packages/a/src/view.tsx': "import '@acme/a';\nexport const View = () => <div />;\n",
  'packages/a/src/plain.js': "import '@acme/a';\n",
  // Outside `src/`: test trees import their own package on purpose, and `srcx` is not `src`.
  'packages/a/test/self.test.ts': "import '@acme/a';\n",
  'packages/a/srcx/near.ts': "import '@acme/a';\n",
  // Not a member: the root, and a package with no name.
  'src/root.ts': "import 'acme-root';\n",
  'packages/noname/package.json': '{}\n',
  'packages/noname/src/unnamed.ts': "import '@acme/a';\n",
  'packages/b/src/b.ts': "import '@acme/b_x/deep'; // visits\nimport '@acme/bXx';\nimport '@acme/a';\n",
  'packages/ab/src/ab.ts': "import '@acme/a';\nimport '@acme/a-b'; // visits\n",
  ...GLOBALLY_IGNORED,
};

/** Every corpus file: the committed tree and the force-tracked one. */
const ALL_FILES = [...Object.keys(CORPUS), ...Object.keys(FORCE_TRACKED)];

/** A specifier in parentheses, `import(('m'))` or `require(('m'))`: ESTree drops the parentheses, and so does the row. */
const PARENTHESIZED = markedLines(CORPUS, '// visits, parenthesized');

/** Every routed `.ts`/`.cts` file under some package's `src/`: the population with no ignore mirrored and no owner asked for. */
const UNFILTERED = picomatch(['packages/*/src/**/*.ts', 'packages/*/src/**/*.cts'], { dot: true });
/** The package with no name, which owns nothing. */
const UNOWNED = picomatch('packages/noname/**', { dot: true });

describe('the no-self-package-import port', () => {
  const dirs = portTempDirs('vat-self-import-port-', CORPUS, FORCE_TRACKED);
  let clean: CheckAnswer;

  beforeAll(() => {
    clean = runCheck(dirs.corpus, dirs.cache, CHECK);
  });

  it('is exactly as strong as the rule over this repository, both ways', async () => {
    const answer = runCheckOverRepository(CHECK);
    const rule = await ruleSide(REPO_ROOT, workspacePackages(), treeFiles(REPO_ROOT, ['packages/*/src/**/*']));

    expectRepositoryArm(answer, rule);
  });

  it('is exactly as strong as the rule over every form it visits and skips, both ways', async () => {
    const rule = await ruleSide(dirs.corpus, CORPUS_PACKAGES, ALL_FILES);

    expect(clean.runFindings).toStrictEqual([]);
    // Neither side is blind: each reports exactly the marked lines.
    expect(rule.reports).toStrictEqual(markedLines(CORPUS, '// visits'));
    expect(PARENTHESIZED).toHaveLength(2);
    expect(bothWays(clean.findings, rule.reports)).toStrictEqual({ onlyCheck: [], onlyRule: [] });
    expect(bothWays(clean.population, rule.population)).toStrictEqual({ onlyCheck: [], onlyRule: [] });
    expect(clean.examined).toBe(clean.population.length);
  });

  it('turns red on a seeded self-import in src, and on a seeded file in a globally ignored directory', async () => {
    const seeded = { 'packages/a/src/seeded.ts': "import '@acme/a/seeded';\n", 'packages/a/src/test-fixtures/seeded.ts': "import '@acme/a/seeded';\n" };
    writeCommittedTree(dirs.corpus, seeded);
    const answer = runCheck(dirs.corpus, dirs.cache, CHECK);
    const rule = await ruleSide(dirs.corpus, CORPUS_PACKAGES, [...ALL_FILES, ...Object.keys(seeded)]);

    // The finding arm: the seed is reported by both, so the clean answer is now red against the rule.
    expect(bothWays(clean.findings, rule.reports)).toStrictEqual({ onlyCheck: [], onlyRule: ['packages/a/src/seeded.ts:1'] });
    expect(bothWays(answer.findings, rule.reports)).toStrictEqual({ onlyCheck: [], onlyRule: [] });

    // The population arm: the ignored seed is routed, and only the check's mirror of the global
    // ignores keeps it out; without the mirror the arm is red on exactly the ignored files.
    const routed = vatQuery(dirs.corpus, dirs.cache, 'SELECT path FROM ts__routes').map((row) => String(row['path']));
    expect(routed).toContain('packages/a/src/test-fixtures/seeded.ts');
    expect(bothWays(answer.population, rule.population)).toStrictEqual({ onlyCheck: [], onlyRule: [] });
    const unmirrored = routed.filter((path) => UNFILTERED(path) && !UNOWNED(path)).toSorted(byText);
    expect(bothWays(unmirrored, rule.population)).toStrictEqual({
      onlyCheck: [...Object.keys(GLOBALLY_IGNORED), ...Object.keys(FORCE_TRACKED), 'packages/a/src/test-fixtures/seeded.ts'].toSorted(byText),
      onlyRule: [],
    });
  });
});
