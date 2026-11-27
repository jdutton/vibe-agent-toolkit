/**
 * The `data` instance's system proofs, shared: one clean corpus of JSON and JSONC files (spec
 * 4.4 item 3) with a YAML corpus beside it, a counted `vat resources query` over it, and what the I0 differential runs over it
 * (`cache-differential.ts`): the clean census and one defect seed per byte-determined defect.
 *
 * Every number a proof asserts is read off this corpus: {@link CLEAN_ROUTED_PATHS} routed pairs,
 * all `facts`, and {@link CLEAN_NODES} node rows among them. A run that reads either back
 * differently is the regression, so each proof also asserts the corpus's own answer first.
 *
 * The differential's tree ({@link DATA_TREE}) is that corpus plus {@link YAML_DATA_FILES}, the
 * YAML a stream can hold (anchors and aliases, `<<`, streams, tags, non-string keys), routed by the
 * `**\/pnpm-workspace.yaml` default and by an `include` of `.yaml` and `.yml`. The counted proofs keep
 * the JSON corpus alone, so their counts are the JSON corpus's.
 */

import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_BLOB_TIER_BUDGET_BYTES, DEFAULT_ROW_SET_TIER_BUDGET_BYTES, openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import { evictRowSetForTest } from '@vibe-agent-toolkit/projection-sqlite/testing';
import { DEFAULT_PARSE_LIMITS, parseContentKey, quoteIdentifier, type RowSetId } from '@vibe-agent-toolkit/resources';
import { safePath, type WorkCounter, type WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, expect } from 'vitest';

import { executeCli } from '../system/test-common.js';
import { writeCorpus } from '../test-helpers.js';

import { dataPairCauseOf, type DataPairCause } from './absence-causes.js';
import { DUMPED_RELATIONS, relationRows, rowByContent, treeSeedSuite, type FixtureTree, type I0Seed, type RecordedRuns } from './cache-differential.js';
import { storeFilesUnder } from './projection-store-probe.js';
import { cliDumps, countedStoreEnv } from './work-counter-run.js';

// ── The clean corpus ────────────────────────────────────────────────────────

/** Markdown only, so every data route comes from the instance's defaults. */
export const DATA_CONFIG = 'resources:\n  include:\n    - "**/*.md"\n';

/** The byte-order mark, an accented letter and a NUL, built rather than typed (a typed escape becomes the raw byte). */
const BOM = String.fromCodePoint(0xfe_ff);
const E_ACUTE = String.fromCodePoint(0xe9);
const NUL = String.fromCodePoint(0);

/** Strict JSON a JSONC file can hold too: routed once per variant, two row sets of one content key. */
const SAME_BYTES = '{"same": [1, 2.5, "x", null, false]}\n';

/**
 * The clean corpus, config aside: every file `facts`. Node rows per file in a comment, summed in
 * {@link CLEAN_NODES}.
 */
const CLEAN_DATA_FILES: Readonly<Record<string, string | Buffer>> = {
  'README.md': '# Data corpus\n',
  // An `@`-import gives the claude-context lens a key of its own, so a cold dump's lens population
  // derives as the gate fixture's does rather than being served the extent its own population wrote.
  'CLAUDE.md': '# Memory\n\n@README.md\n',
  // Strict (`**/package.json`): "name" twice (one DATA_DUPLICATE_KEY, the first shadowed), 2^53+1
  // (one DATA_LOSSY_NUMBER), nesting to /a/0/b (depths 1 to 4). 8 nodes.
  'package.json': '{"name": "first", "version": "1.0.0", "name": "second", "big": 9007199254740993, "a": [{"b": 1}]}\n',
  // JSONC (`**/tsconfig*.json`): a comment and trailing commas, CRLF breaks. 3 nodes.
  'tsconfig.json': '{\r\n  // a comment\r\n  "compilerOptions": {"strict": true,},\r\n}\r\n',
  // The same bytes as json and as jsonc. 7 nodes each.
  'same/package.json': SAME_BYTES,
  'same/tsconfig.json': SAME_BYTES,
  // A UTF-8 BOM, and UTF-16LE with its BOM (text). 2 nodes each.
  'bom/package.json': `${BOM}{"bom": true}\n`,
  'utf16/package.json': Buffer.from(`${BOM}{"wide": "${E_ACUTE}"}\n`, 'utf16le'),
  // Lone CR breaks. 3 nodes.
  'cr/tsconfig.json': '{\r"lone": 1,\r"cr": 2\r}\r',
  // A scalar root (maxDepth 0). 1 node.
  'scalar/package.json': '42\n',
};

/** Sorted paths. */
const sortedPaths = (paths: readonly string[]): string[] => paths.toSorted((left, right) => left.localeCompare(right));

/** The routed paths, sorted: every `.json` file of the corpus, each by a default route. */
const CLEAN_ROUTED_PATHS: readonly string[] = sortedPaths(Object.keys(CLEAN_DATA_FILES).filter((path) => path.endsWith('.json')));

/** The routed pairs: one row set per routed path (the two same-bytes files differ by variant). */
export const ROUTED_PAIRS = CLEAN_ROUTED_PATHS.length;

/** Every node row of the corpus: 8 + 3 + 7 + 7 + 2 + 2 + 3 + 1. */
export const CLEAN_NODES = 33;

/** The path a one-file edit rewrites, and its bytes after: 4 nodes in place of 8. */
export const EDITED_PATH = 'package.json';
// It keeps a DATA_LOSSY_NUMBER, so `data__conditions` still holds a row after the edit.
export const EDITED_BYTES = '{"name": "edited", "big": 9007199254740993, "private": true}\n';
export const EDITED_NODES = 4;

/**
 * Write the clean corpus at `root` with a config.
 *
 * @param root - The corpus root
 * @param config - The config's text
 */
export function writeCleanCorpus(root: string, config: string): void {
  writeCorpus(root, { ...CLEAN_DATA_FILES, 'vibe-agent-toolkit.config.yaml': config });
}

// ── The YAML corpus ─────────────────────────────────────────────────────────

/** Ten of `item`, as a flow sequence's entries. */
const tenOf = (item: string): string => Array.from({ length: 10 }, () => item).join(', ');

/**
 * The YAML corpus, routed beside the JSON one in {@link DATA_TREE}: every file `facts`. What each
 * holds that the census reads back is in {@link YAML_CORPUS_ANSWERS}.
 */
const YAML_DATA_FILES: Readonly<Record<string, string>> = {
  // The default route (`**/pnpm-workspace.yaml`): no config names it.
  'pnpm-workspace.yaml': "packages:\n  - packages/*\n  - '!**/test/**'\n",
  // Anchors and aliases: an alias of a map, an alias nested two levels down, `<<` stored literally
  // (never merged), and an alias inside an anchored node copied again (a copy inside a copy).
  'yaml/anchors.yaml': [
    'base: &base',
    '  name: shared',
    '  tags: &tags [a, b]',
    'copy: *base',
    'nested:',
    '  inner:',
    '    list: *tags',
    'merged:',
    '  <<: *base',
    '  extra: 1',
    'outer: &outer',
    '  list: *tags',
    'again: *outer',
    '',
  ].join('\n'),
  // A stream of two documents, the second ended by `...`; `.yml` by the include.
  'yaml/stream.yml': '---\nfirst: 1\n---\n- second\n...\n',
  // An empty stream: a head row of no documents.
  'yaml/empty.yaml': '# no documents\n',
  // `---` alone: one document whose root is null.
  'yaml/bare.yaml': '---\n',
  // Non-string keys (a number, null, a collection) and a repeated key.
  'yaml/keys.yaml': '1: one\nnull: nothing\n? [a, b]\n: collection\nname: first\nname: second\n',
  // An explicit core tag and a custom one.
  'yaml/tags.yaml': 'str: !!str 1\ncustom: !foo bar\n',
  // The YAML 1.1 tags, none resolved: each node read as written, its tag kept.
  'yaml/tags11.yaml': 'bin: !!binary aGVsbG8=\nts: !!timestamp 2001-12-14\nomap: !!omap [a: 1]\npairs: !!pairs [a: 1, a: 2]\nset: !!set {x, y}\n',
  // Non-finite numbers (each DATA_LOSSY_NUMBER) and a hex integer.
  'yaml/numbers.yaml': 'inf: .inf\nnan: .nan\nneg: -.inf\nhex: 0x1F\n',
  // CRLF breaks, and lone CR breaks.
  'yaml/crlf.yaml': 'a: 1\r\nb: [2, 3]\r\n',
  'yaml/cr.yaml': 'a: 1\rb: 2\r',
  // An explicit `%YAML 1.2`: the one version read.
  'yaml/version.yaml': '%YAML 1.2\n---\nv: 1.2\n',
};

/**
 * A data `include` block, as config lines under `resources:`.
 *
 * @param globs - The globs
 * @returns The lines, ending in a newline
 */
export function dataIncludeConfig(globs: readonly string[]): string {
  return ['  extractors:', '    data:', '      include:', ...globs.map((glob) => `        - "${glob}"`), ''].join('\n');
}

/** The YAML corpus's routed paths, sorted. */
const YAML_ROUTED_PATHS: readonly string[] = sortedPaths(Object.keys(YAML_DATA_FILES));

/** The tree's routed paths, sorted: the JSON corpus's and the YAML corpus's. */
const TREE_ROUTED_PATHS: readonly string[] = sortedPaths([...CLEAN_ROUTED_PATHS, ...YAML_ROUTED_PATHS]);

/** The routed pairs of {@link DATA_TREE}: one row set per routed path. */
export const TREE_PAIRS = TREE_ROUTED_PATHS.length;

/**
 * What the YAML corpus answers, read off its files above, so a census that compared arms holding
 * none of it cannot pass. Only `yaml` rows are counted, so a seed that edits a JSON file leaves
 * these answers as they are.
 */
const YAML_CORPUS_ANSWERS = {
  // Each head row's documents: the stream's 2, the empty stream's 0, every other file's 1.
  documents: { 0: 1, 1: YAML_ROUTED_PATHS.length - 2, 2: 1 },
  // copy (5), nested list (3), merged `<<` (5), outer list (3), again (4): 20 rows copy another.
  aliasRows: 20,
  tags: ['!foo', ...['binary', 'omap', 'pairs', 'set', 'str', 'timestamp'].map((name) => `tag:yaml.org,2002:${name}`)],
  // One repeated key, three non-finite numbers, three non-string keys.
  conditions: { DATA_DUPLICATE_KEY: 1, DATA_LOSSY_NUMBER: 3, DATA_NON_STRING_KEY: 3 },
  // `<<` is a key, never a merge.
  literalMergeKey: '/merged/<<',
} as const;

/**
 * A tally of one column over a relation's rows.
 *
 * @param rows - The rows, parsed
 * @param column - The column
 * @returns Value to count, values as text
 */
function tallyOf(rows: ReadonlyArray<Record<string, unknown>>, column: string): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[column]);
    tally[value] = (tally[value] ?? 0) + 1;
  }
  return tally;
}

/**
 * The YAML corpus's own answer, asserted on one census's `yaml` rows: the paths routed `yaml`, the head
 * rows' documents, the alias copies, the tags, the conditions, and `<<` stored as a key.
 *
 * @param census - The census's rows per relation
 */
function expectYamlCorpusAnswers(census: Record<string, readonly string[]>): void {
  const of = (relation: string): readonly string[] => census[relation] ?? [];
  const records = (relation: string): Array<Record<string, unknown>> => of(relation)
    .map((row) => JSON.parse(row) as Record<string, unknown>)
    .filter((record) => record['variant'] === 'yaml');
  const yamlRoutes = records('data__routes').map((route) => String(route['path']));
  expect(sortedPaths(yamlRoutes), 'the paths routed yaml').toEqual(YAML_ROUTED_PATHS);
  expect(tallyOf(records('data__files'), 'documents'), 'head rows by documents').toEqual(YAML_CORPUS_ANSWERS.documents);
  const nodes = records('data__nodes');
  expect(nodes.filter((node) => node['aliasOf'] !== null), 'rows an alias copied').toHaveLength(YAML_CORPUS_ANSWERS.aliasRows);
  expect(sortedPaths(nodes.flatMap((node) => (node['tag'] === null ? [] : [node['tag'] as string]))), 'tagged nodes').toEqual(YAML_CORPUS_ANSWERS.tags);
  expect(nodes.filter((node) => node['pointer'] === YAML_CORPUS_ANSWERS.literalMergeKey), '`<<` stored as a key').toHaveLength(1);
  expect(tallyOf(records('data__conditions'), 'code'), 'conditions by code').toEqual(YAML_CORPUS_ANSWERS.conditions);
}

// ── Statements ──────────────────────────────────────────────────────────────

/** Names `data__nodes` only: the coverage read's head rows, then a copy of the nodes. */
export const NODES_SQL = 'SELECT blob, variant, doc, ordinal, pointer, value FROM data__nodes ORDER BY blob, variant, doc, ordinal';

/** Names `data__values` only: the coverage read's head rows, then an extending read of the nodes. */
export const VALUES_SQL = 'SELECT path, variant, pointer, type, value FROM data__values ORDER BY path, variant, pointer';

/** Names `data__files` only. */
export const FILES_SQL = 'SELECT blob, variant, nodeCount FROM data__files ORDER BY blob, variant';

/** Names no data relation. */
export const NO_DATA_SQL = 'SELECT path FROM resource_realizations ORDER BY path';

// ── A counted query ─────────────────────────────────────────────────────────

/** What a run needs of its suite. */
interface DataSuite {
  readonly binPath: string;
  readonly createTempDir: () => string;
}

/** Where one arm keeps its caches. */
export interface DataArm {
  readonly cacheDir: string;
  readonly tmpDir: string;
  readonly storeOff: boolean;
}

/** One counted `vat resources query`, read back. */
export interface CountedQuery {
  readonly status: number | null;
  readonly stderr: string;
  readonly document: Record<string, unknown>;
  /** The one CLI process's counters. */
  readonly counters: Readonly<Record<WorkCounter, number>>;
}

/**
 * A fresh arm: nothing cached anywhere it can reach.
 *
 * @param suite - The suite
 * @param storeOff - Whether its store is off
 * @returns The arm
 */
export function freshDataArm(suite: DataSuite, storeOff: boolean): DataArm {
  return { cacheDir: suite.createTempDir(), tmpDir: suite.createTempDir(), storeOff };
}

/**
 * Run `vat resources query --format json <sql>` in `cwd` with its work counters on.
 *
 * @param suite - The suite
 * @param cwd - The project root
 * @param arm - Its caches
 * @param sql - The statement
 * @param env - Extra variables (a test seam)
 * @returns The run
 */
export async function countedQuery(suite: DataSuite, cwd: string, arm: DataArm, sql: string, env: Readonly<Record<string, string>> = {}): Promise<CountedQuery> {
  const work = suite.createTempDir();
  const tmp = arm.tmpDir;
  const result = await executeCli(suite.binPath, ['resources', 'query', '--format', 'json', sql], {
    cwd,
    env: { ...countedStoreEnv({ cacheDir: arm.cacheDir, storeOff: arm.storeOff }, work), TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env },
  });
  const dumps = cliDumps<WorkCounterDump>(work);
  const [dump, ...others] = dumps;
  if (dump === undefined || others.length > 0) throw new Error(`expected one CLI process, got ${String(dumps.length)}: ${result.stderr}`);
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`stdout is not a query document (exit ${String(result.status)}): ${result.stderr}`);
  }
  return { status: result.status, stderr: result.stderr, document, counters: dump.counters };
}

/**
 * The rows a query answered, after asserting it answered.
 *
 * @param run - The run
 * @returns Its rows
 */
export function answeredRows(run: CountedQuery): readonly Record<string, unknown>[] {
  expect(run.status, `${JSON.stringify(run.document['error'] ?? null)}\n${run.stderr}`).toBe(0);
  return (run.document['data'] as { rows: Record<string, unknown>[] }).rows;
}

/** The row-set counters, and the hydration and store counters each proof holds beside them. */
export const DATA_RUN_COUNTERS = [
  'rowSet.extracted',
  'rowSet.storeServed',
  'rowSet.refused',
  'rowSet.rows.decoded',
  'hydration.rows.copied',
  'hydration.rows.written',
  'store.rows.decoded.repeated',
] as const satisfies readonly WorkCounter[];

/** The row-set counters alone: zero in a run that names no row-set relation. */
export const ROW_SET_COUNTERS = ['rowSet.extracted', 'rowSet.storeServed', 'rowSet.refused', 'rowSet.rows.decoded'] as const satisfies readonly WorkCounter[];

/**
 * The named counters of a counter record.
 *
 * @param counters - A process's counters
 * @param names - The counters to read
 * @returns Each one's count
 */
export function countersOf<Name extends WorkCounter>(counters: Readonly<Record<WorkCounter, number>>, names: readonly Name[]): Record<Name, number> {
  return Object.fromEntries(names.map((name) => [name, counters[name]])) as Record<Name, number>;
}

// ── The store, by hand ──────────────────────────────────────────────────────

/**
 * The one projection store under a cache directory.
 *
 * @param cacheDir - The arm's cache root
 * @returns The store file
 */
function storeFileUnder(cacheDir: string): string {
  const [file, ...others] = storeFilesUnder(cacheDir);
  if (file === undefined || others.length > 0) throw new Error(`expected one projection store under ${cacheDir}`);
  return file;
}

/**
 * Every row set the store holds of the `data` instance, by its head rows, sorted.
 *
 * @param cacheDir - The arm's cache root
 * @returns The ids
 */
export function storedDataRowSets(cacheDir: string): RowSetId[] {
  const database = new DatabaseSync(storeFileUnder(cacheDir));
  try {
    const rows = database.prepare(`SELECT "blob", "variant" FROM ${quoteIdentifier('data__files')} ORDER BY "blob", "variant"`).all() as unknown as Array<{ blob: string; variant: string }>;
    return rows.map((row) => {
      const contentKey = parseContentKey(row.blob);
      if (contentKey === undefined) throw new Error(`not a content key: ${row.blob}`);
      return { contentKey, instance: 'data', variant: row.variant } as RowSetId;
    });
  } finally {
    database.close();
  }
}

/**
 * Evict row sets from the arm's store as the row-set budget would, through the backend's own seam.
 *
 * @param cacheDir - The arm's cache root
 * @param ids - The row sets
 */
async function evictRowSets(cacheDir: string, ids: readonly RowSetId[]): Promise<void> {
  const store = openSqliteFactStore({
    directory: safePath.join(storeFileUnder(cacheDir), '..'),
    blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES,
    rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES,
  });
  try {
    for (const id of ids) evictRowSetForTest(store, id);
  } finally {
    await store.close();
  }
}

/** The value a planted `data__nodes` row carries, which no file of the corpus holds. */
export const PLANTED_VALUE = 'planted by hand';

/**
 * Rewrite one stored `data__nodes` row's value in place: the `/version` string of the root
 * `package.json`'s row set, the one node whose value is `1.0.0`.
 *
 * @param cacheDir - The arm's cache root
 */
export function plantWrongNode(cacheDir: string): void {
  const database = new DatabaseSync(storeFileUnder(cacheDir));
  try {
    const nodes = quoteIdentifier('data__nodes');
    const changed = database.prepare(`UPDATE ${nodes} SET "value" = ? WHERE "pointer" = '/version' AND "value" = '1.0.0'`).run(PLANTED_VALUE).changes;
    expect(changed, 'the planted data__nodes row').toBe(1);
  } finally {
    database.close();
  }
}

// ── The I0 data census ──────────────────────────────────────────────────────

/** The value the root `package.json`'s `/name` holds: the second of its two `name` keys. */
const PACKAGE_NAME = 'second';

/**
 * A config with three checks: the routes that hold no rows, one statement naming `data__nodes`
 * that selects nothing, and one reading the root `package.json`'s rows, whose one finding a defect
 * elsewhere must not cost.
 */
const DATA_CHECKS_CONFIG = [
  'resources:',
  '  include:',
  '    - "**/*.md"',
  '  checks:',
  '    data-routes:',
  '      description: Every routed data file that holds no rows',
  "      sql: \"SELECT path, state, code FROM data__routes WHERE state <> 'facts' ORDER BY path\"",
  '      severity: warning',
  '    data-nodes:',
  '      description: Never a row, over every routed data file that holds rows',
  '      sql: "SELECT count(*) AS n FROM data__nodes HAVING count(*) < 0"',
  '      severity: warning',
  '    data-package-name:',
  '      description: The root package.json name, read from its rows',
  "      sql: \"SELECT path, value AS name FROM data__values WHERE path = 'package.json' AND pointer = '/name'\"",
  '      severity: warning',
  dataIncludeConfig(['yaml/*.yaml', 'yaml/*.yml']),
].join('\n');

/** The clean corpus, the YAML corpus and their checks, committed. */
export const DATA_TREE: FixtureTree = {
  committed: (corpus) => writeCorpus(corpus, { ...CLEAN_DATA_FILES, ...YAML_DATA_FILES, 'vibe-agent-toolkit.config.yaml': DATA_CHECKS_CONFIG }),
  untracked: () => undefined,
};

/** Every `data__*` relation a statement can name, stored and derived. */
export const DATA_RELATIONS: readonly string[] = DUMPED_RELATIONS.map((relation) => relation.name).filter((name) => name.startsWith('data__'));

/** A recorded run, as a seed's consumed check receives it. */
export type RecordedRun = NonNullable<NonNullable<RecordedRuns[keyof RecordedRuns]>['query']>;

/**
 * The one CLI process's counters of a recorded run.
 *
 * @param run - A recorded run
 * @returns Its counters
 */
export function recordedCounters(run: RecordedRun): Readonly<Record<WorkCounter, number>> {
  const [dump, ...others] = run.work;
  if (dump === undefined || others.length > 0) throw new Error(`${run.label} ${run.verb}: expected one CLI process`);
  return dump.counters;
}

/**
 * Every measured dump of a seed's runs, by label.
 *
 * @param runs - The consumed runs
 * @returns Label to dump run
 */
function measuredDumps(runs: RecordedRuns): Array<[string, RecordedRun]> {
  return Object.entries(runs).flatMap(([label, byVerb]) => (label.endsWith(':measured') && byVerb?.query !== undefined ? [[label, byVerb.query] as [string, RecordedRun]] : []));
}

/** A route row as the census reads it. */
interface CensusRoute {
  readonly path: string;
  readonly state: string;
  readonly code: string | null;
}

/**
 * The data census, judged before any comparison: every measured dump holds rows for every
 * `data__*` relation, its routes are exactly the routed paths and all `facts` but the one defect's
 * (when a defect is planted), whose route names its cause, and every arm's rows of every data
 * relation equal store-off's. A dump with no row of a relation is a lost relation, and comparing
 * two of them would agree on nothing. With a defect planted, the census over the healthy files is
 * the clean corpus's: the defect's route row is the only row that names it.
 *
 * @param runs - The consumed runs; must hold `storeOff:measured`
 * @param defect - The one defective file planted, or undefined for the clean corpus
 * @returns The rows per relation of the store-off dump, the defect's route aside, for the caller to assert on
 */
function expectDataCensus(runs: RecordedRuns, defect: DataDefect | undefined): Record<string, readonly string[]> {
  // Every row naming the defect's path, kept apart so the rest is the clean corpus's census.
  const isDefect = (row: string): boolean => defect !== undefined && (JSON.parse(row) as { path?: unknown }).path === defect.path;
  const healthyRows = (run: RecordedRun, relation: string): readonly string[] => relationRows(run.document, relation).filter((row) => !isDefect(row));
  const census = expectArmsCensus(runs, DATA_RELATIONS, healthyRows, (label, run) => {
    const routes = healthyRows(run, 'data__routes').map((row) => JSON.parse(row) as CensusRoute);
    expect(sortedPaths(routes.map((route) => route.path)), `${label}: routed paths`).toEqual(TREE_ROUTED_PATHS);
    expect(routes.filter((route) => route.state !== 'facts').map((route) => dataPairCauseOf(route)), `${label}: routes holding no rows`).toEqual([]);
    const named = DATA_RELATIONS.flatMap((relation) => relationRows(run.document, relation).filter((row) => isDefect(row)).map((row) => [relation, row] as const));
    expect(named.map(([relation, row]) => (relation === 'data__routes' ? dataPairCauseOf(JSON.parse(row) as CensusRoute) : relation)), `${label}: the rows naming the defect`)
      .toEqual(defect === undefined ? [] : [defect.cause]);
  });
  expectYamlCorpusAnswers(census);
  return census;
}

/**
 * The census every instance's I0 shares, judged before any comparison: every measured dump holds
 * rows for every relation named (a dump with no row of a relation is a lost relation, and comparing
 * two of them would agree on nothing), then `each` judges it, and every arm's rows of every relation
 * equal store-off's.
 *
 * @param runs - The consumed runs; must hold `storeOff:measured`
 * @param relations - The relations the census covers
 * @param rowsOf - A dump's rows of one relation, as the census counts them
 * @param each - What the caller asserts of each dump, after its rows are found
 * @returns The rows per relation of the store-off dump, for the caller to assert on
 */
export function expectArmsCensus(
  runs: RecordedRuns,
  relations: readonly string[],
  rowsOf: (run: RecordedRun, relation: string) => readonly string[] = (run, relation) => relationRows(run.document, relation),
  each: (label: string, run: RecordedRun) => void = () => undefined,
): Record<string, readonly string[]> {
  const dumps = measuredDumps(runs);
  expect(dumps.map(([label]) => label), 'the census needs the store-off reference').toContain('storeOff:measured');
  expect(dumps.length, 'the census compares at least two arms').toBeGreaterThan(1);
  for (const [label, run] of dumps) {
    expect(relations.filter((relation) => rowsOf(run, relation).length === 0), `${label}: relations with no row`).toEqual([]);
    each(label, run);
  }
  const reference = (dumps.find(([label]) => label === 'storeOff:measured') as [string, RecordedRun])[1];
  // Content identity is per source: a store-on arm keys each git member by its object id, store-off
  // by its disk checksum. So every arm's rows are compared as store-off names them (`rowByContent`).
  const byContent = (run: RecordedRun): Record<string, readonly string[]> => Object.fromEntries(relations.map((relation) => [
    relation,
    rowsOf(run, relation)
      .map((row) => rowByContent(run, row))
      .toSorted((left, right) => left.localeCompare(right)),
  ]));
  const expected = byContent(reference);
  for (const [label, run] of dumps) {
    expect(byContent(run), `${label}: the census`).toEqual(expected);
  }
  return Object.fromEntries(relations.map((relation) => [relation, rowsOf(reference, relation)]));
}

/**
 * The clean census ({@link expectDataCensus} with no defect planted).
 *
 * @param runs - The consumed runs; must hold `storeOff:measured`
 * @returns The rows per relation of the store-off dump, for the caller to assert on
 */
export function expectCleanDataCensus(runs: RecordedRuns): Record<string, readonly string[]> {
  return expectDataCensus(runs, undefined);
}

// ── Defect seeds ────────────────────────────────────────────────────────────

/** One defective file planted into the clean corpus, and the one finding it must produce. */
interface DataDefect {
  readonly name: string;
  readonly path: string;
  readonly bytes: () => string;
  readonly cause: DataPairCause;
}

/** Where every JSON defect lands: a strict JSON route. */
const DEFECT_PATH = 'bad/package.json';

/** Where every YAML defect lands: the YAML default route. */
const YAML_DEFECT_PATH = 'bad/pnpm-workspace.yaml';

/**
 * A byte bomb: a 100,000-character anchored string aliased 6,000 times, 600 MB of rows from a
 * 142 KB file, which only the walk's byte floor stops short of stringifying.
 *
 * @returns The bytes
 */
function byteBomb(): string {
  return `a: &a ${'x'.repeat(100_000)}\nb:\n${'  - *a\n'.repeat(6000)}`;
}

/**
 * An alias bomb: each anchored sequence holds ten aliases of the one before, so the last expands to
 * 10^levels rows from a few hundred bytes. `levels` is the cap's digit count, so the expansion passes
 * `outputRows` whatever it is (10^digits exceeds any number of that many digits).
 *
 * @returns The bytes
 */
function aliasBomb(): string {
  const levels = Array.from({ length: String(DEFAULT_PARSE_LIMITS.outputRows).length }, (_unused, index) => `l${String(index)}`);
  return levels.map((name, index) => {
    const item = index === 0 ? 'x' : '*' + (levels[index - 1] ?? '');
    return `${name}: &${name} [${tenOf(item)}]\n`;
  }).join('');
}

/**
 * One defect per byte-determined defect a corpus can plant. The caps are the defaults
 * (`DEFAULT_PARSE_LIMITS`), which no config or variable moves, so each file is built one past its
 * own default. Built on demand: the two cap files are megabytes.
 */
export const DATA_DEFECTS: readonly DataDefect[] = [
  { name: 'nulByte', path: DEFECT_PATH, bytes: () => `{"a": "x${NUL}y"}\n`, cause: 'defective:BLOB_NOT_TEXT' },
  { name: 'malformed', path: DEFECT_PATH, bytes: () => '{"a": }\n', cause: 'defective:DATA_PARSE_ERROR' },
  { name: 'commentInStrict', path: DEFECT_PATH, bytes: () => '{\n  // no comments in strict JSON\n  "a": 1\n}\n', cause: 'defective:DATA_PARSE_ERROR' },
  { name: 'mismatchedCloser', path: DEFECT_PATH, bytes: () => `${'[},'.repeat(100_000)}\n`, cause: 'defective:DATA_PARSE_ERROR' },
  { name: 'loneSurrogateKeys', path: DEFECT_PATH, bytes: () => String.raw`{"name": "a", "\uD800": 1, "\uD801": 2}` + '\n', cause: 'defective:DATA_LONE_SURROGATE' },
  { name: 'pastInputBytes', path: DEFECT_PATH, bytes: () => `["${'a'.repeat(DEFAULT_PARSE_LIMITS.inputBytes)}"]\n`, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
  { name: 'pastOutputRows', path: DEFECT_PATH, bytes: () => `[${Array.from({ length: DEFAULT_PARSE_LIMITS.outputRows + 1 }, () => '0').join(',')}]\n`, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
  { name: 'pastOutputDepth', path: DEFECT_PATH, bytes: () => `${'['.repeat(DEFAULT_PARSE_LIMITS.outputDepth + 1)}${']'.repeat(DEFAULT_PARSE_LIMITS.outputDepth + 1)}\n`, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
  { name: 'pastOutputBytes', path: DEFECT_PATH, bytes: () => `["${'a'.repeat(DEFAULT_PARSE_LIMITS.outputBytes)}"]\n`, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
  { name: 'yamlVersion11', path: YAML_DEFECT_PATH, bytes: () => '%YAML 1.1\n---\na: 1\n', cause: 'defective:DATA_YAML_VERSION' },
  { name: 'yamlMalformed', path: YAML_DEFECT_PATH, bytes: () => 'a: [1, 2\nb: 3\n', cause: 'defective:DATA_PARSE_ERROR' },
  { name: 'yamlUnresolvedAlias', path: YAML_DEFECT_PATH, bytes: () => 'a: *missing\n', cause: 'defective:DATA_PARSE_ERROR' },
  { name: 'yamlAliasBomb', path: YAML_DEFECT_PATH, bytes: aliasBomb, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
  { name: 'yamlByteBomb', path: YAML_DEFECT_PATH, bytes: byteBomb, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
];

/** The arms every defect seed runs: each must report it alike. */
export const EVERY_ARM = ['storeOff', 'cold', 'warmSameHistory', 'partialEviction'] as const;

/** A finding, the fields the defect judgment reads. */
interface DefectFinding {
  readonly code: string;
  readonly severity: string;
  readonly check?: string;
  readonly location?: string;
  readonly evidence?: { readonly state?: string; readonly code?: string; readonly name?: string };
  readonly message: string;
  readonly fix?: string;
}

/**
 * The defect's one `DATA_FILE_NO_ROWS` error, in a run's findings: at its path, naming its state
 * and code, its remedy the fix. Nothing else is refused or broken.
 *
 * @param label - The run's label
 * @param findings - The run's findings
 * @param defect - The defect
 */
function expectOneDefectFinding(label: string, findings: readonly DefectFinding[], defect: DataDefect): void {
  const [state, code] = defect.cause.split(':');
  const noRows = findings.filter((finding) => finding.code === 'DATA_FILE_NO_ROWS');
  expect(noRows.map((finding) => ({ location: finding.location, severity: finding.severity })), `${label}: the defect's own finding`)
    .toEqual([{ location: defect.path, severity: 'error' }]);
  expect(noRows[0]?.message, `${label}: the finding names the pair`).toContain(`${state ?? ''} ${code ?? ''}`);
  expect(noRows[0]?.fix, `${label}: the finding carries the pair's remedy`).toMatch(/exclude/u);
  expect(findings.filter((finding) => finding.code === 'RESOURCE_CHECK_BROKEN'), `${label}: broken checks`).toEqual([]);
}

/**
 * The defect on one measured check run: its one finding; the routes check names the path with its
 * state and code, which classify as the defect's cause; and the check over the root `package.json`'s
 * rows still reports its one finding.
 *
 * @param label - The run's label
 * @param run - A measured `vat resources check` run
 * @param defect - The defect
 */
function expectCheckReportsDefect(label: string, run: RecordedRun, defect: DataDefect): void {
  const findings = run.document['findings'] as readonly DefectFinding[];
  expectOneDefectFinding(label, findings, defect);
  const routes = findings.filter((finding) => finding.code === 'CUSTOM:data-routes');
  expect(routes.map((finding) => ({ path: finding.location, state: finding.evidence?.state, code: finding.evidence?.code })), `${label}: routes holding no rows`)
    .toEqual([{ path: defect.path, state: defect.cause.split(':')[0], code: defect.cause.split(':')[1] }]);
  const [route] = routes;
  expect(dataPairCauseOf({ state: route?.evidence?.state ?? '', code: route?.evidence?.code ?? null }), `${label}: the registered cause`).toBe(defect.cause);
  const named = findings.filter((finding) => finding.code === 'CUSTOM:data-package-name');
  expect(named.map((finding) => ({ location: finding.location, name: finding.evidence?.name })), `${label}: the package.json check's own finding`)
    .toEqual([{ location: 'package.json', name: PACKAGE_NAME }]);
}

/**
 * A defect seed: the clean corpus plus one defective file, committed. In every arm `vat resources
 * check` reports the defect's one finding and every check's own, and `vat resources query`'s dump
 * reports the same finding beside a census over the healthy files that is the clean corpus's.
 *
 * Reds, each seeded once and reverted: `dataDefectIssues` returning no finding, so the defect is only a
 * route row: `pastInputBytes` failed on store-off, "the defect's own finding", 1 failure. Before the
 * one-finding ruling, against the refusal judgment it replaced: the malformed seed's bytes made valid
 * (`{"a": 1}`), so nothing was defective; `yamlVersion11` naming `%YAML 1.2`; and `yamlAliasBomb` built
 * at one level (ten rows): each failed on store-off, "routes holding no rows", 1 failure. `yamlByteBomb`
 * run against an extractor with no byte floor in its walk: the whole run failed on
 * `RangeError: Invalid string length` (the row set's JSON, stringified to measure it), so no arm
 * answered, 1 failure.
 *
 * @param defect - The defect
 * @returns The seed
 */
function dataDefectSeed(defect: DataDefect): I0Seed {
  return {
    name: defect.name,
    needs: null,
    arms: EVERY_ARM,
    verbs: ['check', 'query'],
    stateA: (corpus, git) => {
      writeCorpus(corpus, { [defect.path]: defect.bytes() });
      git(['add', '--', defect.path]);
      git(['commit', '-q', '-m', `a defective data file: ${defect.name}`]);
      return Promise.resolve();
    },
    expect: { agrees: { because: `the ${defect.name} file is one finding alike in every arm, and every other file answers`, storeDeclines: null } },
    consumed: {
      runs: EVERY_ARM.map((arm) => `${arm}:measured` as const),
      check: (runs) => {
        forEachCheckAndQuery(runs, (label, check, query) => {
          expectCheckReportsDefect(label, check, defect);
          expectOneDefectFinding(`${label} query`, query.document['findings'] as readonly DefectFinding[], defect);
        });
        expectDataCensus(runs, defect);
      },
    },
  };
}

/**
 * The defect seeds named, in {@link DATA_DEFECTS} order.
 *
 * @param names - The seeds' names
 * @returns The seeds
 */
function dataDefectSeeds(names: readonly string[]): I0Seed[] {
  const seeds = DATA_DEFECTS.filter((defect) => names.includes(defect.name)).map((defect) => dataDefectSeed(defect));
  expect(seeds.map((seed) => seed.name), 'every named defect exists').toEqual(names);
  return seeds;
}

/**
 * A system file's defect runner over {@link DATA_TREE}: registers the suite's setup and cleanup, and
 * returns what runs one named defect seed and answers the arms it ran, each of which reported its
 * one defect alike ({@link EVERY_ARM}, or the run throws naming the arm that did not). The
 * seeds are split across files by the caps' cost, so each file stays inside its budget.
 *
 * @param testFileUrl - The calling file's `import.meta.url`
 * @returns Run one defect seed by name, answering the arms it ran
 */
export function dataDefectRunner(testFileUrl: string): (name: string) => Promise<readonly string[]> {
  const suite = treeSeedSuite(DATA_TREE, testFileUrl);
  beforeAll(suite.setup);
  afterAll(suite.cleanup);
  return (name) => {
    const [seed] = dataDefectSeeds([name]);
    if (seed === undefined) throw new Error(`no defect seed ${name}`);
    return suite.run(seed);
  };
}

/**
 * Each measured arm's `vat resources check` and `vat resources query` runs, for a defect seed's
 * judgment of every arm.
 *
 * @param runs - The consumed runs
 * @param each - What is asserted of one arm's two runs
 */
export function forEachCheckAndQuery(runs: RecordedRuns, each: (label: string, check: RecordedRun, query: RecordedRun) => void): void {
  for (const [label, byVerb] of Object.entries(runs)) {
    const check = byVerb?.check;
    const query = byVerb?.query;
    if (check === undefined || query === undefined) throw new Error(`${label}: no check or query run`);
    each(label, check, query);
  }
}

// ── Warm seeds ──────────────────────────────────────────────────────────────

/** The arms a seed over the warm store runs: store-off, the reference, and warm. */
export const WARM_ARMS = ['storeOff', 'warmSameHistory'] as const;

/** A warm seed's consumed runs: each arm's measured run. */
export const WARM_MEASURED = WARM_ARMS.map((arm) => `${arm}:measured` as const);

/**
 * The warm measured dump's row-set extractions and servings.
 *
 * @param runs - The seed's consumed runs
 * @returns What the warm run extracted and was served, and its cell
 */
export function warmRowSetSpend(runs: RecordedRuns): { extracted: number; served: number; cell: string } {
  const run = runs['warmSameHistory:measured']?.query;
  if (run === undefined) throw new Error('no warm dump');
  const counters = recordedCounters(run);
  return { extracted: counters['rowSet.extracted'], served: counters['rowSet.storeServed'], cell: run.cell.dirs.root };
}

/** Each row-set eviction cell's evicted count, from its plant to its check. */
const evictedRowSets = new Map<string, number>();

/**
 * Every other stored row set evicted after the warm prime, as the row-set budget would: the warm
 * run re-extracts exactly those row sets, is served the rest, and its census holds.
 *
 * @param name - The seed's name
 * @param pairs - The corpus's routed pairs, every one stored by the prime
 * @param census - The corpus's census over the consumed runs
 * @returns The seed
 */
export function rowSetEvictionSeed(name: string, pairs: number, census: (runs: RecordedRuns) => void): I0Seed {
  return {
    name,
    needs: null,
    arms: WARM_ARMS,
    verbs: ['query'],
    toB: async (arm, dirs) => {
      if (arm !== 'warmSameHistory') return;
      const stored = storedDataRowSets(dirs.store);
      expect(stored, 'the prime stored every pair').toHaveLength(pairs);
      const evicted = stored.filter((_id, index) => index % 2 === 0);
      await evictRowSets(dirs.store, evicted);
      expect(storedDataRowSets(dirs.store), 'the row sets the eviction left').toHaveLength(pairs - evicted.length);
      evictedRowSets.set(dirs.root, evicted.length);
    },
    expect: { agrees: { because: 'the warm run re-extracts exactly the evicted row sets', storeDeclines: null } },
    consumed: {
      runs: WARM_MEASURED,
      check: (runs) => {
        census(runs);
        const { extracted, served, cell } = warmRowSetSpend(runs);
        const evicted = evictedRowSets.get(cell) ?? 0;
        expect(evicted, 'row sets evicted').toBeGreaterThan(0);
        expect({ extracted, served }).toEqual({ extracted: evicted, served: pairs - evicted });
      },
    },
  };
}
