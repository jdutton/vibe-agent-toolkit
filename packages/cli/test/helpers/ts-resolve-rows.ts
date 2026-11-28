/**
 * The resolved import graph's I0 corpus as the CLI arms run it:
 * the workspace of `packages/resources/test/helpers/ts-resolve-corpus.ts` (described there) plus the
 * VAT config and markdown every arm reads, the census every arm answers alike, and the expected rows
 * of `ts_import_targets`, `ts_program_files` and `ts_import_conditions` over it.
 */

import { createRequire } from 'node:module';

import { expect } from 'vitest';

import { LAYOUT_CONFIGS, TS_RESOLVE_WORKSPACE } from '../../../resources/test/helpers/ts-resolve-corpus.js';
import { writeCorpus } from '../test-helpers.js';

import { DUMPED_RELATIONS, type FixtureTree, type RecordedRuns } from './cache-differential.js';
import { DATA_CONFIG, expectArmsCensus } from './data-rows.js';


// ── The corpus ──────────────────────────────────────────────────────────────

/**
 * The corpus's committed files, by root-relative path: the workspace and what the CLI arms read.
 * Exported for the tests that build the same tree through the CLI elsewhere (the compiler
 * differential, the no-disk proof, the module-load budget).
 */
export const TS_RESOLVE_FILES: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': DATA_CONFIG,
  'README.md': '# ts resolve corpus\n',
  // An `@`-import gives the claude-context lens a key of its own, as the data corpus's does.
  'CLAUDE.md': '# Memory\n\n@README.md\n',
  ...TS_RESOLVE_WORKSPACE,
};

/** The corpus as the I0 harness rewrites it per cell: committed, nothing untracked. */
export const TS_RESOLVE_TREE: FixtureTree = {
  committed: (corpus) => writeCorpus(corpus, TS_RESOLVE_FILES),
  untracked: () => undefined,
};

/** A file only a `referencePath` reaches (distance 1): excluding it from the `ts` instance refuses all three relations. */
export const REACHED_ONLY_FILE = 'packages/refs/src/globals.d.ts';

// ── The expected rows ───────────────────────────────────────────────────────

/** A `ts_import_targets` row, `root` aside. */
interface ExpectedTarget {
  readonly config: string;
  readonly path: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly specifier: string;
  readonly mode: 'import' | 'require' | null;
  readonly targetKind: string;
  readonly target: string | null;
  readonly package: string | null;
  readonly pathsMatched: boolean;
  readonly redirected: boolean;
}

/** A `ts_program_files` row, `root` aside. */
interface ExpectedProgramFile {
  readonly config: string;
  readonly path: string;
  readonly distance: number;
  readonly reachedOnly: boolean;
}

/** A `ts_import_conditions` row, `root` and `message` aside. */
interface ExpectedCondition {
  readonly config: string | null;
  readonly path: string | null;
  readonly ordinal: number | null;
  readonly code: string;
  readonly pinnedMajor: number | null;
  readonly declaredMajors: string | null;
  readonly manifests: number | null;
}

const APP = 'packages/app/tsconfig.json';
const APP_INDEX = 'packages/app/src/index.ts';
const LIB = 'packages/lib/tsconfig.build.json';
const LIB_INDEX = 'packages/lib/src/index.ts';
const OTHER = 'packages/other/tsconfig.json';
const BUNDLED = 'packages/bundled/tsconfig.json';
const REFS = 'packages/refs/tsconfig.json';
const REFS_MAIN = 'packages/refs/src/main.ts';
const CONSUMER = 'packages/consumer/tsconfig.json';
const CONSUMER_INDEX = 'packages/consumer/src/index.ts';
const LIB_FEATURE = 'packages/lib/src/feature.ts';
const LAYOUT = '@acme/layout';

/** One reference's row, columns in declaration order. */
function target(
  at: readonly [config: string, path: string, ordinal: number],
  reference: readonly [kind: string, specifier: string, mode: ExpectedTarget['mode']],
  targetKind: string, resolved: string | null, named: string | null, flags: { readonly paths?: true; readonly redirected?: true } = {},
): ExpectedTarget {
  const [config, path, ordinal] = at;
  const [kind, specifier, mode] = reference;
  return { config, path, ordinal, kind, specifier, mode, targetKind, target: resolved, package: named, pathsMatched: flags.paths === true, redirected: flags.redirected === true };
}

const REDIRECTED = { redirected: true } as const;

/** A `@acme/layout` subpath the consumer's index imports, resolved through the link and the output map to `source`. */
function layout(ordinal: number, subpath: string, source: string): ExpectedTarget {
  return target([CONSUMER, CONSUMER_INDEX, ordinal], ['import', `${LAYOUT}/${subpath}`, 'import'], 'member', `packages/layout/src/${source}`, LAYOUT, REDIRECTED);
}

/** What the clean corpus's `ts_import_targets` holds, by fixture. */
const EXPECTED_TARGETS: readonly ExpectedTarget[] = [
  // The `{ types, import }`-only root export resolves under `require` mode (TypeScript adds `types`
  // to every condition set), through the link and the output map; `./feature` skips `browser`.
  target([APP, APP_INDEX, 0], ['import', '@acme/lib', 'require'], 'member', LIB_INDEX, '@acme/lib', REDIRECTED),
  target([APP, APP_INDEX, 1], ['import', '@acme/lib/feature', 'require'], 'member', LIB_FEATURE, '@acme/lib', REDIRECTED),
  // A `resolution-mode` attribute on an `import type` overrides the file's CommonJS format.
  target([APP, APP_INDEX, 2], ['import', '@acme/lib', 'import'], 'member', LIB_INDEX, '@acme/lib', REDIRECTED),
  // `paths` from the extended config, against that config's directory (`pathsBasePath`).
  target([APP, APP_INDEX, 3], ['import', '@shared/util', 'require'], 'file', 'packages/app/src/shared/util.ts', '@shared/util', { paths: true }),
  // A failing alias is `unresolved`, never `external`.
  target([APP, APP_INDEX, 4], ['import', '@missing/thing', 'require'], 'unresolved', null, '@missing/thing', { paths: true }),
  // An alias into `node_modules/@acme/lib`: the link, then the output map.
  target([APP, APP_INDEX, 5], ['import', '@lib-alias', 'require'], 'member', LIB_INDEX, '@lib-alias', { paths: true, redirected: true }),
  target([APP, APP_INDEX, 6], ['import', 'lodash', 'require'], 'external', null, 'lodash'),
  target([APP, APP_INDEX, 7], ['import', 'node:fs', 'require'], 'builtin', null, null),
  target([APP, APP_INDEX, 8], ['import', 'fs', 'require'], 'builtin', null, 'fs'),
  // Relative `.js` to `.ts`.
  target([APP, APP_INDEX, 9], ['import', './util.js', 'require'], 'file', 'packages/app/src/util.ts', null),
  // A dynamic `import()` in a CommonJS-format file takes import mode.
  target([APP, APP_INDEX, 10], ['dynamic', '@acme/lib', 'import'], 'member', LIB_INDEX, '@acme/lib', REDIRECTED),
  // `module: commonjs` under `moduleResolution: bundler`: require mode.
  target([BUNDLED, 'packages/bundled/src/main.ts', 0], ['import', './util', 'require'], 'file', 'packages/bundled/src/util.ts', null),
  // A script file's ambient module: its name is no row, the bare import in its body is.
  target([CONSUMER, 'packages/consumer/src/ambient.d.ts', 1], ['import', 'shape-lib', 'import'], 'external', null, 'shape-lib'),
  // An augmentation in a module file is resolved.
  target([CONSUMER, 'packages/consumer/src/augment.ts', 0], ['ambient', `${LAYOUT}/plain`, 'import'], 'member', 'packages/layout/src/plain.ts', null, REDIRECTED),
  layout(0, 'plain', 'plain.ts'),
  layout(1, 'composite', 'comp.ts'),
  layout(2, 'decl', 'decl.ts'),
  layout(3, 'declonly', 'declonly.ts'),
  layout(4, 'jsx', 'view.tsx'),
  layout(5, 'data', 'data.json'),
  // An `outFile` bundle's declaration: git content no output map holds.
  target([CONSUMER, CONSUMER_INDEX, 6], ['import', `${LAYOUT}/bundle`, 'import'], 'outputUnmapped', 'packages/layout/bundle/out.d.ts', LAYOUT),
  // `x.ts` and `x.tsx` in one config, then one output of two configs: each ambiguous, so unresolved.
  target([CONSUMER, CONSUMER_INDEX, 7], ['import', `${LAYOUT}/amb`, 'import'], 'unresolved', null, LAYOUT),
  target([CONSUMER, CONSUMER_INDEX, 8], ['import', `${LAYOUT}/two`, 'import'], 'unresolved', null, LAYOUT),
  target([LIB, LIB_INDEX, 0], ['import', './feature.js', 'import'], 'file', LIB_FEATURE, null),
  // `#imports` and a self-reference: TypeScript's own input mapping answers a source, never redirected.
  target([LIB, LIB_INDEX, 1], ['import', '#internal', 'import'], 'file', 'packages/lib/src/internal.ts', null),
  target([LIB, LIB_INDEX, 2], ['import', '@acme/lib/feature', 'import'], 'file', LIB_FEATURE, '@acme/lib'),
  // A directory import under NodeNext, as tsc.
  target([LIB, LIB_INDEX, 3], ['import', './dir', 'import'], 'unresolved', null, null),
  // A sibling's link is not this file's; the root manifest's is.
  target([OTHER, 'packages/other/src/index.ts', 0], ['import', '@acme/lib', 'require'], 'memberUndeclared', null, '@acme/lib'),
  target([OTHER, 'packages/other/src/index.ts', 1], ['import', '@acme/shared', 'require'], 'member', 'packages/shared/index.d.ts', '@acme/shared'),
  // The triple-slash forms; `types` through `typeRoots`, under the file's default mode.
  target([REFS, REFS_MAIN, 0], ['referencePath', './globals.d.ts', null], 'file', REACHED_ONLY_FILE, null),
  target([REFS, REFS_MAIN, 1], ['referenceTypes', 'env', 'require'], 'file', 'packages/refs/types/env/index.d.ts', null),
  target([REFS, REFS_MAIN, 2], ['referenceLib', 'es2020', null], 'lib', null, null),
];

/** Every demanded config's root files (distance 0), then what only a reference reaches. */
const ROOT_FILES: Readonly<Record<string, readonly string[]>> = {
  [APP]: [APP_INDEX, 'packages/app/src/shared/util.ts', 'packages/app/src/util.ts'],
  [BUNDLED]: ['packages/bundled/src/main.ts', 'packages/bundled/src/util.ts'],
  [CONSUMER]: ['packages/consumer/src/ambient.d.ts', 'packages/consumer/src/augment.ts', CONSUMER_INDEX],
  [LIB]: ['packages/lib/src/dir/index.ts', LIB_FEATURE, LIB_INDEX, 'packages/lib/src/internal.ts'],
  [OTHER]: ['packages/other/src/index.ts'],
  [REFS]: [REFS_MAIN],
  ...Object.fromEntries(Object.entries(LAYOUT_CONFIGS).map(([name, value]) => [
    `packages/layout/${name}`,
    (value['files'] as readonly string[]).map((file) => `packages/layout/${file}`),
  ])),
};

/** What the clean corpus's `ts_program_files` holds: every config's root files, and the two files only `refs`' directives reach. */
const EXPECTED_PROGRAM_FILES: readonly ExpectedProgramFile[] = [
  ...Object.entries(ROOT_FILES).flatMap(([config, paths]) => paths.map((path) => ({ config, path, distance: 0, reachedOnly: false }))),
  { config: REFS, path: REACHED_ONLY_FILE, distance: 1, reachedOnly: true },
  { config: REFS, path: 'packages/refs/types/env/index.d.ts', distance: 1, reachedOnly: true },
];

/** An ambiguity condition at one of the consumer's references. */
function ambiguity(ordinal: number): ExpectedCondition {
  return { config: CONSUMER, path: CONSUMER_INDEX, ordinal, code: 'TS_OUTPUT_REDIRECT_AMBIGUOUS', pinnedMajor: null, declaredMajors: null, manifests: null };
}

/** What the clean corpus's `ts_import_conditions` holds: the two ambiguities, and the root's skew. */
const EXPECTED_CONDITIONS: readonly ExpectedCondition[] = [
  ambiguity(7),
  ambiguity(8),
  { config: null, path: null, ordinal: null, code: 'TS_VERSION_SKEW', pinnedMajor: 6, declaredMajors: '5', manifests: 1 },
];

/** Each ambiguity's two sources, by reference ordinal: its `message` names both. */
const AMBIGUOUS_SOURCES: Readonly<Record<number, readonly [string, string]>> = {
  7: ['packages/layout/src/x.ts', 'packages/layout/src/x.tsx'],
  8: ['packages/layout/src/two-a/two.ts', 'packages/layout/src/two-b/two.ts'],
};

// ── The census ──────────────────────────────────────────────────────────────

/** The three relations, as a statement names them. */
export const TS_RESOLVE_RELATIONS = ['ts_import_targets', 'ts_program_files', 'ts_import_conditions'] as const;

/** The census covers every relation the `tsResolve` producer publishes: the three, checked against the dumped list. */
const CENSUS_RELATIONS: readonly string[] = DUMPED_RELATIONS.map((relation) => relation.name).filter((name) => (TS_RESOLVE_RELATIONS as readonly string[]).includes(name));

/** Every `targetKind` the schema declares, read from its generated JSON Schema, so a kind added later must appear here too. */
const TARGET_KINDS: readonly string[] = ((createRequire(import.meta.url)('@vibe-agent-toolkit/resources/schemas/projection-ts-import-targets.json') as {
  definitions: Record<string, { properties: { targetKind: { enum: readonly string[] } } }>;
}).definitions['projection-ts-import-targets']?.properties.targetKind.enum) ?? [];

/** A typed row as SQL holds it: booleans as 1 or 0, as JSON text with sorted keys. */
function sqlText(row: object): string {
  const entries = Object.entries(row).map(([column, value]) => [column, typeof value === 'boolean' ? Number(value) : value] as const);
  return JSON.stringify(Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right))));
}

/** A dumped row with `root` (and, for conditions, `message`) dropped, as {@link sqlText} spells it. */
function dumpedText(row: string, dropped: readonly string[]): string {
  const parsed = JSON.parse(row) as Record<string, unknown>;
  return sqlText(Object.fromEntries(Object.entries(parsed).filter(([column]) => !dropped.includes(column))));
}

const sortedTexts = (rows: readonly string[]): string[] => rows.toSorted((left, right) => left.localeCompare(right));

/**
 * The census over every measured dump of a seed: rows in each of the three relations, every arm
 * alike ({@link expectArmsCensus}); then the corpus's own answer, every `targetKind` present, and
 * each ambiguity naming both its sources.
 *
 * @param runs - The consumed runs; must hold `storeOff:measured`
 */
export function expectTsResolveCensus(runs: RecordedRuns): void {
  expect(sortedTexts(CENSUS_RELATIONS), 'the three relations are dumped').toEqual(sortedTexts(TS_RESOLVE_RELATIONS));
  const census = expectArmsCensus(runs, CENSUS_RELATIONS);
  const rows = (relation: string, dropped: readonly string[]): string[] => sortedTexts((census[relation] ?? []).map((row) => dumpedText(row, dropped)));
  expect(rows('ts_import_targets', ['root']), 'ts_import_targets').toEqual(sortedTexts(EXPECTED_TARGETS.map((row) => sqlText(row))));
  expect(rows('ts_program_files', ['root']), 'ts_program_files').toEqual(sortedTexts(EXPECTED_PROGRAM_FILES.map((row) => sqlText(row))));
  expect(rows('ts_import_conditions', ['root', 'message']), 'ts_import_conditions').toEqual(sortedTexts(EXPECTED_CONDITIONS.map((row) => sqlText(row))));
  const kinds = new Set((census['ts_import_targets'] ?? []).map((row) => (JSON.parse(row) as { targetKind: string }).targetKind));
  expect(TARGET_KINDS.length, 'premise: the schema declares the kinds').toBeGreaterThan(0);
  expect(TARGET_KINDS.filter((kind) => !kinds.has(kind)), 'every targetKind is present').toEqual([]);
  for (const row of census['ts_import_conditions'] ?? []) {
    const { code, ordinal, message } = JSON.parse(row) as { code: string; ordinal: number | null; message: string };
    if (code !== 'TS_OUTPUT_REDIRECT_AMBIGUOUS' || ordinal === null) continue;
    for (const source of AMBIGUOUS_SOURCES[ordinal] ?? []) expect(message, `ambiguity ${String(ordinal)} names ${source}`).toContain(`'${source}'`);
  }
}
