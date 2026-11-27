/**
 * The workspace relations' system proofs, shared (spec 6.4): one clean corpus per layout (npm, yarn
 * berry, bun and pnpm), the census the I0 differential runs over each (`workspace_*` and `data__*`,
 * rows in every relation, every arm alike, then the layout's own answer), and one defect seed per
 * refusal and defective input, each its own corpus.
 *
 * `targetPath` is the member a dependency NAMES, never what an install links, so each layout pins
 * its manager's structural rules: a path (`workspace:<path>`, `file:`, `link:`) by directory, from
 * where that manager resolves it; anything else (`workspace:*`, `catalog:`, a plain range, an alias)
 * by name, the range kept as written; and whether a name can reach the root package.
 *
 * Every layout holds a member whose `"name"` is written twice (no refusal: its `name` is the last
 * value, and `data__conditions` holds the `DATA_DUPLICATE_KEY`) and a path that names no member (a
 * `WORKSPACE_PATH_UNRESOLVED` condition), so neither condition relation can agree by being empty.
 */

import { expect } from 'vitest';

import { writeCorpus } from '../test-helpers.js';

import { DUMPED_RELATIONS, dumpSqlOf, queryVerb, relationRows, type FixtureTree, type I0Seed, type RecordedRuns, type VerbRow } from './cache-differential.js';
import { DATA_CONFIG, DATA_RELATIONS, EVERY_ARM, expectArmsCensus, forEachCheckAndQuery, type RecordedRun } from './data-rows.js';

// ── Layouts ─────────────────────────────────────────────────────────────────

/** Every `workspace_*` relation a statement can name. */
const WORKSPACE_RELATIONS: readonly string[] = DUMPED_RELATIONS.map((relation) => relation.name).filter((name) => name.startsWith('workspace_'));

/** The files every layout holds beside its workspace. */
const SHARED_FILES: Readonly<Record<string, string>> = {
  'README.md': '# Workspace corpus\n',
  // An `@`-import gives the claude-context lens a key of its own, as the data corpus's does.
  'CLAUDE.md': '# Memory\n\n@README.md\n',
};

/** What one layout answers: each relation's rows, projected to the columns that decide them. */
interface WorkspaceAnswer {
  /** `<path> <name>`, root first, by path. */
  readonly packages: readonly string[];
  /** `<path> <field> <name> <range> -> <targetPath> <protocol>`, by path, field and name. */
  readonly dependencies: readonly string[];
  /** `<path> <code>`, by path and code. */
  readonly conditions: readonly string[];
}

/** One clean workspace corpus and what it answers. */
interface WorkspaceLayout {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly answer: WorkspaceAnswer;
  /**
   * What `data__values` holds for `.npmrc` at `/link-workspace-packages`, when the layout has one: a
   * boolean as SQL holds it (1 or 0). The workspace step never reads it; the data rows still do.
   */
  readonly npmrcSetting?: unknown;
}

const PKG = 'package.json';
const A = 'packages/a/package.json';
const B = 'packages/b/package.json';
const C = 'packages/c/package.json';
const NPMRC = '.npmrc';
const PNPM_WORKSPACE = 'pnpm-workspace.yaml';
/** The pnpm layout's member under a `test` directory. */
const PNPM_TEST = 'packages/test/package.json';
const PATH_UNRESOLVED = 'WORKSPACE_PATH_UNRESOLVED';

/** A `package.json`'s text. */
const manifest = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;

/** A member whose `"name"` is written twice: `first`, then `a`. Strict JSON allows it; a record cannot hold it. */
const twiceNamed = (rest: Record<string, unknown>): string => `{"name": "first", ${JSON.stringify({ name: 'a', ...rest }).slice(1)}\n`;

/**
 * npm: `workspaces` patterns canonicalised (`./`, `..`); a plain range names the same-named member
 * whatever its version; the root is never reachable by name; `file:` resolves from the declaring package.
 */
const NPM: WorkspaceLayout = {
  name: 'npm',
  files: {
    [PKG]: manifest({ name: 'npm-root', private: true, packageManager: 'npm@10.8.0', workspaces: ['./packages/*', 'tools/../libs/*'] }),
    [A]: twiceNamed({ version: '1.0.0', dependencies: { b: '^9.0.0', lib: '*', react: '^18.0.0', c: 'catalog:', d: 'file:../missing' } }),
    [B]: manifest({ name: 'b', version: '1.2.0', dependencies: { 'npm-root': '*' } }),
    'libs/lib/package.json': manifest({ name: 'lib', version: '0.1.0', devDependencies: { a: '1.0.0' } }),
    // No pattern names `other/*`.
    'other/outside/package.json': manifest({ name: 'outside', version: '1.0.0' }),
  },
  answer: {
    packages: ['libs/lib/package.json lib', 'package.json npm-root', `${A} a`, `${B} b`],
    dependencies: [
      `libs/lib/package.json devDependencies a 1.0.0 -> ${A} npm`,
      `${A} dependencies b ^9.0.0 -> ${B} npm`,
      `${A} dependencies c catalog: -> null catalog`,
      `${A} dependencies d file:../missing -> null file`,
      `${A} dependencies lib * -> libs/lib/package.json npm`,
      `${A} dependencies react ^18.0.0 -> null npm`,
      `${B} dependencies npm-root * -> null npm`,
    ],
    conditions: [`${A} ${PATH_UNRESOLVED}`],
  },
};

/**
 * yarn berry: `workspaces` as `{ packages: [...] }`; `workspace:^` by name, `workspace:<path>` from
 * the project root (no leading `./` needed), and the root reachable by name.
 */
const YARN: WorkspaceLayout = {
  name: 'yarn',
  files: {
    [PKG]: manifest({ name: 'yarn-root', packageManager: 'yarn@4.1.0', workspaces: { packages: ['packages/*'] } }),
    [A]: twiceNamed({
      version: '1.0.0',
      dependencies: { b: 'workspace:^', c: 'catalog:', 'left-pad': '^1.3.0', missing: 'workspace:missing' },
      devDependencies: { b: 'workspace:packages/b' },
    }),
    [B]: manifest({ name: 'b', version: '2.0.0', peerDependencies: { 'yarn-root': 'workspace:*' } }),
  },
  answer: {
    packages: ['package.json yarn-root', `${A} a`, `${B} b`],
    dependencies: [
      `${A} dependencies b workspace:^ -> ${B} workspace`,
      `${A} dependencies c catalog: -> null catalog`,
      `${A} dependencies left-pad ^1.3.0 -> null npm`,
      `${A} dependencies missing workspace:missing -> null workspace`,
      `${A} devDependencies b workspace:packages/b -> ${B} workspace`,
      `${B} peerDependencies yarn-root workspace:* -> package.json workspace`,
    ],
    conditions: [`${A} ${PATH_UNRESOLVED}`],
  },
};

const TWIN_1 = 'packages/twin1/package.json';
const TWIN_2 = 'packages/twin2/package.json';

/**
 * bun: `workspaces` as npm's; `link:` and `file:` by directory; the root reachable through
 * `workspace:` only; two members of one name are each a duplicate, and a dependency on it names neither.
 */
const BUN: WorkspaceLayout = {
  name: 'bun',
  files: {
    [PKG]: manifest({ name: 'bun-root', packageManager: 'bun@1.1.0', workspaces: ['packages/*'] }),
    [A]: twiceNamed({ version: '1.0.0', dependencies: { b: 'workspace:*', c: 'link:../c', d: 'file:../missing', e: 'catalog:', twin: 'workspace:*' } }),
    [B]: manifest({ name: 'b', version: '1.0.0', dependencies: { 'bun-root': 'workspace:*' } }),
    [C]: manifest({ name: 'c', version: '1.0.0', dependencies: { 'bun-root': '^1.0.0' } }),
    [TWIN_1]: manifest({ name: 'twin', version: '1.0.0' }),
    [TWIN_2]: manifest({ name: 'twin', version: '2.0.0' }),
  },
  answer: {
    packages: ['package.json bun-root', `${A} a`, `${B} b`, `${C} c`, `${TWIN_1} twin`, `${TWIN_2} twin`],
    dependencies: [
      `${A} dependencies b workspace:* -> ${B} workspace`,
      `${A} dependencies c link:../c -> ${C} link`,
      `${A} dependencies d file:../missing -> null file`,
      `${A} dependencies e catalog: -> null catalog`,
      `${A} dependencies twin workspace:* -> null workspace`,
      `${B} dependencies bun-root workspace:* -> package.json workspace`,
      `${C} dependencies bun-root ^1.0.0 -> null npm`,
    ],
    conditions: [`${A} ${PATH_UNRESOLVED}`, `${TWIN_1} WORKSPACE_DUPLICATE_NAME`, `${TWIN_2} WORKSPACE_DUPLICATE_NAME`],
  },
};

/** `.npmrc`'s setting, on: data rows hold it, and the workspace step never reads it. */
export const NPMRC_ON = 'link-workspace-packages=true';

/**
 * pnpm 10.5: `packages` with a negation and a `test` directory (a member: pnpm's workspace finder
 * ignores only `node_modules` and `bower_components`); catalogs written and never resolved (a
 * `catalog:` range is kept as written and names by name); a plain range names the member with no
 * linking setting read (`.npmrc` sets it on; nothing would change were it off); the
 * `workspace:<path>` form from the declaring package; the `workspace:<alias>@<range>` form; and
 * the root reachable by name.
 */
export const PNPM: WorkspaceLayout = {
  name: 'pnpm',
  files: {
    [PKG]: manifest({ name: 'pnpm-root', private: true, packageManager: 'pnpm@10.5.0' }),
    [PNPM_WORKSPACE]: [
      'packages:',
      '  - packages/*',
      "  - '!packages/ignored'",
      'catalog:',
      '  react: ^18.2.0',
      '  b: ^1.0.0',
      'catalogs:',
      '  legacy:',
      '    react: ^16.14.0',
      '',
    ].join('\n'),
    [NPMRC]: `${NPMRC_ON}\n`,
    [A]: twiceNamed({
      version: '1.0.0',
      dependencies: { b: '^1.0.0', c: 'workspace:../c', react: 'catalog:', missing: 'catalog:nope', alias: 'workspace:c@*', d: 'workspace:../missing' },
      devDependencies: { react: 'catalog:legacy' },
      peerDependencies: { b: 'catalog:' },
    }),
    [B]: manifest({ name: 'b', version: '1.2.0', private: true }),
    [C]: manifest({ name: 'c', version: '2.0.0', dependencies: { 'pnpm-root': '^1.0.0' } }),
    // Negated: never a member. A `test` directory: a member.
    'packages/ignored/package.json': manifest({ name: 'ignored', version: '1.0.0' }),
    [PNPM_TEST]: manifest({ name: 'in-test', version: '1.0.0' }),
  },
  answer: {
    packages: ['package.json pnpm-root', `${A} a`, `${B} b`, `${C} c`, `${PNPM_TEST} in-test`],
    dependencies: [
      `${A} dependencies alias workspace:c@* -> ${C} workspace`,
      `${A} dependencies b ^1.0.0 -> ${B} npm`,
      `${A} dependencies c workspace:../c -> ${C} workspace`,
      `${A} dependencies d workspace:../missing -> null workspace`,
      `${A} dependencies missing catalog:nope -> null catalog`,
      `${A} dependencies react catalog: -> null catalog`,
      `${A} devDependencies react catalog:legacy -> null catalog`,
      `${A} peerDependencies b catalog: -> ${B} catalog`,
      `${C} dependencies pnpm-root ^1.0.0 -> package.json npm`,
    ],
    conditions: [`${A} ${PATH_UNRESOLVED}`],
  },
  npmrcSetting: 1,
};

/** Every clean layout, each its own corpus. */
export const WORKSPACE_LAYOUTS: readonly WorkspaceLayout[] = [NPM, YARN, BUN, PNPM];

/**
 * A layout's files, config included.
 *
 * @param layout - The layout
 * @param config - The config's text
 * @returns The files
 */
export function layoutFiles(layout: WorkspaceLayout, config: string = DATA_CONFIG): Record<string, string> {
  return { ...SHARED_FILES, ...layout.files, 'vibe-agent-toolkit.config.yaml': config };
}

/**
 * A layout's routed data pairs: every `package.json`, `pnpm-workspace.yaml` and `.npmrc` by the
 * instance's defaults, one pair each.
 *
 * @param layout - The layout
 * @returns The count
 */
export function routedPairsOf(layout: WorkspaceLayout): number {
  return Object.keys(layout.files).filter((path) => [PKG, PNPM_WORKSPACE, NPMRC].includes(path.slice(path.lastIndexOf('/') + 1))).length;
}

/**
 * A layout's tree, committed.
 *
 * @param layout - The layout
 * @returns The tree
 */
export function layoutTree(layout: WorkspaceLayout): FixtureTree {
  return { committed: (corpus) => writeCorpus(corpus, layoutFiles(layout)), untracked: () => undefined };
}

// ── The census ──────────────────────────────────────────────────────────────

/** A relation's rows as records. */
const recordsOf = (rows: readonly string[]): Array<Record<string, unknown>> => rows.map((row) => JSON.parse(row) as Record<string, unknown>);

/** Sorted text. */
const sorted = (items: readonly string[]): string[] => items.toSorted((left, right) => left.localeCompare(right));

/**
 * A census's workspace answer, projected as {@link WorkspaceAnswer} spells it.
 *
 * @param census - Rows per relation
 * @returns The answer
 */
function workspaceAnswerOf(census: Readonly<Record<string, readonly string[]>>): WorkspaceAnswer {
  const of = (relation: string): Array<Record<string, unknown>> => recordsOf(census[relation] ?? []);
  return {
    packages: sorted(of('workspace_packages').map((row) => `${String(row['path'])} ${String(row['name'])}`)),
    dependencies: sorted(of('workspace_dependencies').map((row) => `${String(row['path'])} ${String(row['field'])} ${String(row['name'])} ${String(row['range'])} -> ${String(row['targetPath'])} ${String(row['protocol'])}`)),
    conditions: sorted(of('workspace_conditions').map((row) => `${String(row['path'])} ${String(row['code'])}`)),
  };
}

/** `data__values` of one path, as `<pointer> <value>`. */
function valuesAt(census: Readonly<Record<string, readonly string[]>>, path: string): string[] {
  return recordsOf(census['data__values'] ?? []).filter((row) => row['path'] === path).map((row) => `${String(row['pointer'])} ${JSON.stringify(row['value'])}`);
}

/**
 * The workspace census over one layout's measured dumps: rows in every `workspace_*` and `data__*`
 * relation in every arm, every arm alike, then the layout's own answer: its members, links and
 * conditions; the twice-named member named by its last value beside its `DATA_DUPLICATE_KEY`; and
 * `.npmrc`'s `data__values` holding the root and the one allowlisted setting, as written (a data
 * row the workspace step never reads).
 *
 * @param runs - The consumed runs; must hold `storeOff:measured`
 * @param answer - What the corpus answers
 * @param npmrcSetting - `.npmrc`'s stored setting, when the corpus has one
 * @returns The store-off census
 */
export function expectWorkspaceCensus(runs: RecordedRuns, answer: WorkspaceAnswer, npmrcSetting?: unknown): Record<string, readonly string[]> {
  const census = expectArmsCensus(runs, [...WORKSPACE_RELATIONS, ...DATA_RELATIONS]);
  expect(workspaceAnswerOf(census), 'the layout\'s workspace answer').toEqual(answer);
  expect(valuesAt(census, A).filter((value) => value.startsWith('/name ')), 'the twice-named member\'s name').toEqual(['/name "a"']);
  expect(recordsOf(census['data__conditions'] ?? []).map((row) => row['code']), 'the data conditions').toContain('DATA_DUPLICATE_KEY');
  if (npmrcSetting !== undefined) {
    // The root (pointer '', no value) and the one allowlisted setting.
    expect(valuesAt(census, NPMRC), '.npmrc\'s rows').toEqual([' null', `/link-workspace-packages ${JSON.stringify(npmrcSetting)}`]);
  }
  return census;
}

/**
 * A layout's clean seed: every arm answers its census alike.
 *
 * @param layout - The layout
 * @returns The seed
 */
export function cleanLayoutSeed(layout: WorkspaceLayout): I0Seed {
  return {
    name: layout.name,
    needs: null,
    arms: EVERY_ARM,
    verbs: ['query'],
    expect: { agrees: { because: `the ${layout.name} workspace, unplanted`, storeDeclines: null } },
    consumed: {
      runs: EVERY_ARM.map((arm) => `${arm}:measured` as const),
      check: (runs) => {
        expectWorkspaceCensus(runs, layout.answer, layout.npmrcSetting);
      },
    },
  };
}

// ── Defect seeds ────────────────────────────────────────────────────────────

/** The checks a defect seed's `vat resources check` runs: the members and the conditions. */
const WORKSPACE_CHECKS_CONFIG = [
  'resources:',
  '  include:',
  '    - "**/*.md"',
  '  checks:',
  '    ws-members:',
  '      description: Every workspace member',
  '      sql: "SELECT path, name FROM workspace_packages ORDER BY path"',
  '      severity: warning',
  '    ws-conditions:',
  '      description: Every workspace condition',
  '      sql: "SELECT path, code, seq FROM workspace_conditions ORDER BY path, code, seq"',
  '      severity: warning',
  '',
].join('\n');

/** The base every defect seed plants into: the pnpm layout, with the checks. */
export const WORKSPACE_DEFECT_TREE: FixtureTree = {
  committed: (corpus) => writeCorpus(corpus, layoutFiles(PNPM, WORKSPACE_CHECKS_CONFIG)),
  untracked: () => undefined,
};

/** The dump a defect seed's query runs: every relation but the workspace family, which a refusal would refuse whole. */
export const NON_WORKSPACE_QUERY: VerbRow = queryVerb(dumpSqlOf(DUMPED_RELATIONS.filter((relation) => !WORKSPACE_RELATIONS.includes(relation.name))));

/** A finding, the fields a defect seed reads. */
interface Finding {
  readonly code: string;
  readonly check?: string;
  readonly location?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly message: string;
}

/** One planted defect and what every arm must report of it. */
interface WorkspaceDefect {
  readonly name: string;
  /** The files written over the base (or a deletion, as null), committed. */
  readonly plant: Readonly<Record<string, string | null>>;
  /** The family's refusal, or null when it answers (a defective member). */
  readonly refusal: { readonly code: string; readonly path: string } | null;
  /** The paths each one `DATA_FILE_NO_ROWS` finding names. */
  readonly noRows: readonly string[];
  /** What the defect's file still answers over `data__values` (`<pointer> <value>`), every one of them. */
  readonly values: { readonly path: string; readonly holds: readonly string[] };
  /** The `data__conditions` codes the defect's file holds, when it holds any. */
  readonly conditions?: readonly string[];
  /** The checks' rows, when the family answers. */
  readonly answered?: { readonly members: readonly string[]; readonly conditions: readonly string[] };
}

/**
 * One corpus per refusal and defective input. Each names what `data__values` over the defect's own
 * file still answers: the family refusing never costs the data relations.
 */
export const WORKSPACE_DEFECTS: readonly WorkspaceDefect[] = [
  {
    // No pnpm-workspace.yaml and no packageManager: the root declares no workspace, while a member
    // links `workspace:../c`, which only a workspace resolves: its root may lie above the analysis
    // root. A condition at that manifest, never a refusal: a fixture is the common way to be here.
    name: 'rootOutsideRoot',
    plant: { [PNPM_WORKSPACE]: null, [PKG]: manifest({ name: 'pnpm-root', private: true }) },
    refusal: null,
    noRows: [],
    values: { path: A, holds: ['/dependencies/c "workspace:../c"'] },
    answered: { members: [], conditions: [`${A} WORKSPACE_ROOT_OUTSIDE_ROOT 0`] },
  },
  {
    // The root names pnpm and holds no pnpm-workspace.yaml: the declaration is missing, not above.
    name: 'notDeclared',
    plant: { [PNPM_WORKSPACE]: null },
    refusal: null,
    noRows: [],
    values: { path: A, holds: ['/dependencies/c "workspace:../c"'] },
    answered: { members: [], conditions: [`${A} WORKSPACE_NOT_DECLARED 0`] },
  },
  {
    // No packageManager and no pnpm-workspace.yaml, a pnpm-lock.yaml alone: pnpm by inference, said
    // at the root, and no workspace, said at the manifest declaring a `workspace:` dependency.
    name: 'lockfileOnlyPnpm',
    plant: { [PNPM_WORKSPACE]: null, [PKG]: manifest({ name: 'pnpm-root', private: true }), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
    refusal: null,
    noRows: [],
    values: { path: A, holds: ['/dependencies/c "workspace:../c"'] },
    // The root holds a package.json, so the manager condition sits at it, not at `.`.
    answered: { members: [], conditions: [`${PKG} WORKSPACE_MANAGER_INFERRED 0`, `${A} WORKSPACE_NOT_DECLARED 0`] },
  },
  {
    // yarn 1 enables `workspaces` only in a private root: without `private: true` there is none.
    name: 'yarnOneNotPrivate',
    plant: { [PKG]: manifest({ name: 'pnpm-root', packageManager: 'yarn@1.22.0', workspaces: ['packages/*'] }) },
    refusal: null,
    noRows: [],
    values: { path: PKG, holds: ['/packageManager "yarn@1.22.0"'] },
    answered: { members: [], conditions: [`${PKG} WORKSPACE_NOT_DECLARED 0`] },
  },
  {
    // A top-level `<<` in a file with no `packages` of its own: the merge may supply `packages`.
    name: 'mergeKey',
    plant: { [PNPM_WORKSPACE]: 'base: &base\n  packages:\n    - packages/*\n<<: *base\n' },
    refusal: { code: 'WORKSPACE_MERGE_KEY', path: PNPM_WORKSPACE },
    noRows: [],
    // `<<` is a key in the rows, never a merge.
    values: { path: PNPM_WORKSPACE, holds: ['/<< null', '/<</packages/0 "packages/*"'] },
  },
  {
    name: 'duplicateKey',
    plant: { [PNPM_WORKSPACE]: 'packages:\n  - libs/*\npackages:\n  - packages/*\n' },
    refusal: { code: 'WORKSPACE_DUPLICATE_KEY', path: PNPM_WORKSPACE },
    noRows: [],
    // The last value, and the condition row beside it.
    values: { path: PNPM_WORKSPACE, holds: ['/packages/0 "packages/*"'] },
    conditions: ['DATA_DUPLICATE_KEY'],
  },
  {
    // A member with no rows keeps its row (nulls), with its condition. Its name is unknown, so every
    // name match in the root is uncertain: one WORKSPACE_TARGET_UNKNOWN for the root, at the root
    // package.json, never one per dependency. No refusal.
    name: 'memberNoRows',
    plant: { [B]: '{"name": }\n' },
    refusal: null,
    noRows: [B],
    values: { path: A, holds: ['/dependencies/b "^1.0.0"'] },
    answered: {
      members: ['package.json pnpm-root', `${A} a`, `${B} null`, `${C} c`, `${PNPM_TEST} in-test`],
      conditions: [`${PKG} WORKSPACE_TARGET_UNKNOWN 0`, `${A} ${PATH_UNRESOLVED} 0`, `${B} WORKSPACE_MEMBER_NO_ROWS 0`],
    },
  },
  {
    name: 'rootNoRows',
    plant: { [PKG]: '{"name": "pnpm-root",\n' },
    refusal: { code: 'WORKSPACE_ROOT_NO_ROWS', path: PKG },
    noRows: [PKG],
    values: { path: A, holds: ['/name "a"'] },
  },
  {
    // The pnpm root needs pnpm-workspace.yaml, and the config excludes it from the data instance.
    name: 'excludedWorkspaceYaml',
    plant: { 'vibe-agent-toolkit.config.yaml': `${WORKSPACE_CHECKS_CONFIG}  extractors:\n    data:\n      exclude:\n        - "${PNPM_WORKSPACE}"\n` },
    refusal: { code: 'DATA_REQUEST_UNROUTED', path: PNPM_WORKSPACE },
    noRows: [],
    values: { path: PKG, holds: ['/packageManager "pnpm@10.5.0"'] },
  },
];

/**
 * The defect on one arm's check run: the refusal breaks both workspace checks, its code leading the
 * reason and the file named, or (no refusal) the checks report the member with no rows and its
 * conditions; and exactly the expected `DATA_FILE_NO_ROWS` findings.
 *
 * @param label - The run's label
 * @param findings - The check run's findings
 * @param defect - The defect
 */
function expectCheckReports(label: string, findings: readonly Finding[], defect: WorkspaceDefect): void {
  const broken = findings.filter((finding) => finding.code === 'RESOURCE_CHECK_BROKEN');
  if (defect.refusal === null) {
    expect(broken, `${label}: broken checks`).toEqual([]);
    const rows = (check: string, columns: readonly string[]): string[] => sorted(findings
      .filter((finding) => finding.code === `CUSTOM:${check}`)
      .map((finding) => [finding.location, ...columns.map((column) => String(finding.evidence?.[column]))].join(' ')));
    expect({ members: rows('ws-members', ['name']), conditions: rows('ws-conditions', ['code', 'seq']) }, `${label}: the workspace checks' rows`).toEqual(defect.answered);
  } else {
    const { code, path } = defect.refusal;
    expect(sorted(broken.map((finding) => finding.check ?? '')), `${label}: the checks the refusal breaks`).toEqual(['ws-conditions', 'ws-members']);
    for (const finding of broken) {
      expect(finding.message, `${label}: the refusal leads with its code`).toContain(`${code}: `);
      expect(finding.message, `${label}: the refusal names the file`).toContain(path);
    }
  }
  expectNoRowsFindings(label, findings, defect);
}

/** Exactly the defect's `DATA_FILE_NO_ROWS` findings, one per path. */
function expectNoRowsFindings(label: string, findings: readonly Finding[], defect: WorkspaceDefect): void {
  expect(sorted(findings.filter((finding) => finding.code === 'DATA_FILE_NO_ROWS').map((finding) => finding.location ?? '')), `${label}: DATA_FILE_NO_ROWS`)
    .toEqual(sorted(defect.noRows));
}

/**
 * What the defect's file answers over the data relations in one arm's dump.
 *
 * @param label - The run's label
 * @param run - The query run
 * @param defect - The defect
 */
function expectDataAnswers(label: string, run: RecordedRun, defect: WorkspaceDefect): void {
  const census = Object.fromEntries(['data__values', 'data__routes', 'data__conditions'].map((relation) => [relation, relationRows(run.document, relation)]));
  const { path, holds } = defect.values;
  expect(valuesAt(census, path), `${label}: data__values over ${path}`).toEqual(expect.arrayContaining([...holds]));
  if (defect.conditions === undefined) return;
  const route = recordsOf(census['data__routes'] ?? []).find((row) => row['path'] === path);
  const codes = recordsOf(census['data__conditions'] ?? []).filter((row) => row['blob'] === route?.['blob'] && row['variant'] === route?.['variant']).map((row) => row['code']);
  expect(codes, `${label}: data__conditions over ${path}`).toEqual(defect.conditions);
}

/**
 * A defect seed: the base plus one plant, committed. In every arm, `vat resources check` reports the
 * refusal (or the defective member's rows) and the run's `DATA_FILE_NO_ROWS` findings, and the dump
 * of every other relation answers over the defect's file; every arm alike.
 *
 * @param defect - The defect
 * @returns The seed
 */
function workspaceDefectSeed(defect: WorkspaceDefect): I0Seed {
  return {
    name: defect.name,
    needs: null,
    arms: EVERY_ARM,
    verbs: ['check', 'query'],
    stateA: (corpus, git) => {
      const paths = Object.keys(defect.plant);
      const written = Object.fromEntries(Object.entries(defect.plant).flatMap(([path, text]) => (text === null ? [] : [[path, text]])));
      writeCorpus(corpus, written);
      const removed = paths.filter((path) => defect.plant[path] === null);
      if (removed.length > 0) git(['rm', '-q', '--', ...removed]);
      git(['add', '-A']);
      git(['commit', '-q', '-m', `a workspace defect: ${defect.name}`]);
      return Promise.resolve();
    },
    expect: { agrees: { because: `the ${defect.name} defect reports alike in every arm`, storeDeclines: null } },
    consumed: {
      runs: EVERY_ARM.map((arm) => `${arm}:measured` as const),
      check: (runs) => {
        forEachCheckAndQuery(runs, (label, check, query) => {
          expectCheckReports(`${label} check`, check.document['findings'] as readonly Finding[], defect);
          expectNoRowsFindings(`${label} query`, query.document['findings'] as readonly Finding[], defect);
          expectDataAnswers(`${label} query`, query, defect);
        });
      },
    },
  };
}

/**
 * The defect seed named.
 *
 * @param name - The seed's name
 * @returns The seed
 */
export function workspaceDefectSeedNamed(name: string): I0Seed {
  const defect = WORKSPACE_DEFECTS.find((candidate) => candidate.name === name);
  if (defect === undefined) throw new Error(`no workspace defect ${name}`);
  return workspaceDefectSeed(defect);
}
