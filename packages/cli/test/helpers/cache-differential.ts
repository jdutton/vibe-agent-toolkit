/**
 * The I0 differential: **a cache changes what a run costs, never what it answers.**
 *
 * One harness, run by every `cache-differential-*.system.test.ts` file. Each arm
 * runs the same verbs over the same tree at the same path, and every arm's
 * document must equal the store-off arm's, the reference. Two tables are the
 * only extension points: {@link ARMS} (how a run reaches the store) and a seed
 * ({@link I0Seed}, a planted condition and what it must produce). A later step
 * that adds an arm adds a row to the first; one that adds a hazard adds a seed.
 *
 * ## An equivalence that never diverged proves nothing
 *
 * So every arm carries a POSITIVE tell, asserted on every measured run before
 * any document is compared: store-off touched no store, cold derived and wrote
 * one, warm was served by one. And the divergence seed plants a wrong cache
 * entry the comparison must catch, by relation, exactly.
 *
 * ## One cell per (arm, verb)
 *
 * Every verb runs in a cell of its own: fresh arm directories, the fixture
 * rewritten at the one corpus path, the seed's state A, the arm's `prepare`
 * (a warm arm primes here, under A), the seed's `toB`, then the one measured
 * run. A cold arm that ran four verbs in one directory would be cold for the
 * first only, and no cell inherits another's state.
 *
 * ## The census reads the one enumeration
 *
 * Every `blob_conditions` code, `contentState` and `realization_conditions` row
 * a dump carries is classified by the absence-cause enumeration
 * (`./absence-causes.ts`) and counted by member; one nothing classifies throws.
 * A finding, an error envelope or an entry of `claude context`'s `refused[]`
 * counts under the group of members that surface its code, or as `ungrouped`
 * when it refuses and no member surfaces it.
 */

import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { devNull } from 'node:os';
import { pathToFileURL } from 'node:url';

import { allDerivedSpecs, BLOB_NOT_TEXT, PROJECTION_TABLES, quoteIdentifier } from '@vibe-agent-toolkit/resources';
import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import {
  CRAWL_STORE_READ_ID,
  CRAWL_STORE_WRITE_ID,
  isUnderRoot,
  mkdirSyncReal,
  relativeEscapesRoot,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { expectAbsenceCause, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { expect } from 'vitest';
import { z } from 'zod';

import { StatedLimitSchema } from '../../src/commands/resources/check-schema.js';
import { reportShapeFor } from '../../src/report-schemas.js';
import { PROJECTION_STORE_DIR_ENV, PROJECTION_STORE_ENV, PROJECTION_STORE_OFF, PROJECTION_STORE_SQLITE } from '../../src/utils/projection-store.js';
import { RESOURCES_CRAWL_ENV, RESOURCES_CRAWL_PROJECTION } from '../../src/utils/resource-loader.js';
import { createIsolatedScratch, createSuiteContext, executeCli, isolatedScratchEnv, writeFileTree } from '../system/test-common.js';

import {
  absenceRowsOfDump,
  findingBucket,
  groupOf,
  memberEntry,
  memberRowCounts,
  siblingsOf,
  surfacedCodesOf,
  type AbsenceMember,
} from './absence-causes.js';
import { contributorsCharged, rowsStoredUnder, storeFilesUnder } from './projection-store-probe.js';

// ── Names ───────────────────────────────────────────────────────────────────

/** How a run reaches the projection store. Store-off is the reference arm. */
type ArmName = 'storeOff' | 'cold' | 'warmSameHistory';

/** The four verbs the harness runs; `query` is the dump. */
type VerbName = 'validate' | 'check' | 'query' | 'context';

/** A recorded run: the warm arm's prime, or any arm's measured run. */
type RunLabel = `${ArmName}:${'prime' | 'measured'}`;

// ── The dump ────────────────────────────────────────────────────────────────

/** A relation `vat resources query` exposes, and its columns in declaration order. */
interface DumpedRelation {
  readonly name: string;
  readonly columns: readonly string[];
  /** Whether a row is a pure function of a blob's bytes (`PROJECTION_TABLES` scope `blob`). */
  readonly blobScoped: boolean;
}

/** Every materialised and derived relation, from the two registries. */
export const DUMPED_RELATIONS: readonly DumpedRelation[] = [
  ...Object.values(PROJECTION_TABLES).map((spec) => ({ name: spec.name, columns: spec.columns, blobScoped: spec.scope === 'blob' })),
  ...allDerivedSpecs().map((spec) => ({ name: spec.name, columns: spec.columns, blobScoped: false })),
];

/** Every relation name, for checking a name an expectation or a map spells. */
export const RELATION_NAMES: ReadonlySet<string> = new Set(DUMPED_RELATIONS.map((relation) => relation.name));

/**
 * One relation's rows as JSON text: `json_object('<column>', "<column>", ...)`.
 *
 * @param relation - The relation
 * @returns The SQL expression, its column names quoted identifiers
 */
export function rowObjectSql(relation: DumpedRelation): string {
  const pairs = relation.columns.map((column) => `'${column}', ${quoteIdentifier(column)}`).join(', ');
  return `json_object(${pairs})`;
}

/**
 * Every row of one relation as `(relation, row)` pairs, the row as JSON text.
 *
 * @param relation - The relation
 * @returns The SELECT, unordered
 */
export function relationRowsSql(relation: DumpedRelation): string {
  return `SELECT '${relation.name}' AS relation, ${rowObjectSql(relation)} AS row FROM ${quoteIdentifier(relation.name)}`;
}

/**
 * The dump: every row of every relation, as `(relation, row)` pairs ordered by both.
 *
 * Run with `--base HEAD` so `changed_files` is evaluated. `json_object` takes
 * two arguments per column; the dump test holds each relation under the SQLite
 * argument limit the Node floor's build is not verified to raise.
 */
const DUMP_SQL = DUMPED_RELATIONS.map((relation) => relationRowsSql(relation)).join(' UNION ALL ') + ' ORDER BY relation, row';

/** One `(relation, row)` pair of a dump, the row still JSON text. */
interface DumpRow {
  readonly relation: string;
  readonly row: string;
}

/**
 * A query document's rows grouped by relation, in their printed order.
 *
 * @param document - A `vat resources query` document over a `(relation, row)` statement
 * @returns Relation name to its rows' JSON text
 */
function rowsByRelation(document: Record<string, unknown>): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const { relation, row } of dumpRows(document)) {
    const rows = grouped.get(relation) ?? [];
    rows.push(row);
    grouped.set(relation, rows);
  }
  return grouped;
}

function dumpRows(document: Record<string, unknown>): readonly DumpRow[] {
  const data = document['data'] as { rows?: readonly DumpRow[] } | null | undefined;
  return data?.rows ?? [];
}

/**
 * Relations with no row in a store-off dump of the gate fixture, each with why.
 * Held both ways: a listed relation that gains rows reds as surely as an unlisted
 * one with none.
 */
export const DECLARED_EMPTY: Readonly<Record<string, string>> = {
  realization_conditions:
    'The populations these verbs run record a realization condition only for an unlistable directory or a'
    + ' declined symbolic link, and the gate fixture holds neither: each is an absence-cause member, planted by'
    + ' its own seed (absence-seeds.ts), which a host that cannot plant it skips.',
};

// ── The census ──────────────────────────────────────────────────────────────

/** What one run reported absent: member rows by member, and refusing findings by group. */
interface AbsenceCensus {
  readonly rows: Partial<Record<AbsenceMember, number>>;
  readonly findings: Readonly<Record<string, number>>;
}

/** Counts findings into a census by their bucket. */
class FindingTally {
  private readonly counts: Record<string, number> = {};
  private readonly refusing: string[] = [];

  add(code: string): void {
    const bucket = findingBucket(code);
    if (bucket === undefined) return;
    this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
    this.refusing.push(code);
  }

  get findings(): Readonly<Record<string, number>> {
    return { ...this.counts };
  }

  /** Every refusing code counted, one per finding. */
  get codes(): readonly string[] {
    return [...this.refusing];
  }
}

/**
 * The refusals a report envelope carries: an error envelope, and every finding.
 *
 * @param document - A report envelope
 * @param tally - Where they are counted
 */
function tallyEnvelope(document: Record<string, unknown>, tally: FindingTally): void {
  if (document['status'] === 'error') tally.add((document['error'] as { code: string }).code);
  for (const finding of (document['findings'] as readonly { code: string }[] | undefined) ?? []) tally.add(finding.code);
}

/**
 * A dump's rows in the tables an absence cause is observed in, and each extent's
 * declared labels: what the census classifies.
 *
 * @param document - A `vat resources query` document over a `(relation, row)` statement
 * @returns The rows and labels
 */
function absenceRowsOf(document: Record<string, unknown>): ReturnType<typeof absenceRowsOfDump> {
  const grouped = rowsByRelation(document);
  return absenceRowsOfDump((relation) => grouped.get(relation) ?? []);
}

/** A report envelope's refusals. */
function reportTally(document: Record<string, unknown>): FindingTally {
  const tally = new FindingTally();
  tallyEnvelope(document, tally);
  return tally;
}

/** `claude context`'s refusals: every answer's `refused[]`, or the envelope's when it failed. */
function contextTally(document: Record<string, unknown>): FindingTally {
  if (document['kind'] !== 'context-answers') return reportTally(document);
  const tally = new FindingTally();
  for (const answer of document['answers'] as readonly { refused?: readonly { code: string }[] }[]) {
    for (const refused of answer.refused ?? []) tally.add(refused.code);
  }
  return tally;
}

function reportCensus(document: Record<string, unknown>): AbsenceCensus {
  return { rows: {}, findings: reportTally(document).findings };
}

function queryCensus(document: Record<string, unknown>): AbsenceCensus {
  const { rows, labels } = absenceRowsOf(document);
  return { rows: memberRowCounts(rows, labels), findings: reportTally(document).findings };
}

function contextCensus(document: Record<string, unknown>): AbsenceCensus {
  return { rows: {}, findings: contextTally(document).findings };
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * The per-run fields of each verb's document: what a run took and where its
 * answer came from. `checks[]` names a field of every element of `checks`.
 * Everything else is compared exactly.
 */
export const PER_RUN_FIELDS: Readonly<Record<VerbName, readonly string[]>> = {
  validate: ['durationMs', 'data.population'],
  check: ['durationMs', 'data.population', 'data.populationSecs', 'data.lensSecs', 'data.lensPopulation', 'data.checks[].durationSecs'],
  query: ['durationMs', 'data.population', 'data.populationSecs', 'data.lensSecs', 'data.lensPopulation'],
  context: [],
};

/**
 * A copy of a record without one key.
 *
 * @param record - The record
 * @param key - The key dropped
 * @returns The copy
 */
function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

/**
 * A copy of `value` without one dotted path (`a.b`, `a.list[].c`).
 *
 * @param value - A parsed document, or a part of one
 * @param segments - The path, split on `.`
 * @returns The copy
 */
function withoutPath(value: unknown, segments: readonly string[]): unknown {
  const [head, ...rest] = segments;
  if (head === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const isList = head.endsWith('[]');
  const key = isList ? head.slice(0, -2) : head;
  if (!Object.hasOwn(record, key)) return value;
  if (rest.length === 0 && !isList) return withoutKey(record, key);
  const child = record[key];
  const next = isList && Array.isArray(child) ? child.map((element) => withoutPath(element, rest)) : withoutPath(child, rest);
  return { ...record, [key]: next };
}

/**
 * A document without its verb's per-run fields.
 *
 * @param verb - The verb whose fields are dropped
 * @param document - The parsed document
 * @returns The comparable rest
 */
export function normalizeDocument(verb: VerbName, document: Record<string, unknown>): Record<string, unknown> {
  return PER_RUN_FIELDS[verb].reduce<Record<string, unknown>>(
    (current, path) => withoutPath(current, path.split('.')) as Record<string, unknown>,
    document,
  );
}

// ── Verb rows ───────────────────────────────────────────────────────────────

/** What `vat claude context` prints. It publishes no schema yet (a legacy document), so this is the harness's. */
const CONTEXT_DOCUMENT_SCHEMA = z.union([
  z.object({
    kind: z.literal('context-answers'),
    root: z.string(),
    answers: z.array(z.object({
      kind: z.enum(['answer', 'unknown']),
      refused: z.array(z.object({ path: z.string(), code: z.string(), reason: z.string() }).strict()).optional(),
    }).passthrough()),
    boundsStatement: z.string(),
    limits: z.array(StatedLimitSchema),
    modelledBehaviours: z.array(z.unknown()),
  }).strict(),
  reportSchema(z.unknown(), FindingSchema),
]);

/** One verb the harness runs, and everything it is judged by. */
interface VerbRow {
  readonly name: VerbName;
  readonly args: readonly string[];
  readonly schema: z.ZodTypeAny;
  readonly normalize: (document: Record<string, unknown>) => Record<string, unknown>;
  readonly censusOf: (document: Record<string, unknown>) => AbsenceCensus;
  /** Every refusing code the run reported, one per finding: what a seed holds to its cause's own codes. */
  readonly refusingCodesOf: (document: Record<string, unknown>) => readonly string[];
}

/**
 * The query row, over any `(relation, row)` statement.
 *
 * @param sql - The statement; {@link DUMP_SQL} unless a subject needs its own
 * @returns The row
 */
export function queryVerb(sql: string): VerbRow {
  return {
    name: 'query',
    args: ['resources', 'query', '--base', 'HEAD', '--format', 'json', sql],
    schema: reportShapeFor('resources query').schema,
    normalize: (document) => normalizeDocument('query', document),
    censusOf: queryCensus,
    refusingCodesOf: (document) => reportTally(document).codes,
  };
}

/** The four verbs, query as the dump. */
export const VERBS: { readonly [Name in VerbName]: VerbRow } = {
  validate: {
    name: 'validate',
    args: ['resources', 'validate', '--format', 'json'],
    schema: reportShapeFor('resources validate').schema,
    normalize: (document) => normalizeDocument('validate', document),
    censusOf: reportCensus,
    refusingCodesOf: (document) => reportTally(document).codes,
  },
  check: {
    name: 'check',
    args: ['resources', 'check', '--format', 'json'],
    schema: reportShapeFor('resources check').schema,
    normalize: (document) => normalizeDocument('check', document),
    censusOf: reportCensus,
    refusingCodesOf: (document) => reportTally(document).codes,
  },
  query: queryVerb(DUMP_SQL),
  context: {
    name: 'context',
    args: ['claude', 'context', '.', '--format', 'json'],
    schema: CONTEXT_DOCUMENT_SCHEMA,
    normalize: (document) => normalizeDocument('context', document),
    censusOf: contextCensus,
    refusingCodesOf: (document) => contextTally(document).codes,
  },
};

/** Every verb, in the order a cell sequence runs them: the keys of {@link VERBS}, so none is skipped. */
export const VERB_NAMES = Object.keys(VERBS) as readonly VerbName[];

/** The verb rows a subject runs: the four, with any the subject states over them. */
type VerbRows = Readonly<Record<VerbName, VerbRow>>;

// ── Arms ────────────────────────────────────────────────────────────────────

/** One cell's private directories: `createIsolatedScratch`'s home and tmp, plus the store and timing dumps. */
export interface ArmDirs {
  readonly root: string;
  readonly tmp: string;
  readonly home: string;
  readonly store: string;
  readonly timing: string;
  /** Where this build keeps its parse cache under `tmp`, asked of the build. */
  readonly parse: string;
}

/** Runs git in the corpus under the cell's environment, with a fixed identity. */
export type Git = (args: readonly string[]) => string;

/** One recorded run. */
interface RunRecord {
  readonly label: RunLabel;
  readonly verb: VerbName;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly document: Record<string, unknown>;
  /** Every contributor the run charged, from its own timing directory. */
  readonly charged: readonly string[];
}

/** What an arm's `prepare` may do besides touching the corpus: run the subject's query, recorded as this cell's prime. */
type Prime = () => Promise<RunRecord>;

/** One way a run reaches the store. */
interface Arm {
  readonly env: (dirs: ArmDirs) => Record<string, string>;
  /** After the fixture and state A; returns the prime it ran, if any. */
  readonly prepare: (dirs: ArmDirs, corpus: string, git: Git, prime: Prime) => Promise<RunRecord | undefined>;
  /** The positive tell, asserted on every measured run the seed does not claim. */
  readonly tell: (run: RunRecord, dirs: ArmDirs) => void;
}

/** The prefix of every charge the store itself files (`CRAWL_STORE_READ_ID`, `CRAWL_STORE_WRITE_ID`). */
const STORE_CHARGE_PREFIX = CRAWL_STORE_READ_ID.slice(0, CRAWL_STORE_READ_ID.indexOf(':') + 1);

/** The store's own charges, in charge order. */
function storeCharges(run: RunRecord): string[] {
  return run.charged.filter((id) => id.startsWith(STORE_CHARGE_PREFIX));
}

/** One field of `data`, for a verb whose document carries it. */
function dataField(run: RunRecord, field: string): unknown {
  const data = run.document['data'] as Record<string, unknown> | null | undefined;
  return data !== null && data !== undefined && Object.hasOwn(data, field) ? data[field] : undefined;
}

/**
 * Where a run says its answer came from: `data.population`, and `data.lensPopulation`
 * for a verb that reports its lenses' own populations. A lens population of `'none'`
 * (no lens the statement reached populates a lane of its own) carries no origin to
 * judge; whether the arm still answered alike is the compared document's to say.
 *
 * @param run - The run
 * @param origin - Where this arm's answer must have come from
 */
function expectOrigin(run: RunRecord, origin: 'derived' | 'store'): void {
  const population = dataField(run, 'population');
  if (population !== undefined) expect(population, `${run.label} ${run.verb} population`).toBe(origin);
  const lens = dataField(run, 'lensPopulation');
  if (lens !== undefined && lens !== 'none') expect(lens, `${run.label} ${run.verb} lensPopulation`).toBe(origin);
}

/**
 * Every file (not directory) under a directory, relative and forward-slashed.
 *
 * @param root - The directory
 * @returns The files, sorted
 */
function filesUnder(root: string): string[] {
  return pathsUnder(root).filter((path) => !statSync(safePath.join(root, path)).isDirectory());
}

/**
 * Every path under a directory, relative and forward-slashed, directories included.
 *
 * @param root - The directory
 * @returns The paths, sorted
 */
function pathsUnder(root: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(safePath.join(root, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      found.push(child);
      // A link is listed, never followed: a cell holds none, and one a run made is listed as itself.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(child);
    }
  };
  visit('');
  return found.toSorted((left, right) => left.localeCompare(right));
}

/** A path segment naming a projection artifact, in a forward-slashed relative path. */
const PROJECTION_SEGMENT = /(?:^|\/)projection/;

/** Whether any path under `root` names a projection artifact. */
function projectionArtifactsUnder(root: string): string[] {
  return pathsUnder(root).filter((path) => PROJECTION_SEGMENT.test(path));
}

/**
 * A scratch directory's environment with git's config confined to it: no system
 * config, and a global config and XDG directory under its home.
 *
 * @param root - A {@link createIsolatedScratch} directory
 * @returns The environment entries
 */
function isolatedGitEnv(root: string): Record<string, string> {
  const home = safePath.join(root, 'home');
  return {
    ...isolatedScratchEnv(root),
    GIT_CONFIG_GLOBAL: safePath.join(home, '.gitconfig'),
    XDG_CONFIG_HOME: safePath.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
  };
}

/** The environment every arm shares; the store selection is the arm's own. */
function baseEnv(dirs: ArmDirs): Record<string, string> {
  return {
    ...isolatedGitEnv(dirs.root),
    NODE_OPTIONS: '',
    [RESOURCES_CRAWL_ENV]: RESOURCES_CRAWL_PROJECTION,
    [PROJECTION_STORE_DIR_ENV]: dirs.store,
  };
}

const storeOnEnv = (dirs: ArmDirs): Record<string, string> => ({ ...baseEnv(dirs), [PROJECTION_STORE_ENV]: PROJECTION_STORE_SQLITE });

/** A cold run wrote what it derived: charged a miss and a write, left rows and a parse shard. */
function coldTell(run: RunRecord, dirs: ArmDirs): void {
  expect(storeCharges(run), `${run.label} ${run.verb}`).toEqual(expect.arrayContaining([CRAWL_STORE_READ_ID, CRAWL_STORE_WRITE_ID]));
  expect(rowsStoredUnder(dirs.store)).toBeGreaterThan(0);
  expect(filesUnder(dirs.parse).filter((path) => path.endsWith('.json')).length, 'a parse shard').toBeGreaterThan(0);
  expectOrigin(run, 'derived');
}

/**
 * The arms, the reference first. Exhaustive over {@link ArmName}: an arm with no
 * tell does not typecheck, and {@link ARM_NAMES} is read off this table.
 */
const ARMS: { readonly [Name in ArmName]: Arm } = {
  storeOff: {
    env: (dirs) => ({ ...baseEnv(dirs), [PROJECTION_STORE_ENV]: PROJECTION_STORE_OFF }),
    prepare: () => Promise.resolve(undefined),
    tell: (run, dirs) => {
      expect(storeFilesUnder(dirs.store), `${run.verb}: a store-off run opened a store`).toEqual([]);
      expect(projectionArtifactsUnder(dirs.tmp)).toEqual([]);
      expect(storeCharges(run)).toEqual([]);
      expectOrigin(run, 'derived');
    },
  },
  cold: {
    env: storeOnEnv,
    prepare: (dirs) => {
      // Asserted BEFORE the run: a leaked store or parse entry would make this a warm run wearing a cold label.
      for (const directory of [dirs.tmp, dirs.store, dirs.home]) expect(filesUnder(directory), directory).toEqual([]);
      return Promise.resolve(undefined);
    },
    tell: coldTell,
  },
  warmSameHistory: {
    env: storeOnEnv,
    prepare: async (dirs, _corpus, _git, prime) => {
      const primed = await prime();
      coldTell(primed, dirs);
      return primed;
    },
    tell: (run) => {
      // A read with no write. The read is charged for a miss too (it files from a `finally`), so only the
      // absent write proves a hit: a hit returns before anything is derived, and only a derivation is
      // written. Every verb hits after one query prime because every population a verb makes asks the
      // filesystem extent the same question (the ignored half declined), so one stored extent serves all.
      expect(storeCharges(run), `${run.verb}: the warm run was not served`).toEqual([CRAWL_STORE_READ_ID]);
      expectOrigin(run, 'store');
    },
  },
};

/** Every arm, read off {@link ARMS} so none is skipped. */
const ARM_NAMES = Object.keys(ARMS) as readonly ArmName[];
if (ARM_NAMES[0] !== 'storeOff') throw new Error('ARMS must list store-off, the reference, first');

// ── Seeds ───────────────────────────────────────────────────────────────────

/** What a seed must produce. */
type SeedExpectation =
  | { readonly diverges: { readonly relations: readonly string[]; readonly verbs: readonly VerbName[] } }
  | { readonly refuses: { readonly cause: AbsenceMember; readonly perVerb: Readonly<Partial<Record<VerbName, number>>> } }
  | { readonly agreesAndMisses: { readonly arm: ArmName } }
  | { readonly documentsHole: { readonly arm: ArmName; readonly closedBy: string } };

/** The recorded runs, by label and verb. */
export type RecordedRuns = Readonly<Partial<Record<RunLabel, Readonly<Partial<Record<VerbName, RunRecord>>>>>>;

/** What a host must be able to do for a seed's plant: deny a read by mode, or create a symbolic link. */
export type HostNeed = 'denyReads' | 'symlinks';

/** A planted condition and what it must produce. */
export interface I0Seed {
  readonly name: string;
  /** What the host must be able to do to plant it; null for a plant every host can make. */
  readonly needs: HostNeed | null;
  readonly verbs?: readonly VerbName[];
  readonly arms?: readonly ArmName[];
  /** Applied after the fixture is written. */
  readonly stateA?: (corpus: string, git: Git, dirs: ArmDirs) => Promise<void>;
  /**
   * Undoes a plant that would outlive the cell on the host (a directory's mode), so the
   * corpus can be removed: runs in a `finally` wrapping state A through the measured run.
   */
  readonly restore?: (corpus: string) => void;
  /** After `arm.prepare`, before the measured run. */
  readonly toB?: (arm: ArmName, dirs: ArmDirs, corpus: string, git: Git) => Promise<void>;
  /** A plant outside the corpus (a forged cache entry), after `toB`. */
  readonly beforeRun?: (arm: ArmName, dirs: ArmDirs, corpus: string) => Promise<void>;
  readonly env?: (arm: ArmName, dirs: ArmDirs) => Record<string, string>;
  readonly expect: SeedExpectation;
  /** The recorded runs the seed reads, and what it asserts of them. */
  readonly consumed: { readonly runs: readonly RunLabel[]; readonly check: (runs: RecordedRuns) => void };
}

/** A tree the harness runs over: a fixture rewritten per cell, or a fixed tree. */
interface Subject {
  /** The corpus path every arm measures at. */
  readonly corpus: string;
  /** Rewrites the corpus from nothing, or `undefined` for a fixed tree no arm mutates. */
  readonly write: ((git: Git) => void) | undefined;
}

/** The outcome of one seed (or the unseeded gate) across its arms. */
export interface DifferentialResult {
  readonly arms: readonly ArmName[];
  readonly verbs: readonly VerbName[];
  /** Measured runs by arm and verb. */
  readonly measured: Readonly<Record<ArmName, Partial<Record<VerbName, RunRecord>>>>;
  readonly runs: RecordedRuns;
  /** The verb rows the cells ran, which every comparison and census reads. */
  readonly rows: VerbRows;
}

/** A difference between one arm's run and the reference's. */
interface Divergence {
  readonly arm: ArmName;
  readonly verb: VerbName;
  readonly exit: boolean;
  /** For the dump, the relations whose rows differ; empty otherwise. */
  readonly relations: readonly string[];
}

// ── Running ─────────────────────────────────────────────────────────────────

/** Which resources module the build at `binPath` loads, so its parse directory is asked of the build. */
function buildResourcesEntry(binPath: string): string {
  return createRequire(binPath).resolve('@vibe-agent-toolkit/resources');
}

/** Imports the build's resources entry (argv[1]) and prints its parse directory. */
const PRINT_PARSE_DIRECTORY = 'const m = await import(process.argv[1]); process.stdout.write(m.parseCacheDirectory());';

/** Each build's parse directory, relative to the tmp it was asked under: asked once per build. */
const parseDirectoryUnderTmp = new Map<string, string>();

/**
 * Where the build at `binPath` keeps its parse cache in a cell: its own
 * `parseCacheDirectory()`, asked under the first cell's environment and accepted
 * only under that cell's tmp. The build roots it at the tmp directory under a
 * name of its own, so a later cell's is that name under its own tmp, with no
 * spawn per cell.
 *
 * @param binPath - The CLI build
 * @param env - The cell's environment
 * @param tmp - The cell's tmp
 * @returns The directory
 */
async function parseDirectoryOf(binPath: string, env: Record<string, string>, tmp: string): Promise<string> {
  let relative = parseDirectoryUnderTmp.get(binPath);
  if (relative === undefined) {
    // `node --input-type=module -e <script> <entry>`: the entry is the script's argv[1].
    const entry = pathToFileURL(buildResourcesEntry(binPath)).href;
    const result = await executeCli(entry, [], { cwd: tmp, env, nodeArgs: ['--input-type=module', '-e', PRINT_PARSE_DIRECTORY] });
    expect(result.status, result.stderr).toBe(0);
    const dir = toForwardSlash(result.stdout);
    expect(isUnderRoot(tmp, dir), `the build's parse directory ${dir} is not under the cell's tmp ${tmp}`).not.toBe('outside');
    relative = safePath.relative(tmp, dir);
    // Lexically too, since later cells join this to their own tmp.
    expect(relativeEscapesRoot(relative), `the build's parse directory ${dir} is not spelled under the cell's tmp ${tmp}`).toBe(false);
    parseDirectoryUnderTmp.set(binPath, relative);
  }
  return safePath.join(tmp, relative);
}

/** Every cell directory made since the last {@link removeCells}. */
const cellRoots: string[] = [];

/** Remove every cell directory this process made; a suite's `afterAll`. */
export function removeCells(): void {
  for (const root of cellRoots.splice(0)) removeTempDir(root);
}

/**
 * A fresh cell: `createIsolatedScratch`'s directories plus a store and a timing root.
 *
 * @param binPath - The CLI build, asked where its parse cache lives
 * @returns The directories
 */
async function freshCell(binPath: string): Promise<ArmDirs> {
  const root = createIsolatedScratch('vat-i0-cell-');
  cellRoots.push(root);
  const dirs = {
    root,
    tmp: safePath.join(root, 'tmp'),
    home: safePath.join(root, 'home'),
    store: safePath.join(root, 'store'),
    timing: safePath.join(root, 'timing'),
  };
  mkdirSyncReal(dirs.store, { recursive: true });
  mkdirSyncReal(dirs.timing, { recursive: true });
  const parse = await parseDirectoryOf(binPath, baseEnv({ ...dirs, parse: '' }), dirs.tmp);
  return { ...dirs, parse };
}

/**
 * Every new path under the cell after a run must be one of its declared caches:
 * the store, the parse tree (and the directories above it), or the timing root.
 */
function assertOnlyDeclaredCaches(dirs: ArmDirs, before: ReadonlySet<string>, label: string): void {
  const relative = (path: string): string => toForwardSlash(safePath.relative(dirs.root, path));
  const caches = [dirs.store, dirs.timing, dirs.parse].map(relative);
  // Both sides are relative and forward-slashed already; one is the other, or holds it.
  const holds = (outer: string, inner: string): boolean => toForwardSlash(inner).startsWith(`${outer}/`);
  const undeclared = pathsUnder(dirs.root).filter(
    (path) => !before.has(path) && !caches.some((cache) => path === cache || holds(cache, path) || holds(path, cache)),
  );
  expect(undeclared, `${label}: a run wrote outside its declared caches`).toEqual([]);
}

/** The cell-scoped runner: spawns one verb, parses and schema-checks its document, records its charges. */
interface CellRunner {
  readonly run: (verb: VerbRow, label: RunLabel) => Promise<RunRecord>;
}

function cellRunner(options: { binPath: string; corpus: string; dirs: ArmDirs; env: Record<string, string>; maxBuffer: number | undefined }): CellRunner {
  let ordinal = 0;
  return {
    run: async (verb, label) => {
      ordinal += 1;
      const timing = safePath.join(options.dirs.timing, String(ordinal));
      mkdirSyncReal(timing, { recursive: true });
      const before = new Set(pathsUnder(options.dirs.root));
      const result = await executeCli(options.binPath, [...verb.args], {
        cwd: options.corpus,
        env: { ...options.env, VAT_CRAWL_TIMING: timing },
        ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
      });
      // The published schema first: a document no consumer can read is not an answer to compare.
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new Error(`${label} ${verb.name}: stdout is not JSON (exit ${String(result.status)}): ${result.stderr}`);
      }
      const checked = verb.schema.safeParse(parsed);
      expect(checked.success, `${label} ${verb.name}: ${checked.success ? '' : checked.error.message}`).toBe(true);
      assertOnlyDeclaredCaches(options.dirs, before, `${label} ${verb.name}`);
      return {
        label,
        verb: verb.name,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        document: parsed as Record<string, unknown>,
        charged: contributorsCharged(timing),
      };
    },
  };
}

/** What a differential run needs to know. */
interface DifferentialOptions {
  readonly binPath: string;
  readonly subject: Subject;
  /** The verb rows to run, when a subject needs its own (the VAT tree's query). */
  readonly verbRows?: Partial<Record<VerbName, VerbRow>>;
  /** Stated only where a document is measured larger than the collector's default. */
  readonly maxBuffer?: number;
}

/**
 * The cell's git: the corpus, the cell's environment, a fixed identity.
 *
 * @param corpus - The corpus
 * @param env - The cell's environment
 * @returns The handle
 */
function cellGit(corpus: string, env: Record<string, string>): Git {
  return (args) => runGitOrThrow(['-c', 'user.name=i0', '-c', 'user.email=i0@example.invalid', ...args], { cwd: corpus, env });
}

/** Whether the seed claims an arm's measured runs, so its own expectation replaces the arm's tell. */
function seedClaims(seed: I0Seed | undefined, arm: ArmName): boolean {
  if (seed === undefined) return false;
  const expectation = seed.expect;
  if ('agreesAndMisses' in expectation) return expectation.agreesAndMisses.arm === arm;
  if ('documentsHole' in expectation) return expectation.documentsHole.arm === arm;
  return false;
}

/**
 * Run one cell: fresh directories, the fixture, state A, prepare, B, the plant, one measured run.
 */
async function runCell(
  options: DifferentialOptions,
  seed: I0Seed | undefined,
  arm: ArmName,
  verb: VerbRow,
  rows: VerbRows,
): Promise<{ prime: RunRecord | undefined; measured: RunRecord }> {
  const { corpus } = options.subject;
  const dirs = await freshCell(options.binPath);
  const env = { ...ARMS[arm].env(dirs), ...seed?.env?.(arm, dirs) };
  const git = cellGit(corpus, env);
  if (options.subject.write !== undefined) {
    removeTempDir(corpus);
    mkdirSyncReal(corpus, { recursive: true });
    options.subject.write(git);
  }
  try {
    await seed?.stateA?.(corpus, git, dirs);
    const runner = cellRunner({ binPath: options.binPath, corpus, dirs, env, maxBuffer: options.maxBuffer });
    // A warm arm primes with the subject's own query, so its prime and a measured dump are one statement.
    const prime = await ARMS[arm].prepare(dirs, corpus, git, () => runner.run(rows.query, `${arm}:prime`));
    await seed?.toB?.(arm, dirs, corpus, git);
    await seed?.beforeRun?.(arm, dirs, corpus);
    const measured = await runner.run(verb, `${arm}:measured`);
    if (!seedClaims(seed, arm)) ARMS[arm].tell(measured, dirs);
    return { prime, measured };
  } finally {
    seed?.restore?.(corpus);
  }
}

/**
 * Run every cell of a seed (or the unseeded gate) and record what each produced.
 *
 * @param options - The build, the subject, any subject-specific verb rows
 * @param seed - The seed, or undefined for the unseeded gate
 * @returns Every run, by arm and verb, and by label
 */
export async function runDifferential(options: DifferentialOptions, seed?: I0Seed): Promise<DifferentialResult> {
  const arms = seed?.arms ?? ARM_NAMES;
  const verbs = seed?.verbs ?? VERB_NAMES;
  expect(arms[0], 'store-off is the reference arm and runs first').toBe('storeOff');
  const measured = Object.fromEntries(ARM_NAMES.map((arm) => [arm, {}])) as Record<ArmName, Partial<Record<VerbName, RunRecord>>>;
  const runs: Partial<Record<RunLabel, Partial<Record<VerbName, RunRecord>>>> = {};
  const rows: VerbRows = { ...VERBS, ...options.verbRows };
  for (const arm of arms) {
    for (const verb of verbs) {
      // eslint-disable-next-line no-await-in-loop -- one cell at a time: every cell rewrites the one corpus path
      const cell = await runCell(options, seed, arm, rows[verb], rows);
      measured[arm][verb] = cell.measured;
      runs[`${arm}:measured`] = { ...runs[`${arm}:measured`], [verb]: cell.measured };
      if (cell.prime !== undefined) runs[`${arm}:prime`] = { ...runs[`${arm}:prime`], [verb]: cell.prime };
    }
  }
  return { arms, verbs, measured, runs, rows };
}

// ── Comparing ───────────────────────────────────────────────────────────────

function sameRows(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

/**
 * The relations whose rows differ between two dumps.
 *
 * @param reference - The store-off dump
 * @param other - Another arm's dump
 * @returns The relation names, sorted
 */
function divergingRelations(reference: Record<string, unknown>, other: Record<string, unknown>): string[] {
  const left = rowsByRelation(reference);
  const right = rowsByRelation(other);
  const names = new Set([...left.keys(), ...right.keys()]);
  return [...names].filter((name) => !sameRows(left.get(name), right.get(name))).sort((a, b) => a.localeCompare(b));
}

/**
 * Every arm's divergence from the store-off reference, per verb.
 *
 * @param result - The recorded runs
 * @returns One entry per (arm, verb) that differs in exit code or normalized document
 */
function divergences(result: DifferentialResult): Divergence[] {
  const { rows } = result;
  const found: Divergence[] = [];
  for (const verb of result.verbs) {
    const reference = result.measured.storeOff[verb];
    if (reference === undefined) throw new Error(`no store-off run of ${verb}`);
    for (const arm of result.arms.filter((name) => name !== 'storeOff')) {
      const other = result.measured[arm][verb];
      if (other === undefined) throw new Error(`no ${arm} run of ${verb}`);
      const exit = other.status !== reference.status;
      const sameDocument = JSON.stringify(rows[verb].normalize(other.document)) === JSON.stringify(rows[verb].normalize(reference.document));
      if (!exit && sameDocument) continue;
      const relations = verb === 'query' ? divergingRelations(reference.document, other.document) : [];
      found.push({ arm, verb, exit, relations });
    }
  }
  return found;
}

/**
 * The census of every measured run.
 *
 * @param result - The recorded runs
 * @returns Arm to verb to census
 */
export function censusOf(result: DifferentialResult): Record<ArmName, Partial<Record<VerbName, AbsenceCensus>>> {
  const { rows } = result;
  const census = Object.fromEntries(ARM_NAMES.map((arm) => [arm, {}])) as Record<ArmName, Partial<Record<VerbName, AbsenceCensus>>>;
  for (const arm of result.arms) {
    for (const verb of result.verbs) {
      const run = result.measured[arm][verb];
      if (run !== undefined) census[arm][verb] = rows[verb].censusOf(run.document);
    }
  }
  return census;
}

/**
 * The unseeded gate's assertion: no divergence, and a zero census in every arm.
 *
 * @param result - The recorded runs
 */
export function expectNoDivergenceAndNoRefusal(result: DifferentialResult): void {
  // BLOB_NOT_TEXT is exempt from the census (a binary at an untyped path is no absence), but the
  // gate fixture is all text: a row here is the sniffer calling a text file binary.
  for (const arm of result.arms) {
    const dump = result.measured[arm].query;
    const notText = dump === undefined ? [] : absenceRowsOf(dump.document).rows.blobConditions.filter((row) => row.code === BLOB_NOT_TEXT);
    expect(notText, `${arm}: a BLOB_NOT_TEXT row over the all-text gate fixture`).toEqual([]);
  }
  expect(divergences(result)).toEqual([]);
  const zero = Object.fromEntries(result.verbs.map((verb) => [verb, { rows: {}, findings: {} }]));
  const census = censusOf(result);
  for (const arm of result.arms) expect(census[arm], `${arm}'s refusal census`).toEqual(zero);
}

/**
 * The path-scoped columns a hole moves, by relation: the realization's key for the
 * bytes, and the extent digest, which is total over the realizations and so moves
 * with that key. Everything else in these relations must hold.
 */
export const HOLE_MOVED_COLUMNS: Readonly<Record<string, string>> = {
  resource_realizations: 'contentKey',
  zone_provenance: 'extentDigest',
};

/**
 * A dump's rows of one relation with one column dropped, so two dumps can be held
 * equal in everything else.
 *
 * @param document - A dump
 * @param relation - The relation
 * @param column - The column dropped
 * @returns The rows, parsed, without the column
 */
function rowsWithoutColumn(document: Record<string, unknown>, relation: string, column: string): unknown[] {
  return (rowsByRelation(document).get(relation) ?? []).map((row) => withoutKey(JSON.parse(row) as Record<string, unknown>, column));
}

function expectDiverges(result: DifferentialResult, expected: { relations: readonly string[]; verbs: readonly VerbName[] }): void {
  for (const name of expected.relations) expect(RELATION_NAMES.has(name), `${name} is no relation`).toBe(true);
  const found = divergences(result);
  expect({
    verbs: [...new Set(found.map((divergence) => divergence.verb))].sort((a, b) => a.localeCompare(b)),
    relations: [...new Set(found.flatMap((divergence) => divergence.relations))].sort((a, b) => a.localeCompare(b)),
  }).toEqual({
    verbs: [...expected.verbs].sort((a, b) => a.localeCompare(b)),
    relations: [...expected.relations].sort((a, b) => a.localeCompare(b)),
  });
}

/**
 * A refusal seed's judgment, in order:
 *
 * 1. the reference arm's dump holds a row of the cause's own signature, before any census;
 * 2. every sibling (a member whose surfaced codes overlap the cause's, derived, never listed) has
 *    zero rows in every arm;
 * 3. every refusing finding of every other verb carries a code the cause itself surfaces under
 *    (its group alone would admit a sibling's code);
 * 4. the census, exactly: the dump counts the cause's rows and nothing else, and every other verb
 *    counts only the cause's group, every other group and every ungrouped refusal at zero;
 * 5. no arm diverges from the reference.
 *
 * @param result - The recorded runs
 * @param expected - The cause and each verb's count
 */
function expectRefuses(result: DifferentialResult, expected: { cause: AbsenceMember; perVerb: Readonly<Partial<Record<VerbName, number>>> }): void {
  const reference = result.measured.storeOff.query;
  if (reference === undefined) throw new Error(`a refusal seed of ${expected.cause} must run the query: its rows are the evidence`);
  expectAbsenceCause(absenceRowsOf(reference.document).rows, memberEntry(expected.cause).signature);
  const census = censusOf(result);
  for (const arm of result.arms) {
    for (const sibling of siblingsOf(expected.cause)) {
      expect(census[arm].query?.rows[sibling] ?? 0, `${arm}: rows of ${expected.cause}'s sibling ${sibling}`).toBe(0);
    }
  }
  const surfaced = new Set(surfacedCodesOf(expected.cause));
  for (const arm of result.arms) {
    for (const verb of result.verbs.filter((name) => name !== 'query')) {
      const run = result.measured[arm][verb];
      const foreign = run === undefined ? [] : result.rows[verb].refusingCodesOf(run.document).filter((code) => !surfaced.has(code));
      expect(foreign, `${arm} ${verb}: refusing findings ${expected.cause} does not surface under`).toEqual([]);
    }
  }
  const wanted = Object.fromEntries(result.verbs.map((verb) => {
    const count = expected.perVerb[verb] ?? 0;
    const counted = count === 0 ? {} : { [verb === 'query' ? expected.cause : groupOf(expected.cause)]: count };
    return [verb, verb === 'query' ? { rows: counted, findings: {} } : { rows: {}, findings: counted }];
  }));
  for (const arm of result.arms) expect(census[arm], `${arm}'s absence census`).toEqual(wanted);
  // Both arms refused the same; anything else they answered must agree too.
  expect(divergences(result)).toEqual([]);
}

function expectAgreesAndMisses(result: DifferentialResult, arm: ArmName): void {
  for (const verb of result.verbs) {
    const run = result.measured[arm][verb];
    if (run === undefined) throw new Error(`no ${arm} run of ${verb}`);
    expect(storeCharges(run), `${arm} ${verb} must miss and write`).toContain(CRAWL_STORE_WRITE_ID);
    expectOrigin(run, 'derived');
  }
  expect(divergences(result)).toEqual([]);
}

function expectDocumentsHole(result: DifferentialResult, arm: ArmName): void {
  const blobScoped = new Set(DUMPED_RELATIONS.filter((relation) => relation.blobScoped).map((relation) => relation.name));
  for (const verb of result.verbs) {
    const run = result.measured[arm][verb];
    if (run === undefined) throw new Error(`no ${arm} run of ${verb}`);
    expect(storeCharges(run), `${arm} ${verb} must be served`).toEqual([CRAWL_STORE_READ_ID]);
    expectOrigin(run, 'store');
  }
  const found = divergences(result).filter((divergence) => divergence.arm === arm);
  expect(found.length, 'the hole shows: the warm run serves the previous bytes\' facts').toBeGreaterThan(0);
  for (const divergence of found) {
    expect(divergence.verb).toBe('query');
    expect(divergence.relations.filter((name) => !Object.hasOwn(HOLE_MOVED_COLUMNS, name) && !blobScoped.has(name))).toEqual([]);
  }
  const reference = result.measured.storeOff.query;
  const warm = result.measured[arm].query;
  const primed = result.runs[`${arm}:prime`]?.query;
  if (reference === undefined || warm === undefined || primed === undefined) {
    throw new Error('documentsHole needs the dump in both arms and the warm arm\'s prime');
  }
  // What the hole is: the tree hash did not move, so the warm run is served exactly what its prime
  // derived, byte for byte. Any other difference in a blob-scoped relation is not this hole.
  const normalized = (run: RunRecord): string => JSON.stringify(result.rows.query.normalize(run.document));
  expect(normalized(warm), `${arm} serves exactly its prime's dump`).toBe(normalized(primed));
  for (const [relation, column] of Object.entries(HOLE_MOVED_COLUMNS)) {
    expect(rowsWithoutColumn(warm.document, relation, column), `${relation} beyond ${column}`)
      .toEqual(rowsWithoutColumn(reference.document, relation, column));
  }
}

/**
 * A seed's expectation, then its consumed runs.
 *
 * @param seed - The seed
 * @param result - Its recorded runs
 */
export function expectSeed(seed: I0Seed, result: DifferentialResult): void {
  const expectation = seed.expect;
  if ('diverges' in expectation) expectDiverges(result, expectation.diverges);
  else if ('refuses' in expectation) expectRefuses(result, expectation.refuses);
  else if ('agreesAndMisses' in expectation) expectAgreesAndMisses(result, expectation.agreesAndMisses.arm);
  else expectDocumentsHole(result, expectation.documentsHole.arm);
  const consumed: Partial<Record<RunLabel, Partial<Record<VerbName, RunRecord>>>> = {};
  for (const label of seed.consumed.runs) {
    const runs = result.runs[label];
    if (runs === undefined) throw new Error(`${seed.name} consumes ${label}, which no cell recorded`);
    consumed[label] = runs;
  }
  seed.consumed.check(consumed);
}

/**
 * The relations with no row in a dump, checked against {@link DECLARED_EMPTY} both ways.
 *
 * @param dump - A store-off dump of the gate fixture
 */
export function expectCoverage(dump: Record<string, unknown>): void {
  const grouped = rowsByRelation(dump);
  const empty = DUMPED_RELATIONS.map((relation) => relation.name).filter((name) => (grouped.get(name) ?? []).length === 0);
  expect(empty.toSorted((a, b) => a.localeCompare(b))).toEqual(Object.keys(DECLARED_EMPTY).toSorted((a, b) => a.localeCompare(b)));
}

// ── The gate fixture ────────────────────────────────────────────────────────

/** The heading the forged parse entry carries, which no real byte in the fixture holds. */
export const FORGED_SENTINEL = 'Forged Sentinel Heading';

/** The fixture's committed files. */
export const GATE_FIXTURE: Readonly<Record<string, string>> = {
  'docs/one.md': '---\ntitle: One\ntags: [alpha]\n---\n# One\n\nSee [two](./two.md#two) and [the page](./page.html).\n\n## Detail\n\nBack to [the guide](guide.md#guide).\n',
  'docs/two.md': '# Two\n\nA page with no links.\n',
  // A reference-style link with no definition: a `blob_conditions` row (a finding, not a refusal).
  'docs/guide.md': '# Guide\n\nRead [one](./one.md#detail) and [the spec][spec-ref].\n',
  'docs/page.html': '<!DOCTYPE html>\n<html><head><title>Page</title></head><body><a href="one.md">one</a></body></html>\n',
  'CLAUDE.md': '# Corpus\n\nProject notes.\n\n@docs/guide.md\n',
  '.claude/rules/docs.md': '---\npaths: ["docs/**"]\n---\n# Docs rule\n\nKeep [the guide](../../docs/guide.md) current.\n',
  'vibe-agent-toolkit.config.yaml': [
    'resources:',
    '  checks:',
    '    doc-titles:',
    '      description: Every top-level heading, as a row',
    "      sql: \"SELECT r.path AS path, s.title AS title FROM blob_sections s JOIN resource_realizations r ON r.contentKey = s.blob WHERE s.depth = 1 ORDER BY r.path\"",
    '      severity: warning',
    '    link-targets:',
    '      description: Every authored link and where it resolves',
    "      sql: \"SELECT e.src AS src, x.dstKey AS dstKey, x.dstAnchor AS dstAnchor FROM edges e JOIN edge_resolutions x ON x.src = e.src AND x.refOrdinal = e.refOrdinal AND x.contextId = e.contextId ORDER BY e.src, x.dstKey\"",
    '      severity: warning',
    '',
  ].join('\n'),
};

/** Written after the commit, so `changed_files` has a row under `--base HEAD`. */
const GATE_UNTRACKED: Readonly<Record<string, string>> = {
  'docs/notes.md': '# Notes\n\nNot committed yet.\n',
};

/**
 * The gate subject: the fixture, committed, plus one untracked file.
 *
 * @param corpus - The corpus path every arm measures at
 * @returns The subject
 */
export function gateSubject(corpus: string): Subject {
  return {
    corpus,
    write: (git) => {
      writeFileTree(corpus, GATE_FIXTURE);
      git(['init', '-q', '-b', 'main']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'fixture']);
      writeFileTree(corpus, GATE_UNTRACKED);
    },
  };
}

/**
 * A fixed subject: a `git clone --local --shared --no-checkout` of `source`'s HEAD at `corpus`,
 * taken under a git config confined to a scratch directory (the source alone
 * trusted as a `safe.directory`), with
 * `core.autocrlf=false` (and `core.longpaths=true` on Windows) written into the
 * clone's own config, so the checkout and every arm's run read the bytes alike
 * whatever the host's git config says. The clone is taken without a checkout and
 * only `keep` is checked out and committed (the rest leaves the index, never
 * touching disk), so the subject is a clean repository whose HEAD holds exactly
 * the kept paths; a kept path HEAD lacks fails the checkout.
 *
 * @param source - The repository cloned
 * @param corpus - Where the clone goes, the path every arm measures at
 * @param keep - The root-relative paths (files or directories) the subject keeps
 * @returns The subject and how many files it tracks
 */
export function clonedSubject(source: string, corpus: string, keep: readonly string[]): { subject: Subject; tracked: number } {
  const scratch = createIsolatedScratch('vat-i0-clone-');
  cellRoots.push(scratch);
  const env = isolatedGitEnv(scratch);
  const config = ['core.autocrlf=false', ...(process.platform === 'win32' ? ['core.longpaths=true'] : [])];
  const configArgs = config.flatMap((entry) => ['--config', entry]);
  // The confined global config drops any safe.directory the operator or CI set, so the source is
  // trusted for this one command: git reads safe.directory from protected config only, which takes in
  // `-c` (git 2.39 and later) and never a repository's own config.
  runGitOrThrow(['-c', `safe.directory=${toForwardSlash(source)}`, 'clone', '-q', '--no-checkout', '--local', '--shared', ...configArgs, source, corpus], { env });
  const git = cellGit(corpus, env);
  git(['checkout', 'HEAD', '--', ...keep]);
  git(['commit', '-q', '--no-verify', '-m', 'subset']);
  const tracked = git(['ls-files', '-z']).split('\0').filter((path) => path !== '').length;
  return { subject: { corpus, write: undefined }, tracked };
}

/**
 * A dump's `resource_realizations` row for one path, parsed.
 *
 * @param run - A dump run
 * @param path - The root-relative path
 * @returns The rows realizing it
 */
export function realizationsOf(run: RunRecord | undefined, path: string): Array<Record<string, unknown>> {
  if (run === undefined) throw new Error('no such run recorded');
  return (rowsByRelation(run.document).get('resource_realizations') ?? [])
    .map((row) => JSON.parse(row) as Record<string, unknown>)
    .filter((row) => row['path'] === path);
}

/**
 * Read a file in the corpus as bytes, for a seed that keys or inspects it.
 *
 * @param corpus - The corpus
 * @param path - The root-relative path
 * @returns The bytes
 */
export function corpusBytes(corpus: string, path: string): Buffer {
  return readFileSync(safePath.join(corpus, path));
}

// ── Seed suites ─────────────────────────────────────────────────────────────

/**
 * How a seed's test reads. A hole seed says what closes it, so the day it goes
 * red the reader knows which change rewrites it to `agreesAndMisses`.
 *
 * @param seed - The seed
 * @returns The test title
 */
export function seedTitle(seed: I0Seed): string {
  const expectation = seed.expect;
  if ('documentsHole' in expectation) return `${seed.name} documents the hole: closed by ${expectation.documentsHole.closedBy}`;
  return `${seed.name}: ${Object.keys(expectation)[0] ?? ''}`;
}

/**
 * Give the owner full access to every directory under `directory` that a plant
 * left closed (a mode-000 directory), so the tree can be removed whatever
 * happened to the seed's own restore.
 *
 * @param directory - A tree root; absent is nothing to do
 */
export function restoreDirectoryModes(directory: string): void {
  if (!existsSync(directory)) return;
  const { mode } = lstatSync(directory);
  if ((mode & 0o700) !== 0o700) chmodSync(directory, mode | 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // A link is not followed: its target is not this tree's to open.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) restoreDirectoryModes(safePath.join(directory, entry.name));
  }
}

/** A seed file's suite: its hooks, and one seed run over a fresh gate fixture and judged. */
interface SeedSuite {
  readonly setup: () => void;
  readonly cleanup: () => void;
  /** Runs and judges the seed; resolves to the arms it ran, which must be the seed's own. */
  readonly run: (seed: I0Seed) => Promise<readonly ArmName[]>;
}

/**
 * The suite a seed file runs its seeds in.
 *
 * @param testFileUrl - The calling file's `import.meta.url`, which locates the CLI build
 * @returns The suite
 */
export function seedSuite(testFileUrl: string): SeedSuite {
  const context = createSuiteContext('vat-i0-seed-', testFileUrl);
  const tempDirs: string[] = [];
  return {
    setup: context.setup,
    cleanup: () => {
      for (const tempDir of tempDirs) restoreDirectoryModes(tempDir);
      removeCells();
      context.cleanup();
    },
    run: async (seed) => {
      const tempDir = context.createTempDir();
      tempDirs.push(tempDir);
      const subject = gateSubject(safePath.join(tempDir, 'corpus'));
      const result = await runDifferential({ binPath: context.binPath, subject }, seed);
      expectSeed(seed, result);
      return result.arms;
    },
  };
}
