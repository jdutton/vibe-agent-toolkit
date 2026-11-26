/**
 * The `data` instance's system proofs, shared: one clean corpus of JSON and JSONC files (spec
 * 4.4 item 3), a counted `vat resources query` over it, and what the I0 differential runs over it
 * (`cache-differential.ts`): the clean census and one defect seed per byte-determined refusal.
 *
 * Every number a proof asserts is read off this corpus: {@link CLEAN_ROUTED_PATHS} routed pairs,
 * all `facts`, and {@link CLEAN_NODES} node rows among them. A run that reads either back
 * differently is the regression, so each proof also asserts the corpus's own answer first.
 */

import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_BLOB_TIER_BUDGET_BYTES, DEFAULT_ROW_SET_TIER_BUDGET_BYTES, evictRowSetForTest, openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import { DEFAULT_PARSE_LIMITS, parseContentKey, quoteIdentifier, type RowSetId } from '@vibe-agent-toolkit/resources';
import { safePath, type WorkCounter, type WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, expect } from 'vitest';

import { executeCli } from '../system/test-common.js';
import { writeCorpus } from '../test-helpers.js';

import { dataPairCauseOf, type DataPairCause } from './absence-causes.js';
import { DUMPED_RELATIONS, relationRows, treeSeedSuite, type FixtureTree, type I0Seed, type RecordedRuns } from './cache-differential.js';
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

/** The routed paths, sorted: every `.json` file of the corpus, each by a default route. */
const CLEAN_ROUTED_PATHS: readonly string[] = Object.keys(CLEAN_DATA_FILES).filter((path) => path.endsWith('.json')).toSorted((left, right) => left.localeCompare(right));

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
interface DataArm {
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
export async function evictRowSets(cacheDir: string, ids: readonly RowSetId[]): Promise<void> {
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

/** A config with two checks: the routes that hold no rows, and one statement naming `data__nodes`. */
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
  '      description: Never a row, and refused while any routed data file holds none',
  '      sql: "SELECT count(*) AS n FROM data__nodes HAVING count(*) < 0"',
  '      severity: warning',
  '',
].join('\n');

/** The clean corpus and its checks, committed. */
export const DATA_TREE: FixtureTree = {
  committed: (corpus) => writeCleanCorpus(corpus, DATA_CHECKS_CONFIG),
  untracked: () => undefined,
};

/** Every `data__*` relation a statement can name, stored and derived. */
const DATA_RELATIONS: readonly string[] = DUMPED_RELATIONS.map((relation) => relation.name).filter((name) => name.startsWith('data__'));

/** A recorded run, as a seed's consumed check receives it. */
type RecordedRun = NonNullable<NonNullable<RecordedRuns[keyof RecordedRuns]>['query']>;

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

/**
 * The clean census, judged before any comparison: every measured dump holds rows for every
 * `data__*` relation, its routes are exactly the routed paths and all `facts`, and every arm's rows
 * of every data relation equal store-off's. A dump with no row of a relation is a refusal or a lost
 * relation, and comparing two of them would agree on nothing.
 *
 * @param runs - The consumed runs; must hold `storeOff:measured`
 * @returns The rows per relation of the store-off dump, for the caller to assert on
 */
export function expectCleanDataCensus(runs: RecordedRuns): Record<string, readonly string[]> {
  const dumps = measuredDumps(runs);
  expect(dumps.map(([label]) => label), 'the census needs the store-off reference').toContain('storeOff:measured');
  expect(dumps.length, 'the census compares at least two arms').toBeGreaterThan(1);
  for (const [label, run] of dumps) {
    const empty = DATA_RELATIONS.filter((relation) => relationRows(run.document, relation).length === 0);
    expect(empty, `${label}: data relations with no row`).toEqual([]);
    const routes = relationRows(run.document, 'data__routes').map((row) => JSON.parse(row) as { path: string; state: string; code: string | null });
    expect(routes.map((route) => route.path).toSorted((left, right) => left.localeCompare(right)), `${label}: routed paths`).toEqual(CLEAN_ROUTED_PATHS);
    expect(routes.filter((route) => route.state !== 'facts').map((route) => dataPairCauseOf(route)), `${label}: routes holding no rows`).toEqual([]);
  }
  const reference = (dumps.find(([label]) => label === 'storeOff:measured') as [string, RecordedRun])[1];
  const census = Object.fromEntries(DATA_RELATIONS.map((relation) => [relation, relationRows(reference.document, relation)]));
  for (const [label, run] of dumps) {
    expect(Object.fromEntries(DATA_RELATIONS.map((relation) => [relation, relationRows(run.document, relation)])), `${label}: the data census`).toEqual(census);
  }
  return census;
}

// ── Defect seeds ────────────────────────────────────────────────────────────

/** One defective file planted into the clean corpus, and the one refusal it must produce. */
interface DataDefect {
  readonly name: string;
  readonly path: string;
  readonly bytes: () => string;
  readonly cause: DataPairCause;
}

/** Where every defect lands: a strict JSON route. */
const DEFECT_PATH = 'bad/package.json';

/**
 * One defect per byte-determined refusal a corpus can plant. The caps are the defaults
 * (`DEFAULT_PARSE_LIMITS`), which no config or variable moves, so each file is built one past its
 * own default. Built on demand: the two cap files are megabytes.
 */
export const DATA_DEFECTS: readonly DataDefect[] = [
  { name: 'nulByte', path: DEFECT_PATH, bytes: () => `{"a": "x${NUL}y"}\n`, cause: 'defective:BLOB_NOT_TEXT' },
  { name: 'malformed', path: DEFECT_PATH, bytes: () => '{"a": }\n', cause: 'defective:DATA_PARSE_ERROR' },
  { name: 'commentInStrict', path: DEFECT_PATH, bytes: () => '{\n  // no comments in strict JSON\n  "a": 1\n}\n', cause: 'defective:DATA_PARSE_ERROR' },
  { name: 'pastInputBytes', path: DEFECT_PATH, bytes: () => `["${'a'.repeat(DEFAULT_PARSE_LIMITS.inputBytes)}"]\n`, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
  { name: 'pastOutputRows', path: DEFECT_PATH, bytes: () => `[${Array.from({ length: DEFAULT_PARSE_LIMITS.outputRows + 1 }, () => '0').join(',')}]\n`, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
  { name: 'pastOutputDepth', path: DEFECT_PATH, bytes: () => `${'['.repeat(DEFAULT_PARSE_LIMITS.outputDepth + 1)}${']'.repeat(DEFAULT_PARSE_LIMITS.outputDepth + 1)}\n`, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
  { name: 'pastOutputBytes', path: DEFECT_PATH, bytes: () => `["${'a'.repeat(DEFAULT_PARSE_LIMITS.outputBytes)}"]\n`, cause: 'defective:PARSE_LIMIT_EXCEEDED' },
];

/** The arms every defect seed runs: each must refuse alike. */
export const EVERY_ARM = ['storeOff', 'cold', 'warmSameHistory', 'partialEviction'] as const;

/** A finding of `vat resources check`, the fields the defect judgment reads. */
interface CheckFinding {
  readonly code: string;
  readonly check?: string;
  readonly location?: string;
  readonly evidence?: { readonly state?: string; readonly code?: string };
  readonly reason?: { readonly refusal?: string };
  readonly message: string;
}

/**
 * The one refusal, on one measured check run: the routes check names the path with its state and
 * code, which classify as the defect's cause, and the check naming `data__nodes` is broken with
 * `INPUT_UNREADABLE` naming the path. Nothing else refuses.
 *
 * @param label - The run's label
 * @param run - A measured `vat resources check` run
 * @param defect - The defect
 */
function expectOneRefusal(label: string, run: RecordedRun, defect: DataDefect): void {
  const findings = run.document['findings'] as readonly CheckFinding[];
  const routes = findings.filter((finding) => finding.code === 'CUSTOM:data-routes');
  expect(routes.map((finding) => ({ path: finding.location, state: finding.evidence?.state, code: finding.evidence?.code })), `${label}: routes holding no rows`)
    .toEqual([{ path: defect.path, state: defect.cause.split(':')[0], code: defect.cause.split(':')[1] }]);
  const [route] = routes;
  expect(dataPairCauseOf({ state: route?.evidence?.state ?? '', code: route?.evidence?.code ?? null }), `${label}: the registered cause`).toBe(defect.cause);
  const broken = findings.filter((finding) => finding.code === 'RESOURCE_CHECK_BROKEN');
  expect(broken.map((finding) => ({ check: finding.check, refusal: finding.reason?.refusal })), `${label}: refused checks`)
    .toEqual([{ check: 'data-nodes', refusal: 'INPUT_UNREADABLE' }]);
  expect(broken[0]?.message, `${label}: the refusal names the pair`).toContain(`${defect.path}: defective ${defect.cause.split(':')[1] ?? ''}`);
}

/**
 * A defect seed: the clean corpus plus one defective file, committed, and `vat resources check` in
 * every arm refusing exactly that pair.
 *
 * Red, seeded once and reverted: the malformed seed's bytes made valid (`{"a": 1}`), so nothing
 * refuses: the judgment failed on store-off, "routes holding no rows", 1 failure.
 *
 * @param defect - The defect
 * @returns The seed
 */
function dataDefectSeed(defect: DataDefect): I0Seed {
  return {
    name: defect.name,
    needs: null,
    arms: EVERY_ARM,
    verbs: ['check'],
    stateA: (corpus, git) => {
      writeCorpus(corpus, { [defect.path]: defect.bytes() });
      git(['add', '--', defect.path]);
      git(['commit', '-q', '-m', `a defective data file: ${defect.name}`]);
      return Promise.resolve();
    },
    expect: { agrees: { because: `the ${defect.name} file refuses its one pair alike in every arm`, storeDeclines: null } },
    consumed: {
      runs: EVERY_ARM.map((arm) => `${arm}:measured` as const),
      check: (runs) => {
        for (const [label, byVerb] of Object.entries(runs)) {
          const run = byVerb?.check;
          if (run === undefined) throw new Error(`${label}: no check run`);
          expectOneRefusal(label, run, defect);
        }
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
 * returns what runs one named defect seed and answers the arms it ran, each of which refused its one
 * pair alike ({@link EVERY_ARM}, or the run throws naming the arm that did not). The
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
