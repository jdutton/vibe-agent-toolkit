/**
 * The two `resources.checks` entries of `vibe-agent-toolkit.config.yaml` that replaced ESLint
 * usage, each proved exactly as strong as that usage, both ways (SPEC section 11): over this
 * repository's git content and over a corpus of every form its rule visits and every form it
 * skips, the `(file, line)` set the rule reports equals the check's findings, and the files the
 * check examines equal the files ESLint's own config resolution enables the rule for.
 *
 * - `no-self-package-import` replaces `local/no-self-package-import` (the per-package blocks
 *   `selfImportConfigs()` carried in `eslint.config.js`): one block per workspace package, files
 *   `packages/<dir>/src/**` `.ts` and `.cts`, option `packageName`.
 * - `projection-sqlite-import-boundary` replaces `local/projection-sqlite-import-boundary` (the
 *   block enabling it over every script with the importer list as its `ignores`) and the
 *   integration test that held that list both ways against the tree. The rule reports the whole
 *   statement or call, so the check's `nodeLine` is the line compared.
 *
 * Each rule is configured exactly as the deleted usage configured it, laid over the repository's
 * own config so its global ignores and git-ignored patterns still decide the files. The two ports
 * share one file because they share one ESLint instance over this repository (both rules, the
 * union of both candidate sets, linted once) and one real store that the two would otherwise
 * populate concurrently.
 *
 * What is held by construction and what is not: the boundary rule's `ignores` are the check's own
 * `importers` list, translated entry by entry, so that list cannot drift. The ESLint global
 * ignores are NOT derived: the `scripts` CTE of the boundary check and the `owned` CTE of the
 * self-import check each repeat, by hand, the global ignores that can match in their population.
 * A new global ignore is seen only when a file lands under it (the repository arm), and the
 * corpus holds today's ignores (the population arm of the seeded test).
 *
 * Two one-way differences are pinned for the boundary port, so closing either turns this red: a
 * redeclared `var` whose first declarator is not the `createRequire(...)` call (the rule reads
 * only the first declarator; the row counts every one by spelling), and a file git tracks despite
 * a `.gitignore` pattern the check does not mirror (ESLint ignores every git-ignored pattern; the
 * check sees git content). Both make the check wider than the rule, never narrower.
 *
 * Integration tier: it runs the built `vat` and lints with ESLint's API.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import type { Linter } from 'eslint';
import picomatch from 'picomatch';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  bothWays,
  byText,
  configOfShippedChecks,
  expectRepositoryArm,
  importEslintConfigSupport,
  localPlugin,
  markedLines,
  portTempDirs,
  queryOverRepository,
  REPO_ROOT,
  ruleSides,
  runCheck,
  runCheckOverRepository,
  shippedWith,
  vatQuery,
  type CheckAnswer,
  type RuleSide,
} from '../check-port-differential.js';
import { importRootEslintConfig, treeFiles } from '../eslint-clean-files.js';

/** A workspace package as the deleted block read one: its directory under `packages/`, and its name. */
interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
}

const SELF_RULE = 'local/no-self-package-import';
const SELF_CHECK = { name: 'no-self-package-import', population: 'owned' } as const;
const BOUNDARY_RULE = 'local/projection-sqlite-import-boundary';
const BOUNDARY_CHECK = { name: 'projection-sqlite-import-boundary', population: 'enabled' } as const;
const BACKEND = '@vibe-agent-toolkit/projection-sqlite';
/** The extensions the deleted boundary block named. */
const SCRIPTS = '**/*.{ts,cts,mts,js,cjs,mjs}';
/** Where the boundary check's second arm anchors a stale importer glob. */
const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';

const { workspacePackages } = await importEslintConfigSupport<{ readonly workspacePackages: () => WorkspacePackage[] }>();
/** The repository's own flat config, loaded once: the deleted usage is laid over it. */
const { default: repoConfig } = await importRootEslintConfig<{ readonly default: Linter.Config[] }>();
const localRules = localPlugin(repoConfig);

/** The deleted `selfImportConfigs()`, verbatim but for its package list: one block per package. */
function selfImportBlocks(packages: readonly WorkspacePackage[]): Linter.Config[] {
  return packages.map(({ dir, name }) => ({
    files: [`packages/${dir}/src/**/*.ts`, `packages/${dir}/src/**/*.cts`],
    plugins: { local: localRules },
    rules: { [SELF_RULE]: ['error', { packageName: name }] },
  }));
}

/**
 * The ESLint glob a SQLite GLOB of the check's importer list stands for: a literal path is itself,
 * and a literal directory followed by `/*` (`*` crosses `/` in GLOB) is that directory's `/**`. Any
 * other shape is refused, so an entry the two languages read differently cannot pass unnoticed.
 */
function eslintGlobOf(glob: string): string {
  const META = /[*?[\]]/u;
  if (!META.test(glob)) return glob;
  const prefix = glob.slice(0, -2);
  if (glob.endsWith('/*') && !META.test(prefix)) return `${prefix}/**`;
  throw new Error(`The importer glob "${glob}" has no ESLint equivalent this proof knows; extend eslintGlobOf()`);
}

/** The deleted boundary block, verbatim but for its `ignores`: the check's importer list, as ESLint reads it. */
function boundaryBlock(importers: readonly string[]): Linter.Config {
  return { files: [SCRIPTS], ignores: [...importers], plugins: { local: localRules }, rules: { [BOUNDARY_RULE]: 'error' } };
}

/** The importer globs the repository's own check declares, as ESLint reads them. */
function importersOf(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  return rows.map((row) => eslintGlobOf(String(row['glob'])));
}

/** The self-import rule's side over one tree. */
async function selfSide(root: string, packages: readonly WorkspacePackage[], candidates: readonly string[]): Promise<RuleSide> {
  const sides = await ruleSides({ root, baseConfig: repoConfig, blocks: selfImportBlocks(packages), candidates: { [SELF_RULE]: candidates } });
  return sides[SELF_RULE] as RuleSide;
}

/** The boundary rule's side over one tree. */
async function boundarySide(root: string, importers: readonly string[], candidates: readonly string[]): Promise<RuleSide> {
  const sides = await ruleSides({ root, baseConfig: repoConfig, blocks: [boundaryBlock(importers)], candidates: { [BOUNDARY_RULE]: candidates } });
  return sides[BOUNDARY_RULE] as RuleSide;
}

// ── The no-self-package-import corpus ───────────────────────────────────────
// Every line the rule must report carries `// visits`; every form it skips is unmarked.

const CORPUS_PACKAGES: readonly WorkspacePackage[] = [
  { dir: 'a', name: '@acme/a' },
  // `_` is a LIKE wildcard: a check comparing with LIKE would report `@acme/bXx`.
  { dir: 'b', name: '@acme/b_x' },
  { dir: 'ab', name: '@acme/a-b' },
];

const SELF_VISITS = String.raw`import { one } from '@acme/a'; // visits
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

const SELF_SKIPS = `import eq = require('@acme/a');
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
const SELF_GLOBALLY_IGNORED: Readonly<Record<string, string>> = {
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
const SELF_FORCE_TRACKED: Readonly<Record<string, string>> = {
  'packages/a/src/generated/emitted.ts': "import '@acme/a';\n",
  'packages/a/src/dist/built.ts': "import '@acme/a';\n",
  'packages/a/src/.tsc-staging/staged.ts': "import '@acme/a';\n",
};

const SELF_CORPUS: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': configOfShippedChecks([SELF_CHECK.name]),
  // The repository's own ignore file, so git and the config's git-ignored patterns agree here too.
  '.gitignore': readFileSync(safePath.join(REPO_ROOT, '.gitignore'), 'utf-8'),
  'package.json': `${JSON.stringify({ name: 'acme-root', private: true, workspaces: ['packages/*'] })}\n`,
  ...Object.fromEntries(CORPUS_PACKAGES.map(({ dir, name }) => [`packages/${dir}/package.json`, `${JSON.stringify({ name })}\n`])),
  'packages/a/src/visits.ts': SELF_VISITS,
  'packages/a/src/skips.ts': SELF_SKIPS,
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
  ...SELF_GLOBALLY_IGNORED,
};

/** Every corpus file: the committed tree and the force-tracked one. */
const SELF_ALL_FILES = [...Object.keys(SELF_CORPUS), ...Object.keys(SELF_FORCE_TRACKED)];

/** A specifier in parentheses, `import(('m'))` or `require(('m'))`: ESTree drops the parentheses, and so does the row. */
const SELF_PARENTHESIZED = markedLines(SELF_CORPUS, '// visits, parenthesized');

/** Every routed `.ts`/`.cts` file under some package's `src/`: the population with no ignore mirrored and no owner asked for. */
const SELF_UNFILTERED = picomatch(['packages/*/src/**/*.ts', 'packages/*/src/**/*.cts'], { dot: true });
/** The package with no name, which owns nothing. */
const SELF_UNOWNED = picomatch('packages/noname/**', { dot: true });

// ── The projection-sqlite-import-boundary corpus ────────────────────────────
// Every line the rule must report carries `// visits`; every form it skips is unmarked.

const BOUNDARY_VISITS = `import { a } from '${BACKEND}'; // visits
import type { B1 } from '${BACKEND}/types'; // visits
import { // visits
  c,
} from
  '${BACKEND}';
import '${BACKEND}/side-effect'; // visits
import { type D } from "\\x40vibe-agent-toolkit/projection-sqlite"; // visits
export { e } from '${BACKEND}'; // visits
export type { F } from '${BACKEND}'; // visits
export * from '${BACKEND}/star'; // visits
export * as g from '${BACKEND}'; // visits
export { // visits
  h,
} from '${BACKEND}';
export const dyn = import('${BACKEND}'); // visits
export const dynMulti = import( // visits
  '${BACKEND}/multi'
);
export const dynParens = import(('${BACKEND}')); // visits
export const dynTemplate = import(\`${BACKEND}\`); // visits
export const dynAttributes = import('${BACKEND}', { with: { type: 'json' } }); // visits
export type I = import('${BACKEND}').I; // visits
export type J = typeof import( // visits
  '${BACKEND}'
);
export type K = typeof
  import('${BACKEND}'); // visits
import eq = require('${BACKEND}'); // visits
import eqMulti =
  require('${BACKEND}'); // visits
export import eqExported = require('${BACKEND}'); // visits
export const req = require('${BACKEND}'); // visits
export const reqTwo = require('${BACKEND}', 'extra'); // visits
export const reqParens = (require)('${BACKEND}'); // visits
export const reqOptional = require?.('${BACKEND}'); // visits
export const reqArgParens = require(('${BACKEND}')); // visits
export const reqTemplate = require(\`${BACKEND}\`); // visits
export const reqMulti = require( // visits
  '${BACKEND}/multi',
);
export function nested(): unknown {
  return require('${BACKEND}'); // visits
}
export const relative = import('../../projection-sqlite/src/index.js'); // visits
export const relativeDir = import('../../projection-sqlite'); // visits
export const climbed = import('../../../../packages/projection-sqlite/x.js'); // visits
export const nestedBackend = import('../../../vendor/packages/projection-sqlite/y.js'); // visits
declare module '${BACKEND}' { // visits
  export const augmented: number;
}
declare module 'ambient-host' {
  import { inner } from '${BACKEND}/inner'; // visits
}
export const used = [a, c, eq, eqMulti];
export type Used = [B1, D, I, J, K];
`;

const BOUNDARY_CREATE_REQUIRE = `import { createRequire } from 'node:module';
import { createRequire as makeRequire } from 'module';
import * as nodeModule from 'node:module';
export const early = load('${BACKEND}'); // visits
const load = createRequire(import.meta.url);
export const direct = createRequire(import.meta.url)('${BACKEND}'); // visits
export const aliased = makeRequire(import.meta.url)('${BACKEND}'); // visits
export const member = nodeModule.createRequire(import.meta.url)('${BACKEND}'); // visits
const named = makeRequire(import.meta.url);
export const viaNamed = named('${BACKEND}/sub'); // visits
export const multi = load( // visits
  '${BACKEND}',
);
export const memberRequire = module.require('${BACKEND}');
export const unbound = other('${BACKEND}');
`;

const BOUNDARY_SKIPS = `/// <reference types="${BACKEND}" />
/// <reference path="../../projection-sqlite/src/index.ts" />
/** @type {import('${BACKEND}').X} */
export const jsdoc = 1;
export const substituted = import(\`@vibe-agent-toolkit/\${'projection-sqlite'}\`);
export const concatenated = import('@vibe-agent-toolkit/' + 'projection-sqlite');
export const computed = require(name);
export const noArguments = require();
export const sibling = import('${BACKEND}-extras');
export const glued = import('${BACKEND}x');
export const upper = import('@Vibe-agent-toolkit/projection-sqlite');
export const relativeSibling = import('../../projection-sqlite-extras/src/index.js');
export const notRelative = import('packages/projection-sqlite/src/index.js');
export const stringOnly = 'import "${BACKEND}"';
import ns = Namespace.Inner;
export const usedNs = ns;
`;

/** A file the importer list exempts, one per glob, so the second arm has an importer for each. */
const BOUNDARY_IMPORTERS: Readonly<Record<string, string>> = {
  'packages/projection-sqlite/src/index.ts': "export * from './store.js';\n",
  'packages/projection-sqlite/src/store.ts': 'export const store = 1;\n',
  'packages/cli/src/utils/projection-store.ts': `import { store } from '${BACKEND}';\nexport const open = store;\n`,
  'packages/cli/test/store.test.ts': `import '${BACKEND}/testing';\n`,
};

/** Files a global ignore of `eslint.config.js` keeps from the rule, committed (git content). */
const BOUNDARY_GLOBALLY_IGNORED: Readonly<Record<string, string>> = {
  'packages/resources/src/declarations.d.ts': `import '${BACKEND}';\n`,
  'packages/resources/src/declarations.d.cts': `import '${BACKEND}';\n`,
  'packages/resources/vite.config.ts': `import '${BACKEND}';\n`,
  'packages/resources/test/fixtures/fixture.ts': `import '${BACKEND}';\n`,
  'packages/resources/test-fixtures/fixture.ts': `import '${BACKEND}';\n`,
  'test-fixtures/root.ts': `import '${BACKEND}';\n`,
  'packages/resources/src/transformer-fixtures/fixture.ts': `import '${BACKEND}';\n`,
  'packages/resources/resources/skills/evals/eval.ts': `import '${BACKEND}';\n`,
  'vitest.shared.ts': `import '${BACKEND}';\n`,
  'vitest.setup.js': `import '${BACKEND}';\n`,
};

/** A file in a Claude Code worktree, which vat never routes. */
const BOUNDARY_WORKTREE_FILE = '.claude/worktrees/other/src/x.ts';

/**
 * Files in directories git ignores as well as ESLint, tracked anyway (`git add -f`): git content,
 * so routed, and kept from the rule by the config's global ignores, which the check mirrors.
 */
const BOUNDARY_FORCE_TRACKED: Readonly<Record<string, string>> = {
  'dist/built.ts': `import '${BACKEND}';\n`,
  'packages/resources/dist/built.js': `import '${BACKEND}';\n`,
  'generated/emitted.ts': `import '${BACKEND}';\n`,
  'packages/resources/src/generated/emitted.ts': `import '${BACKEND}';\n`,
  'packages/resources/.tsc-staging/staged.ts': `import '${BACKEND}';\n`,
  'build/built.ts': `import '${BACKEND}';\n`,
  'coverage/report.js': `import '${BACKEND}';\n`,
  // vat itself never routes a worktree, so only the config ignores it here and the check's mirror
  // of that ignore is defence alone.
  [BOUNDARY_WORKTREE_FILE]: `import '${BACKEND}';\n`,
  // A gitignored scratch directory: a fixture path in the temp tree (uncommitted by construction).
  '.superpowers/scratch.ts': `import '${BACKEND}';\n`,
};

/**
 * Tracked despite a `.gitignore` pattern the check does not mirror: ESLint's git-ignored patterns
 * keep them from the rule, and the check, which reads git content, examines them. The pinned
 * one-way difference in the population arm.
 */
const BOUNDARY_FORCE_TRACKED_UNMIRRORED: Readonly<Record<string, string>> = {
  'tmp/scratch.ts': 'export const scratch = 1;\n',
  'packages/resources/build/nested.ts': 'export const nested = 1;\n',
};

/** The redeclared `var`: the row counts every declarator, the rule only the first. One-way. */
const BOUNDARY_REDECLARED = `import { createRequire } from 'node:module';
var load = null;
var load = createRequire(import.meta.url);
export const viaRedeclared = load('${BACKEND}'); // one-way
`;

const BOUNDARY_CORPUS: Readonly<Record<string, string>> = {
  [CONFIG_FILE]: configOfShippedChecks([BOUNDARY_CHECK.name]),
  // The repository's own ignore file, so git and the config's git-ignored patterns agree here too.
  '.gitignore': readFileSync(safePath.join(REPO_ROOT, '.gitignore'), 'utf-8'),
  'package.json': `${JSON.stringify({ name: 'acme-root', private: true, workspaces: ['packages/*'] })}\n`,
  ...BOUNDARY_IMPORTERS,
  'packages/resources/src/visits.ts': BOUNDARY_VISITS,
  'packages/resources/src/create-require.ts': BOUNDARY_CREATE_REQUIRE,
  'packages/resources/src/skips.ts': BOUNDARY_SKIPS,
  'packages/resources/src/module.mts': `import '${BACKEND}'; // visits\n`,
  'packages/resources/src/types.d.mts': `import '${BACKEND}'; // visits\n`,
  'packages/resources/src/arbitrary.d.css.ts': `import '${BACKEND}'; // visits\n`,
  'packages/resources/src/common.cts': `const self = require('${BACKEND}'); // visits\nimport eq = require('${BACKEND}'); // visits\nexport = [self, eq];\n`,
  'packages/resources/src/common.cjs': `const self = require('${BACKEND}'); // visits\nmodule.exports = self;\n`,
  'packages/resources/src/plain.js': `import '${BACKEND}'; // visits\n/** @import { X } from '${BACKEND}' */\n/** @type {import('${BACKEND}').Y} */\nexport const y = 1;\n`,
  'packages/resources/src/esm.mjs': `export { x } from '${BACKEND}'; // visits\n`,
  'packages/resources/src/redeclared.js': BOUNDARY_REDECLARED,
  // Extensions the deleted block never named: no rule, no check.
  'packages/resources/src/view.tsx': `import '${BACKEND}';\nexport const View = () => <div />;\n`,
  'packages/resources/src/view.jsx': `import '${BACKEND}';\nexport const View = () => <div />;\n`,
  // Root-only global ignores, nested: enabled.
  'packages/resources/vitest.shared.ts': `import '${BACKEND}'; // visits\n`,
  // Anywhere in the tree, the root and outside `packages/` included.
  'root.ts': `export const outside = import('../packages/projection-sqlite/z.js'); // visits\n`,
  '.claude/hooks/hook.mjs': `import '${BACKEND}'; // visits\n`,
  // A second copy of the backend's directory, nested: a `./` into it lands in it, a bare `.` or
  // `..` is no relative specifier to the rule.
  'vendor/packages/projection-sqlite/sub/inner.ts': "export const up = import('..');\nexport const here = import('.');\nexport const sibling = import('./other.js'); // visits\n",
  ...BOUNDARY_GLOBALLY_IGNORED,
};

/** Every corpus file: the committed tree and the force-tracked ones. */
const BOUNDARY_ALL_FILES = [...Object.keys(BOUNDARY_CORPUS), ...Object.keys(BOUNDARY_FORCE_TRACKED), ...Object.keys(BOUNDARY_FORCE_TRACKED_UNMIRRORED)];

/** The one-way findings the check holds and the rule does not. */
const BOUNDARY_ONE_WAY_FINDINGS = markedLines(BOUNDARY_CORPUS, '// one-way');
/** The one-way population difference. */
const BOUNDARY_ONE_WAY_POPULATION = Object.keys(BOUNDARY_FORCE_TRACKED_UNMIRRORED).toSorted(byText);

/** Every script path, for the population with no global ignore mirrored. */
const BOUNDARY_SCRIPT = picomatch(SCRIPTS, { dot: true });


describe('the resources.checks ports', () => {
  it('are exactly as strong as their rules over this repository, both ways', async () => {
    const importers = importersOf(queryOverRepository(`WITH ${shippedWith(BOUNDARY_CHECK.name)} SELECT glob FROM importers`));
    const selfAnswer = runCheckOverRepository(SELF_CHECK);
    const boundaryAnswer = runCheckOverRepository(BOUNDARY_CHECK);
    // One ESLint instance, both rules, the union of both candidate sets linted once.
    const sides = await ruleSides({
      root: REPO_ROOT,
      baseConfig: repoConfig,
      blocks: [...selfImportBlocks(workspacePackages()), boundaryBlock(importers)],
      candidates: { [SELF_RULE]: treeFiles(REPO_ROOT, ['packages/*/src/**/*']), [BOUNDARY_RULE]: treeFiles(REPO_ROOT, [SCRIPTS]) },
    });

    expectRepositoryArm(selfAnswer, sides[SELF_RULE] as RuleSide);
    // Every importer glob is in use, and no file outside them imports the backend.
    expect(boundaryAnswer.findings).toStrictEqual([]);
    expectRepositoryArm(boundaryAnswer, sides[BOUNDARY_RULE] as RuleSide);
  });

  describe('no-self-package-import', () => {
    const dirs = portTempDirs('vat-self-import-port-', SELF_CORPUS, SELF_FORCE_TRACKED);
    const seeded = { 'packages/a/src/seeded.ts': "import '@acme/a/seeded';\n", 'packages/a/src/test-fixtures/seeded.ts': "import '@acme/a/seeded';\n" };
    // Its own tree and cache: the seed is committed into neither the corpus nor the store the clean arm reads.
    const seededDirs = portTempDirs('vat-self-import-seeded-', { ...SELF_CORPUS, ...seeded }, SELF_FORCE_TRACKED);
    let clean: CheckAnswer;

    beforeAll(() => {
      clean = runCheck(dirs.corpus, dirs.cache, SELF_CHECK);
    });

    it('is exactly as strong as the rule over every form it visits and skips, both ways', async () => {
      const rule = await selfSide(dirs.corpus, CORPUS_PACKAGES, SELF_ALL_FILES);

      expect(clean.runFindings).toStrictEqual([]);
      // Neither side is blind: each reports exactly the marked lines.
      expect(rule.reports).toStrictEqual(markedLines(SELF_CORPUS, '// visits'));
      expect(SELF_PARENTHESIZED).toHaveLength(2);
      expect(bothWays(clean.findings, rule.reports)).toStrictEqual({ onlyCheck: [], onlyRule: [] });
      expect(bothWays(clean.population, rule.population)).toStrictEqual({ onlyCheck: [], onlyRule: [] });
      expect(clean.examined).toBe(clean.population.length);
    });

    it('turns red on a seeded self-import in src, and on a seeded file in a globally ignored directory', async () => {
      const answer = runCheck(seededDirs.corpus, seededDirs.cache, SELF_CHECK);
      const rule = await selfSide(seededDirs.corpus, CORPUS_PACKAGES, [...SELF_ALL_FILES, ...Object.keys(seeded)]);

      // The finding arm: the seed is reported by both, so the clean answer is now red against the rule.
      expect(bothWays(clean.findings, rule.reports)).toStrictEqual({ onlyCheck: [], onlyRule: ['packages/a/src/seeded.ts:1'] });
      expect(bothWays(answer.findings, rule.reports)).toStrictEqual({ onlyCheck: [], onlyRule: [] });

      // The population arm: the ignored seed is routed, and only the check's mirror of the global
      // ignores keeps it out; without the mirror the arm is red on exactly the ignored files.
      const routed = vatQuery(seededDirs.corpus, seededDirs.cache, 'SELECT path FROM ts__routes').map((row) => String(row['path']));
      expect(routed).toContain('packages/a/src/test-fixtures/seeded.ts');
      expect(bothWays(answer.population, rule.population)).toStrictEqual({ onlyCheck: [], onlyRule: [] });
      const unmirrored = routed.filter((path) => SELF_UNFILTERED(path) && !SELF_UNOWNED(path)).toSorted(byText);
      expect(bothWays(unmirrored, rule.population)).toStrictEqual({
        onlyCheck: [...Object.keys(SELF_GLOBALLY_IGNORED), ...Object.keys(SELF_FORCE_TRACKED), 'packages/a/src/test-fixtures/seeded.ts'].toSorted(byText),
        onlyRule: [],
      });
    });
  });

  describe('projection-sqlite-import-boundary', () => {
    const dirs = portTempDirs('vat-backend-boundary-port-', BOUNDARY_CORPUS, { ...BOUNDARY_FORCE_TRACKED, ...BOUNDARY_FORCE_TRACKED_UNMIRRORED });
    const seeded = { 'packages/resources/src/seeded.ts': `import '${BACKEND}/seeded';\n`, 'packages/resources/src/test-fixtures/seeded.ts': `import '${BACKEND}/seeded';\n` };
    // Its own tree and cache, without the one importer the stale-glob arm removes.
    const STALE_IMPORTER = 'packages/cli/test/store.test.ts';
    const seededCorpus = { ...Object.fromEntries(Object.entries(BOUNDARY_CORPUS).filter(([path]) => path !== STALE_IMPORTER)), ...seeded };
    const seededDirs = portTempDirs('vat-backend-boundary-seeded-', seededCorpus, { ...BOUNDARY_FORCE_TRACKED, ...BOUNDARY_FORCE_TRACKED_UNMIRRORED });
    let importers: readonly string[] = [];
    let clean: CheckAnswer;

    beforeAll(() => {
      importers = importersOf(vatQuery(dirs.corpus, dirs.cache, `WITH ${shippedWith(BOUNDARY_CHECK.name)} SELECT glob FROM importers`));
      clean = runCheck(dirs.corpus, dirs.cache, BOUNDARY_CHECK);
    });

    it('is exactly as strong as the rule over every form it visits and skips, both ways', async () => {
      const rule = await boundarySide(dirs.corpus, importers, BOUNDARY_ALL_FILES);

      expect(importers).toStrictEqual(['packages/projection-sqlite/**', 'packages/cli/src/utils/projection-store.ts', 'packages/cli/test/**']);
      expect(clean.runFindings).toStrictEqual([]);
      // Neither side is blind: the rule reports exactly the marked lines.
      expect(rule.reports).toStrictEqual(markedLines(BOUNDARY_CORPUS, '// visits'));
      expect(BOUNDARY_ONE_WAY_FINDINGS).toHaveLength(1);
      expect(bothWays(clean.findings, rule.reports)).toStrictEqual({ onlyCheck: BOUNDARY_ONE_WAY_FINDINGS, onlyRule: [] });
      expect(bothWays(clean.population, rule.population)).toStrictEqual({ onlyCheck: BOUNDARY_ONE_WAY_POPULATION, onlyRule: [] });
      expect(clean.examined).toBe(clean.population.length);
    });

    it('turns red on a seeded backend import in resources, a seeded file in a globally ignored directory, and a stale importer glob', async () => {
      const answer = runCheck(seededDirs.corpus, seededDirs.cache, BOUNDARY_CHECK);
      const rule = await boundarySide(seededDirs.corpus, importers, [...BOUNDARY_ALL_FILES.filter((file) => file !== STALE_IMPORTER), ...Object.keys(seeded)]);

      // The finding arm: the seed is reported by both, so the clean answer is now red against the rule.
      expect(bothWays(clean.findings, rule.reports)).toStrictEqual({ onlyCheck: BOUNDARY_ONE_WAY_FINDINGS, onlyRule: ['packages/resources/src/seeded.ts:1'] });
      // The importer arm: the glob whose one importer is gone is stale, and only the check says so.
      expect(bothWays(answer.findings, rule.reports)).toStrictEqual({ onlyCheck: [...BOUNDARY_ONE_WAY_FINDINGS, `${CONFIG_FILE}:?`].toSorted(byText), onlyRule: [] });
      expect(answer.messages.filter((message) => message.includes('"packages/cli/test/*"'))).toHaveLength(1);

      // The population arm: the ignored seed is routed, and only the check's mirror of the global
      // ignores keeps it out; without the mirror the arm is red on exactly the ignored files.
      const routed = vatQuery(seededDirs.corpus, seededDirs.cache, 'SELECT path FROM ts__routes').map((row) => String(row['path']));
      expect(routed).toContain('packages/resources/src/test-fixtures/seeded.ts');
      expect(routed).not.toContain(BOUNDARY_WORKTREE_FILE);
      expect(bothWays(answer.population, rule.population)).toStrictEqual({ onlyCheck: BOUNDARY_ONE_WAY_POPULATION, onlyRule: [] });
      const exempt = picomatch([...importers], { dot: true });
      const unmirrored = routed.filter((path) => BOUNDARY_SCRIPT(path) && !exempt(path)).toSorted(byText);
      expect(bothWays(unmirrored, rule.population)).toStrictEqual({
        onlyCheck: [...Object.keys(BOUNDARY_GLOBALLY_IGNORED), ...Object.keys(BOUNDARY_FORCE_TRACKED).filter((file) => file !== BOUNDARY_WORKTREE_FILE), ...BOUNDARY_ONE_WAY_POPULATION, 'packages/resources/src/test-fixtures/seeded.ts'].toSorted(byText),
        onlyRule: [],
      });
    });
  });
});
