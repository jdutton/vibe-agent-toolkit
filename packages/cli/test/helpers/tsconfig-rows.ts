/**
 * The `tsconfig_*` relations' and `git_content`'s I0 corpus, shared (spec 3.9 I0, 7.6): one clean
 * corpus that refuses nothing, the census every arm answers alike, and the expected answer of each
 * relation over it, projected to the columns that decide it.
 *
 * The corpus holds every shape PR4a reads:
 * - **git content:** a tracked file and directory symlink (when the host can make one), a tracked
 *   test under `coverage/`, a submodule gitlink, a tracked file deleted from the worktree (under an
 *   included `src`, so it may not reach `tsconfig_files`), and an untracked, unignored file. A
 *   skip-worktree file absent from disk is not here: it refuses `changed_files`, which the dump
 *   names, so it is no fixture that refuses nothing (`git-content.system.test.ts` lists it absent);
 * - **invocations:** a root `package.json` whose `"name"` is written twice (the last wins) and whose
 *   `build` script is written twice (only the last occurrence's segments count: the first would add
 *   a missing-config condition); `&&`, `||` and `;` segments; `--project=`; `-b` with two
 *   positionals; a package's `-p .`; a named config that is not git content
 *   (`TSCONFIG_INVOKED_MISSING`);
 * - **configs:** an array `extends`, a base whose `include` is `${configDir}/src`, an `extends` of the
 *   root config (inheriting its `include`), `references` (root to `a` and `b`, `b` to `a`, so the
 *   closure has a shortest path), `paths` with `baseUrl`, and a config whose literal `files` entry
 *   names an ignored file and whose literal `include` entry names no git directory (one
 *   `TSCONFIG_REACHES_OUTSIDE_GIT` of each kind).
 *
 * The ignored entries ({@link IGNORED_FILES}) are not in the corpus: a seed adds them, and every
 * answer must stay the same.
 */

import { rmSync, utimesSync } from 'node:fs';

import { createSymlink, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import { writeCorpus } from '../test-helpers.js';

import { DUMPED_RELATIONS, type FixtureTree, type Git, type I0Seed, type RecordedRuns } from './cache-differential.js';
import { DATA_CONFIG, expectArmsCensus } from './data-rows.js';

// ── The corpus ──────────────────────────────────────────────────────────────

/** `value` as a config's text. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The root `package.json`: `"name"` twice and `build` twice, written by hand since a record holds
 * neither. The first `build` names a config that is not git content, so reading it would add a
 * `TSCONFIG_INVOKED_MISSING` condition.
 */
const ROOT_PACKAGE = [
  '{',
  '  "name": "first",',
  '  "name": "tsconfig-root",',
  '  "private": true,',
  '  "scripts": {',
  '    "build": "tsc -p tsconfig.first.json",',
  '    "build": "tsc -b packages/a packages/b",',
  '    "check": "tsc -p tsconfig.check.json && echo checked",',
  '    "lint": "eslint . || tsc --noEmit",',
  '    "c": "echo c; tsc --project packages/c",',
  '    "missing": "tsc -p tsconfig.missing.json"',
  '  }',
  '}',
  '',
].join('\n');

/** The corpus's committed files. */
const COMMITTED_FILES: Readonly<Record<string, string>> = {
  '.gitignore': 'ignored/\n.cache/\npackages/c/gen/\n',
  'vibe-agent-toolkit.config.yaml': DATA_CONFIG,
  'README.md': '# tsconfig corpus\n',
  // An `@`-import gives the claude-context lens a key of its own, as the data corpus's does.
  'CLAUDE.md': '# Memory\n\n@README.md\n',
  'package.json': ROOT_PACKAGE,
  'tsconfig.json': json({ include: ['src'], references: [{ path: 'packages/a' }, { path: 'packages/b' }] }),
  'tsconfig.check.json': json({ extends: './tsconfig.json', compilerOptions: { noEmit: true } }),
  'src/a.ts': 'export const a = 1;\n',
  'src/gone.ts': 'export const gone = 1;\n',
  'configs/tsconfig.base.json': json({ compilerOptions: { strict: true }, include: ['${configDir}/src'] }),
  'configs/tsconfig.strict.json': json({ compilerOptions: { noUncheckedIndexedAccess: true } }),
  'packages/a/package.json': json({ name: 'a', scripts: { build: 'tsc -p .' } }),
  'packages/a/tsconfig.json': json({
    extends: ['../../configs/tsconfig.base.json', '../../configs/tsconfig.strict.json'],
    compilerOptions: { composite: true, outDir: 'dist', rootDir: 'src' },
  }),
  'packages/a/src/index.ts': 'export const indexA = 1;\n',
  'packages/a/coverage/kept.test.ts': 'export {};\n',
  'packages/b/package.json': json({ name: 'b' }),
  'packages/b/tsconfig.json': json({
    extends: '../../configs/tsconfig.base.json',
    compilerOptions: { composite: true, baseUrl: '.', paths: { '@a/*': ['../a/src/*'], '@b': ['./src/index.ts', './src/fallback.ts'] } },
    references: [{ path: '../a' }],
  }),
  'packages/b/src/index.ts': 'export const indexB = 1;\n',
  'packages/c/tsconfig.json': json({ files: ['main.ts', 'gen/out.ts'], include: ['lib', 'generated'], compilerOptions: { allowJs: true, resolveJsonModule: true } }),
  'packages/c/main.ts': 'export const main = 1;\n',
  'packages/c/lib/util.js': 'export const util = 1;\n',
};

/** The corpus's untracked, unignored file. */
const UNTRACKED_FILES: Readonly<Record<string, string>> = {
  // In a tracked directory: an untracked directory is realized as one, and its row carries the
  // directory's mtime, which differs between the cells the harness rewrites.
  'src/untracked.ts': 'export const untracked = 1;\n',
};

/** Ignored entries a seed adds: an ignored directory, an ignored dot directory, and a config's ignored `files` entry. */
export const IGNORED_FILES: Readonly<Record<string, string>> = {
  'ignored/x.ts': 'export const x = 1;\n',
  '.cache/m.mts': 'export const m = 1;\n',
  'packages/c/gen/out.ts': 'export const out = 1;\n',
};

/** The untracked, unignored file a "build" writes, under the root config's `include`. */
export const BUILD_OUTPUT = 'src/gen.test.ts';

const SYMLINK_CAPABILITY = symlinkCapability();

/**
 * The committed files, and the tracked symlinks when the host can make them.
 *
 * @param corpus - An empty corpus
 */
function writeCommitted(corpus: string): void {
  writeCorpus(corpus, COMMITTED_FILES);
  if (SYMLINK_CAPABILITY !== null) {
    createSymlink(SYMLINK_CAPABILITY, 'src/a.ts', safePath.join(corpus, 'link.ts'), 'file');
    createSymlink(SYMLINK_CAPABILITY, 'src', safePath.join(corpus, 'srclink'), 'dir');
  }
}

/** The corpus as the I0 harness rewrites it per cell: committed, then the untracked file. */
export const TSCONFIG_TREE: FixtureTree = {
  committed: writeCommitted,
  untracked: (corpus) => writeCorpus(corpus, UNTRACKED_FILES),
};

/** The submodule directory's fixed mtime. */
const GITLINK_MTIME = new Date('2026-01-01T00:00:00.000Z');

/**
 * What only git can plant, after the commit: a submodule gitlink (an embedded repository,
 * committed), then a tracked file deleted from the worktree.
 *
 * @param corpus - The committed corpus
 * @param git - Git in the corpus, with an identity
 */
function plantGitEntries(corpus: string, git: Git): void {
  writeCorpus(corpus, { 'sub/inner.md': '# Inner\n' });
  git(['-C', 'sub', 'init', '-q', '-b', 'main']);
  git(['-C', 'sub', 'add', '-A']);
  git(['-C', 'sub', 'commit', '-q', '-m', 'inner']);
  git(['add', '--', 'sub']);
  git(['commit', '-q', '-m', 'a submodule gitlink']);
  expect(git(['ls-files', '-s', 'sub']), 'premise: sub is a gitlink').toMatch(/^160000 /u);
  // The gitlink is realized as a directory, whose row carries its mtime: pinned, so every cell the
  // harness rewrites answers alike.
  utimesSync(safePath.join(corpus, 'sub'), GITLINK_MTIME, GITLINK_MTIME);
  rmSync(safePath.join(corpus, 'src', 'gone.ts'));
}

/** Every seed's state A: what only git can plant, after the harness's commit. */
export const TSCONFIG_STATE_A: NonNullable<I0Seed['stateA']> = (corpus, git) => {
  plantGitEntries(corpus, git);
  return Promise.resolve();
};

/**
 * The whole corpus, outside the harness: committed, git's plants, then the untracked file.
 *
 * @param corpus - An empty directory
 * @param git - Git in the corpus, with an identity
 */
export function writeTsconfigCorpus(corpus: string, git: Git): void {
  writeCommitted(corpus);
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
  plantGitEntries(corpus, git);
  TSCONFIG_TREE.untracked(corpus);
}

/**
 * The routed data pairs: every `package.json` as `json` and every `tsconfig*.json` as `jsonc`, by
 * the instance's defaults, one pair each.
 */
export const TSCONFIG_ROUTED_PAIRS = Object.keys(COMMITTED_FILES).filter((path) => /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/u.test(path)).length;

// ── The census ──────────────────────────────────────────────────────────────

/** `git_content` and every `tsconfig_*` relation a statement can name: what the census covers. */
const TSCONFIG_I0_RELATIONS: readonly string[] = DUMPED_RELATIONS
  .map((relation) => relation.name)
  .filter((name) => name === 'git_content' || name.startsWith('tsconfig_'));

/** Rows sorted, as every answer holds them. */
const sorted = (rows: readonly string[]): string[] => rows.toSorted((left, right) => left.localeCompare(right));

/** What one relation answers: each row's deciding columns (all but `root` and `message`) as text, sorted. */
type TsconfigAnswer = Readonly<Record<string, readonly string[]>>;

/**
 * A census's answer, projected as {@link TsconfigAnswer} spells it.
 *
 * @param census - Rows per relation, as JSON text
 * @returns The answer
 */
function answerOf(census: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return Object.fromEntries(TSCONFIG_I0_RELATIONS.map((relation) => [
    relation,
    sorted((census[relation] ?? [])
      .map((row) => Object.entries(JSON.parse(row) as Record<string, unknown>)
        .filter(([column]) => column !== 'root' && column !== 'message')
        .map(([, value]) => String(value))
        .join(' '))),
  ]));
}

const ROOT_CONFIG = 'tsconfig.json';
const CHECK_CONFIG = 'tsconfig.check.json';
const A_CONFIG = 'packages/a/tsconfig.json';
const B_CONFIG = 'packages/b/tsconfig.json';
const C_CONFIG = 'packages/c/tsconfig.json';
const BASE_CONFIG = 'configs/tsconfig.base.json';
const STRICT_CONFIG = 'configs/tsconfig.strict.json';

/** The clean corpus's git content: `repository path`. */
const GIT_CONTENT: readonly string[] = [
  '.gitignore',
  'CLAUDE.md',
  'README.md',
  BASE_CONFIG,
  STRICT_CONFIG,
  ...(SYMLINK_CAPABILITY === null ? [] : ['link.ts']),
  'package.json',
  'packages/a/coverage/kept.test.ts',
  'packages/a/package.json',
  'packages/a/src/index.ts',
  A_CONFIG,
  'packages/b/package.json',
  'packages/b/src/index.ts',
  B_CONFIG,
  'packages/c/lib/util.js',
  'packages/c/main.ts',
  C_CONFIG,
  'src/a.ts',
  'src/untracked.ts',
  ...(SYMLINK_CAPABILITY === null ? [] : ['srclink']),
  CHECK_CONFIG,
  ROOT_CONFIG,
  'vibe-agent-toolkit.config.yaml',
].map((path) => ` ${path}`);

const PACKAGE = 'package.json';
const REACHES = 'TSCONFIG_REACHES_OUTSIDE_GIT';

/**
 * What the clean corpus answers, relation by relation: each row's columns in declaration order,
 * `root` and `message` aside (booleans as SQL holds them, 1 or 0).
 */
export const CLEAN_ANSWER: TsconfigAnswer = {
  git_content: sorted(GIT_CONTENT),
  // `package path script segment ordinal package packageDir compiler project config buildMode line`:
  // the last `/name`, the last `build` (line 7, not 6), `&&`, `||` and `;` segments, `-b` with two
  // positionals, `--project=`, a missing config, and a package's `-p .`.
  tsconfig_invocations: sorted([
    `${PACKAGE} build 0 0 tsconfig-root . tsc packages/a ${A_CONFIG} 1 7`,
    `${PACKAGE} build 0 1 tsconfig-root . tsc packages/b ${B_CONFIG} 1 7`,
    `${PACKAGE} check 0 0 tsconfig-root . tsc ${CHECK_CONFIG} ${CHECK_CONFIG} 0 8`,
    `${PACKAGE} lint 1 0 tsconfig-root . tsc ${ROOT_CONFIG} ${ROOT_CONFIG} 0 9`,
    `${PACKAGE} c 1 0 tsconfig-root . tsc packages/c ${C_CONFIG} 0 10`,
    `${PACKAGE} missing 0 0 tsconfig-root . tsc tsconfig.missing.json null 0 11`,
    `packages/a/${PACKAGE} build 0 0 a packages/a tsc packages/a ${A_CONFIG} 0 4`,
  ]),
  // `config ordinal spec path`
  tsconfig_references: sorted([
    `${ROOT_CONFIG} 0 packages/a ${A_CONFIG}`,
    `${ROOT_CONFIG} 1 packages/b ${B_CONFIG}`,
    `${B_CONFIG} 0 ../a ${A_CONFIG}`,
  ]),
  // `config member distance`: `a` is one step from the root config directly, never two through `b`.
  tsconfig_closure: sorted([
    `${ROOT_CONFIG} ${ROOT_CONFIG} 0`,
    `${ROOT_CONFIG} ${A_CONFIG} 1`,
    `${ROOT_CONFIG} ${B_CONFIG} 1`,
    `${CHECK_CONFIG} ${CHECK_CONFIG} 0`,
    `${A_CONFIG} ${A_CONFIG} 0`,
    `${B_CONFIG} ${B_CONFIG} 0`,
    `${B_CONFIG} ${A_CONFIG} 1`,
    `${C_CONFIG} ${C_CONFIG} 0`,
  ]),
  // `path outDir rootDir baseUrl allowJs resolveJsonModule composite`
  tsconfig_configs: sorted([
    `${ROOT_CONFIG} null null null null null null`,
    `${CHECK_CONFIG} null null null null null null`,
    `${A_CONFIG} packages/a/dist packages/a/src null null null 1`,
    `${B_CONFIG} null null packages/b null null 1`,
    `${C_CONFIG} null null null 1 1 null`,
  ]),
  // `config ordinal path`: the array `extends` in order, and an `extends` of the root config.
  tsconfig_extends: sorted([
    `${A_CONFIG} 0 ${BASE_CONFIG}`,
    `${A_CONFIG} 1 ${STRICT_CONFIG}`,
    `${B_CONFIG} 0 ${BASE_CONFIG}`,
    `${CHECK_CONFIG} 0 ${ROOT_CONFIG}`,
  ]),
  // `config path`: `${configDir}/src` resolved per extending config; the untracked file a member;
  // never the deleted `src/gone.ts`, `coverage/`, the ignored `files` entry or anything through a link.
  tsconfig_files: sorted([
    `${ROOT_CONFIG} src/a.ts`,
    `${ROOT_CONFIG} src/untracked.ts`,
    `${CHECK_CONFIG} src/a.ts`,
    `${CHECK_CONFIG} src/untracked.ts`,
    `${A_CONFIG} packages/a/src/index.ts`,
    `${B_CONFIG} packages/b/src/index.ts`,
    `${C_CONFIG} packages/c/lib/util.js`,
    `${C_CONFIG} packages/c/main.ts`,
  ]),
  // `config pattern ordinal target basePath`
  tsconfig_paths: sorted([
    `${B_CONFIG} @a/* 0 ../a/src/* packages/b`,
    `${B_CONFIG} @b 0 ./src/index.ts packages/b`,
    `${B_CONFIG} @b 1 ./src/fallback.ts packages/b`,
  ]),
  // `path code seq kind reached`
  tsconfig_conditions: sorted([
    `${PACKAGE} TSCONFIG_INVOKED_MISSING 0 null null`,
    `${C_CONFIG} ${REACHES} 0 files-entry packages/c/gen/out.ts`,
    `${C_CONFIG} ${REACHES} 1 include-entry packages/c/generated`,
  ]),
};

/**
 * The census over every measured dump of a seed: rows in `git_content` and every `tsconfig_*`
 * relation, every arm alike ({@link expectArmsCensus}), then the corpus's own answer.
 *
 * @param runs - The consumed runs; must hold `storeOff:measured`
 * @param answer - What the corpus answers
 */
export function expectTsconfigCensus(runs: RecordedRuns, answer: TsconfigAnswer = CLEAN_ANSWER): void {
  const census = expectArmsCensus(runs, TSCONFIG_I0_RELATIONS);
  expect(answerOf(census), 'the corpus\'s answer').toEqual(answer);
}

/**
 * The clean answer with `path` added as git content and as a root file of each of `configs`:
 * what a file the build writes changes, and nothing else.
 *
 * @param path - The written file
 * @param configs - The configs whose inputs include it
 * @returns The answer
 */
export function answerWith(path: string, configs: readonly string[]): TsconfigAnswer {
  return {
    ...CLEAN_ANSWER,
    git_content: sorted([...(CLEAN_ANSWER['git_content'] ?? []), ` ${path}`]),
    tsconfig_files: sorted([...(CLEAN_ANSWER['tsconfig_files'] ?? []), ...configs.map((config) => `${config} ${path}`)]),
  };
}

/** The config the warm-after-edit seed rewrites, and its bytes after: `b` drops its reference and one `paths` target. */
export const EDITED_CONFIG = B_CONFIG;
export const EDITED_CONFIG_BYTES = json({
  extends: '../../configs/tsconfig.base.json',
  compilerOptions: { composite: true, baseUrl: '.', paths: { '@a/*': ['../a/src/*'], '@b': ['./src/index.ts'] } },
});

/** What the corpus answers after {@link EDITED_CONFIG_BYTES}. */
export const EDITED_ANSWER: TsconfigAnswer = {
  ...CLEAN_ANSWER,
  tsconfig_references: (CLEAN_ANSWER['tsconfig_references'] ?? []).filter((row) => !row.startsWith(`${B_CONFIG} `)),
  tsconfig_closure: (CLEAN_ANSWER['tsconfig_closure'] ?? []).filter((row) => row !== `${B_CONFIG} ${A_CONFIG} 1`),
  tsconfig_paths: (CLEAN_ANSWER['tsconfig_paths'] ?? []).filter((row) => !row.includes('fallback')),
};

/** The configs whose `include` reaches {@link BUILD_OUTPUT}: the root config and the one extending it. */
export const BUILD_OUTPUT_CONFIGS: readonly string[] = [ROOT_CONFIG, CHECK_CONFIG];
