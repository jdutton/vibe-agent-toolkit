/**
 * The `projection-sqlite-import-boundary` check in `vibe-agent-toolkit.config.yaml` replaces this
 * repository's usage of `local/projection-sqlite-import-boundary` (the `eslint.config.js` block that
 * enabled it over every script with the importer list as its `ignores`) and the integration test
 * that held that list both ways against the tree. This proves the port exactly as strong as that
 * usage, both ways (SPEC section 11): over this repository's git content and over a corpus of every
 * form the rule visits and every form it skips, the `(file, line)` set the rule reports equals the
 * check's findings at `nodeLine` (the rule reports the whole statement or call), and the files the
 * check examines equal the files ESLint's own config resolution enables the rule for.
 *
 * The rule is configured exactly as the deleted block configured it, laid over the repository's
 * own config so its global ignores and git-ignored patterns still decide the files. Its `ignores`
 * are the check's own importer list, translated entry by entry, so the two lists cannot drift.
 *
 * Two one-way differences are pinned, so closing either turns this red: a redeclared `var` whose
 * first declarator is not the `createRequire(...)` call (the rule reads only the first declarator;
 * the row counts every one by spelling), and a file git tracks despite a `.gitignore` pattern the
 * check does not mirror (ESLint ignores every git-ignored pattern; the check sees git content).
 * Both make the check wider than the rule, never narrower.
 *
 * Integration tier: it runs the built `vat` and lints with ESLint's API.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';

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
  localPlugin,
  markedLines,
  REPO_ROOT,
  ruleSide as portRuleSide,
  runCheck,
  runCheckOverRepository,
  shippedWith,
  vatQuery,
  writeCommittedTree,
  type CheckAnswer,
  type RuleSide,
} from '../check-port-differential.js';
import { importRootEslintConfig, treeFiles } from '../eslint-clean-files.js';

const RULE = 'local/projection-sqlite-import-boundary';
const CHECK = { name: 'projection-sqlite-import-boundary', population: 'enabled' } as const;
const BACKEND = '@vibe-agent-toolkit/projection-sqlite';
/** The extensions the deleted block named. */
const SCRIPTS = '**/*.{ts,cts,mts,js,cjs,mjs}';
/** Where the check's second arm anchors a stale importer glob. */
const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';

/** The repository's own flat config, loaded once: the deleted block is laid over it. */
const { default: repoConfig } = await importRootEslintConfig<{ readonly default: Linter.Config[] }>();
const localRules = localPlugin(repoConfig);

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

/** The deleted block, verbatim but for its `ignores`: the check's importer list, as ESLint reads it. */
function boundaryBlock(importers: readonly string[]): Linter.Config {
  return { files: [SCRIPTS], ignores: [...importers], plugins: { local: localRules }, rules: { [RULE]: 'error' } };
}

/** The rule's side over one tree. */
function ruleSide(root: string, importers: readonly string[], candidates: readonly string[]): Promise<RuleSide> {
  return portRuleSide({ root, baseConfig: repoConfig, blocks: [boundaryBlock(importers)], rule: RULE, candidates });
}

// ── The corpus ──────────────────────────────────────────────────────────────
// Every line the rule must report carries `// visits`; every form it skips is unmarked.

const VISITS = `import { a } from '${BACKEND}'; // visits
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

const CREATE_REQUIRE = `import { createRequire } from 'node:module';
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

const SKIPS = `/// <reference types="${BACKEND}" />
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
const IMPORTERS: Readonly<Record<string, string>> = {
  'packages/projection-sqlite/src/index.ts': "export * from './store.js';\n",
  'packages/projection-sqlite/src/store.ts': 'export const store = 1;\n',
  'packages/cli/src/utils/projection-store.ts': `import { store } from '${BACKEND}';\nexport const open = store;\n`,
  'packages/cli/test/store.test.ts': `import '${BACKEND}/testing';\n`,
};

/** Files a global ignore of `eslint.config.js` keeps from the rule, committed (git content). */
const GLOBALLY_IGNORED: Readonly<Record<string, string>> = {
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
const WORKTREE_FILE = '.claude/worktrees/other/src/x.ts';

/**
 * Files in directories git ignores as well as ESLint, tracked anyway (`git add -f`): git content,
 * so routed, and kept from the rule by the config's global ignores, which the check mirrors.
 */
const FORCE_TRACKED: Readonly<Record<string, string>> = {
  'dist/built.ts': `import '${BACKEND}';\n`,
  'packages/resources/dist/built.js': `import '${BACKEND}';\n`,
  'generated/emitted.ts': `import '${BACKEND}';\n`,
  'packages/resources/src/generated/emitted.ts': `import '${BACKEND}';\n`,
  'packages/resources/.tsc-staging/staged.ts': `import '${BACKEND}';\n`,
  'build/built.ts': `import '${BACKEND}';\n`,
  'coverage/report.js': `import '${BACKEND}';\n`,
  // vat itself never routes a worktree, so only the config ignores it here and the check's mirror
  // of that ignore is defence alone.
  [WORKTREE_FILE]: `import '${BACKEND}';\n`,
  // A gitignored scratch directory: a fixture path in the temp tree (uncommitted by construction).
  '.superpowers/scratch.ts': `import '${BACKEND}';\n`,
};

/**
 * Tracked despite a `.gitignore` pattern the check does not mirror: ESLint's git-ignored patterns
 * keep them from the rule, and the check, which reads git content, examines them. The pinned
 * one-way difference in the population arm.
 */
const FORCE_TRACKED_UNMIRRORED: Readonly<Record<string, string>> = {
  'tmp/scratch.ts': 'export const scratch = 1;\n',
  'packages/resources/build/nested.ts': 'export const nested = 1;\n',
};

/** The redeclared `var`: the row counts every declarator, the rule only the first. One-way. */
const REDECLARED = `import { createRequire } from 'node:module';
var load = null;
var load = createRequire(import.meta.url);
export const viaRedeclared = load('${BACKEND}'); // one-way
`;

const CORPUS: Readonly<Record<string, string>> = {
  [CONFIG_FILE]: configOfShippedChecks([CHECK.name]),
  // The repository's own ignore file, so git and the config's git-ignored patterns agree here too.
  '.gitignore': readFileSync(safePath.join(REPO_ROOT, '.gitignore'), 'utf-8'),
  'package.json': `${JSON.stringify({ name: 'acme-root', private: true, workspaces: ['packages/*'] })}\n`,
  ...IMPORTERS,
  'packages/resources/src/visits.ts': VISITS,
  'packages/resources/src/create-require.ts': CREATE_REQUIRE,
  'packages/resources/src/skips.ts': SKIPS,
  'packages/resources/src/module.mts': `import '${BACKEND}'; // visits\n`,
  'packages/resources/src/types.d.mts': `import '${BACKEND}'; // visits\n`,
  'packages/resources/src/arbitrary.d.css.ts': `import '${BACKEND}'; // visits\n`,
  'packages/resources/src/common.cts': `const self = require('${BACKEND}'); // visits\nimport eq = require('${BACKEND}'); // visits\nexport = [self, eq];\n`,
  'packages/resources/src/common.cjs': `const self = require('${BACKEND}'); // visits\nmodule.exports = self;\n`,
  'packages/resources/src/plain.js': `import '${BACKEND}'; // visits\n/** @import { X } from '${BACKEND}' */\n/** @type {import('${BACKEND}').Y} */\nexport const y = 1;\n`,
  'packages/resources/src/esm.mjs': `export { x } from '${BACKEND}'; // visits\n`,
  'packages/resources/src/redeclared.js': REDECLARED,
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
  ...GLOBALLY_IGNORED,
};

/** Every corpus file: the committed tree and the force-tracked ones. */
const ALL_FILES = [...Object.keys(CORPUS), ...Object.keys(FORCE_TRACKED), ...Object.keys(FORCE_TRACKED_UNMIRRORED)];

/** The one-way findings the check holds and the rule does not. */
const ONE_WAY_FINDINGS = markedLines(CORPUS, '// one-way');
/** The one-way population difference. */
const ONE_WAY_POPULATION = Object.keys(FORCE_TRACKED_UNMIRRORED).toSorted(byText);

/** Every script path, for the population with no global ignore mirrored. */
const SCRIPT = picomatch(SCRIPTS, { dot: true });

describe('the projection-sqlite-import-boundary port', () => {
  const dirs = portTempDirs('vat-backend-boundary-port-', CORPUS, { ...FORCE_TRACKED, ...FORCE_TRACKED_UNMIRRORED });
  let importers: readonly string[] = [];
  let clean: CheckAnswer;

  beforeAll(() => {
    importers = vatQuery(dirs.corpus, dirs.cache, `WITH ${shippedWith(CHECK.name)} SELECT glob FROM importers`).map((row) => eslintGlobOf(String(row['glob'])));
    clean = runCheck(dirs.corpus, dirs.cache, CHECK);
  });

  it('is exactly as strong as the rule over this repository, both ways', async () => {
    const answer = runCheckOverRepository(CHECK);
    // The git index still lists a file deleted from the working tree until the deletion is staged.
    const candidates = treeFiles(REPO_ROOT, [SCRIPTS]).filter((file) => existsSync(safePath.join(REPO_ROOT, file)));
    const rule = await ruleSide(REPO_ROOT, importers, candidates);

    // Every importer glob is in use, and no file outside them imports the backend.
    expect(answer.findings).toStrictEqual([]);
    expectRepositoryArm(answer, rule);
  });

  it('is exactly as strong as the rule over every form it visits and skips, both ways', async () => {
    const rule = await ruleSide(dirs.corpus, importers, ALL_FILES);

    expect(importers).toStrictEqual(['packages/projection-sqlite/**', 'packages/cli/src/utils/projection-store.ts', 'packages/cli/test/**']);
    expect(clean.runFindings).toStrictEqual([]);
    // Neither side is blind: the rule reports exactly the marked lines.
    expect(rule.reports).toStrictEqual(markedLines(CORPUS, '// visits'));
    expect(ONE_WAY_FINDINGS).toHaveLength(1);
    expect(bothWays(clean.findings, rule.reports)).toStrictEqual({ onlyCheck: ONE_WAY_FINDINGS, onlyRule: [] });
    expect(bothWays(clean.population, rule.population)).toStrictEqual({ onlyCheck: ONE_WAY_POPULATION, onlyRule: [] });
    expect(clean.examined).toBe(clean.population.length);
  });

  it('turns red on a seeded backend import in resources, a seeded file in a globally ignored directory, and a stale importer glob', async () => {
    const seeded = { 'packages/resources/src/seeded.ts': `import '${BACKEND}/seeded';\n`, 'packages/resources/src/test-fixtures/seeded.ts': `import '${BACKEND}/seeded';\n` };
    rmSync(safePath.join(dirs.corpus, 'packages/cli/test/store.test.ts'));
    writeCommittedTree(dirs.corpus, seeded);
    const answer = runCheck(dirs.corpus, dirs.cache, CHECK);
    const candidates = [...ALL_FILES.filter((file) => file !== 'packages/cli/test/store.test.ts'), ...Object.keys(seeded)];
    const rule = await ruleSide(dirs.corpus, importers, candidates);

    // The finding arm: the seed is reported by both, so the clean answer is now red against the rule.
    expect(bothWays(clean.findings, rule.reports)).toStrictEqual({ onlyCheck: ONE_WAY_FINDINGS, onlyRule: ['packages/resources/src/seeded.ts:1'] });
    // The importer arm: the glob whose one importer is gone is stale, and only the check says so.
    expect(bothWays(answer.findings, rule.reports)).toStrictEqual({ onlyCheck: [...ONE_WAY_FINDINGS, `${CONFIG_FILE}:?`].toSorted(byText), onlyRule: [] });
    expect(answer.messages.filter((message) => message.includes('"packages/cli/test/*"'))).toHaveLength(1);

    // The population arm: the ignored seed is routed, and only the check's mirror of the global
    // ignores keeps it out; without the mirror the arm is red on exactly the ignored files.
    const routed = vatQuery(dirs.corpus, dirs.cache, 'SELECT path FROM ts__routes').map((row) => String(row['path']));
    expect(routed).toContain('packages/resources/src/test-fixtures/seeded.ts');
    expect(routed).not.toContain(WORKTREE_FILE);
    expect(bothWays(answer.population, rule.population)).toStrictEqual({ onlyCheck: ONE_WAY_POPULATION, onlyRule: [] });
    const exempt = picomatch([...importers], { dot: true });
    const unmirrored = routed.filter((path) => SCRIPT(path) && !exempt(path)).toSorted(byText);
    expect(bothWays(unmirrored, rule.population)).toStrictEqual({
      onlyCheck: [...Object.keys(GLOBALLY_IGNORED), ...Object.keys(FORCE_TRACKED).filter((file) => file !== WORKTREE_FILE), ...ONE_WAY_POPULATION, 'packages/resources/src/test-fixtures/seeded.ts'].toSorted(byText),
      onlyRule: [],
    });
  });
});
