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
 * one, warm was served by one, and partial eviction (warm with part of the blob
 * tier deleted) re-derived every key it lost. And the divergence seed plants a wrong cache
 * entry the comparison must catch, by relation, exactly.
 *
 * ## One cell per (arm, verb)
 *
 * Every verb runs in a cell of its own: fresh arm directories, the fixture
 * rewritten at the one corpus path, the seed's state A, the arm's `prepare`
 * (a warm arm primes here, under A), the seed's `toB`, then the one measured
 * run. A cold arm that ran every verb in one directory would be cold for the
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
 *
 * ## Arms are compared by content, not by key
 *
 * Store-off keys every file by the sha256 of its working-tree bytes; a store-on run keys a
 * tracked regular file by its git object ID and reads git's stored bytes (eol-normalized,
 * clean-filtered). So a dump's content keys are compared by what they name: each git key is
 * rewritten to the sha256 key of its object's bytes ({@link RunRecord.objectContent}, read when
 * the run is recorded, while its cell's repository holds the object), and a relation's rows are
 * compared as a set, so a tracked file and an untracked copy with equal bytes collapse to one
 * blob as they do store-off. The extent digest, a digest over the keys, is not comparable
 * across arms and is dropped from that comparison.
 */

import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { devNull } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { DEFAULT_BLOB_TIER_BUDGET_BYTES, DEFAULT_ROW_SET_TIER_BUDGET_BYTES, openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import {
  ALL_BLOB_REQUEST,
  BLOB_NOT_TEXT,
  BLOB_PARSE_LIMIT_EXCEEDED,
  BLOB_PARSE_WORKER_DIED,
  computeContentKey,
  type ContentKey,
  contentKeyParts,
  contentRoute,
  isProjectionTable,
  parseContentKey,
  type ParserKind,
  PROJECTION_TABLES,
  type QueryableRelationSpec,
  queryableRelationSpecs,
  quoteIdentifier,
  readContentWithKey,
  storedRelationSpecs,
  uncoveredContentKeys,
} from '@vibe-agent-toolkit/resources';
import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import {
  CRAWL_STORE_READ_ID,
  CRAWL_STORE_WRITE_ID,
  isPathAbsentError,
  isUnderRoot,
  mkdirSyncReal,
  relativeEscapesRoot,
  safePath,
  toForwardSlash,
  WORK_COUNTERS_ENV,
  type WorkCounter,
  type WorkCounterDump,
  VAT_CACHE_DIR_ENV,
} from '@vibe-agent-toolkit/utils';
import { frameBatchRecord, runGitBytes, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { expectAbsenceCause, parseLookupsIn, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { StatedLimitSchema } from '../../src/commands/resources/check-schema.js';
import { reportShapeFor } from '../../src/report-schemas.js';
import { PROJECTION_STORE_ENV, PROJECTION_STORE_OFF, PROJECTION_STORE_SQLITE } from '../../src/utils/projection-store.js';
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
type ArmName = 'storeOff' | 'cold' | 'warmSameHistory' | 'partialEviction';

/**
 * The verbs the harness runs; `query` is the dump. `validate` is `vat resources validate`;
 * `vatValidate` is the top-level `vat validate`, whose phases fold that report, the checks
 * child's and (when configured) the skills report into one.
 */
type VerbName = 'validate' | 'check' | 'query' | 'context' | 'vatValidate';

/** A recorded run: the warm arm's prime, a seed's unmeasured intermediate run, or any arm's measured run. */
type RunLabel = `${ArmName}:${'prime' | 'intermediate' | 'measured'}`;

// ── The dump ────────────────────────────────────────────────────────────────

/** A relation `vat resources query` exposes, and its columns in declaration order. */
interface DumpedRelation {
  readonly name: string;
  readonly columns: readonly string[];
  /** Whether a row is a pure function of a blob's bytes: see {@link isBlobScoped}. */
  readonly blobScoped: boolean;
}

/**
 * Whether a relation's rows are a pure function of a blob's bytes: a blob-scoped projection table,
 * and every row-set table (keyed by the blob it was read from). A derived relation never is.
 *
 * @param spec - A queryable relation
 * @returns True when its rows depend on one blob's bytes alone
 */
function isBlobScoped(spec: QueryableRelationSpec): boolean {
  if (spec.kind === 'projection') return spec.scope === 'blob';
  return spec.kind === 'rowSet';
}

/** Every relation a statement can name: stored (projection and row-set) and derived, from the one list. */
export const DUMPED_RELATIONS: readonly DumpedRelation[] = queryableRelationSpecs()
  .map((spec) => ({ name: spec.name, columns: spec.columns, blobScoped: isBlobScoped(spec) }));

/** Every relation name, for checking a name an expectation or a map spells. */
export const RELATION_NAMES: ReadonlySet<string> = new Set(DUMPED_RELATIONS.map((relation) => relation.name));

/**
 * One relation's rows as JSON text: `json_object('<column>', "<column>", ...)`.
 *
 * @param relation - The relation
 * @returns The SQL expression, its column names quoted identifiers
 */
function rowObjectSql(relation: DumpedRelation): string {
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
const DUMP_SQL = dumpSqlOf(DUMPED_RELATIONS);

/**
 * A dump over some relations: their rows as `(relation, row)` pairs, ordered by both. For a subject
 * whose statement must leave a relation out (one a seed refuses, which would refuse the whole dump).
 *
 * @param relations - The relations
 * @returns The statement
 */
export function dumpSqlOf(relations: readonly DumpedRelation[]): string {
  return relations.map((relation) => relationRowsSql(relation)).join(' UNION ALL ') + ' ORDER BY relation, row';
}

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

/**
 * One relation's rows in a dump, in their printed order.
 *
 * @param document - A `vat resources query` document over a `(relation, row)` statement
 * @param relation - The relation
 * @returns Its rows' JSON text; empty when the dump holds none
 */
export function relationRows(document: Record<string, unknown>, relation: string): readonly string[] {
  return rowsByRelation(document).get(relation) ?? [];
}

function dumpRows(document: Record<string, unknown>): readonly DumpRow[] {
  const data = document['data'] as { rows?: readonly DumpRow[] } | null | undefined;
  return data?.rows ?? [];
}

/**
 * Why the gate fixture leaves every `data__*` relation empty: it routes no JSON file. Those
 * relations get the same store-off, cold, warm, eviction and warm-after-edit differential, with a
 * census that requires rows in each, over their own corpus (`data-rows-differential.system.test.ts`).
 */
const DATA_RELATIONS_ELSEWHERE = 'The gate fixture routes no JSON file; data-rows-differential.system.test.ts runs the data relations\' differential over a corpus that fills each.';

/** Why the gate fixture leaves every `workspace_*` relation empty: it holds no `package.json`. */
const WORKSPACE_RELATIONS_ELSEWHERE = 'The gate fixture holds no package.json, so it declares no workspace; workspace-rows-differential.system.test.ts runs the workspace relations\' differential over corpora that fill each.';

/**
 * Relations with no row in a store-off dump of the gate fixture, each with why.
 * Held both ways: a listed relation that gains rows reds as surely as an unlisted
 * one with none.
 */
export const DECLARED_EMPTY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(DUMPED_RELATIONS.filter((relation) => relation.name.startsWith('data__')).map((relation) => [relation.name, DATA_RELATIONS_ELSEWHERE])),
  ...Object.fromEntries(DUMPED_RELATIONS.filter((relation) => relation.name.startsWith('workspace_')).map((relation) => [relation.name, WORKSPACE_RELATIONS_ELSEWHERE])),
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
export function absenceRowsOf(document: Record<string, unknown>): ReturnType<typeof absenceRowsOfDump> {
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
  // The orchestrator's wall clock, and each phase's per-run fields where its own verb's row drops
  // them: the resources phase's `population`, the checks child's populations and timings.
  vatValidate: [
    'durationMs',
    'data.phases[].data.population',
    'data.phases[].data.populationSecs',
    'data.phases[].data.lensSecs',
    'data.phases[].data.lensPopulation',
    'data.phases[].data.checks[].durationSecs',
  ],
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

/** A verb whose document is JSON on stdout (`--format json`). */
const parseJson = (stdout: string): unknown => JSON.parse(stdout);

/** The population fields a document's `data` says its answer came from. */
const ORIGIN_FIELDS = ['population', 'lensPopulation'] as const;

/**
 * Where a one-population verb says its answer came from: `data.population`, and
 * `data.lensPopulation` for a verb that reports its lenses' own populations.
 *
 * @param document - The parsed document
 * @returns Each origin field the document carries, by name
 */
function dataOrigins(document: Record<string, unknown>): Record<string, unknown> {
  const data = document['data'];
  if (typeof data !== 'object' || data === null) return {};
  const record = data as Record<string, unknown>;
  return Object.fromEntries(ORIGIN_FIELDS.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]));
}

/**
 * Where `vat validate` says its answer came from: the origin fields of its FIRST phase
 * that reports one, named `<phase>.<field>`. Only that phase can tell the arms apart.
 * Every later phase that populates (the checks phase, a child process with its own
 * population) asks the same question after the first phase has answered it, so with a
 * store on it is served what the first phase wrote: a cold run's checks phase reports
 * `store`, by design (`commands/validate.ts`). Its origin is per-run, normalized away
 * with the rest ({@link PER_RUN_FIELDS}); its store charges still reach the arm's tell.
 *
 * @param document - The orchestrator's document
 * @returns The first reporting phase's origin fields
 */
function phaseOrigins(document: Record<string, unknown>): Record<string, unknown> {
  const data = document['data'] as { phases?: readonly { name: string; data?: unknown }[] } | null | undefined;
  for (const phase of data?.phases ?? []) {
    const origins = Object.entries(dataOrigins({ data: phase.data }));
    if (origins.length > 0) return Object.fromEntries(origins.map(([field, value]) => [`${phase.name}.${field}`, value]));
  }
  return {};
}

/** One verb the harness runs, and everything it is judged by. */
export interface VerbRow {
  readonly name: VerbName;
  readonly args: readonly string[];
  /** Reads the document off stdout, in the format the verb writes it. */
  readonly parse: (stdout: string) => unknown;
  /** Where the run says its answer came from, by field: what an arm's tell holds to its origin. */
  readonly originsOf: (document: Record<string, unknown>) => Record<string, unknown>;
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
    parse: parseJson,
    originsOf: dataOrigins,
    schema: reportShapeFor('resources query').schema,
    normalize: (document) => normalizeDocument('query', document),
    censusOf: queryCensus,
    refusingCodesOf: (document) => reportTally(document).codes,
  };
}

/** The verbs, query as the dump. */
export const VERBS: { readonly [Name in VerbName]: VerbRow } = {
  validate: {
    name: 'validate',
    args: ['resources', 'validate', '--format', 'json'],
    parse: parseJson,
    originsOf: dataOrigins,
    schema: reportShapeFor('resources validate').schema,
    normalize: (document) => normalizeDocument('validate', document),
    censusOf: reportCensus,
    refusingCodesOf: (document) => reportTally(document).codes,
  },
  check: {
    name: 'check',
    args: ['resources', 'check', '--format', 'json'],
    parse: parseJson,
    originsOf: dataOrigins,
    schema: reportShapeFor('resources check').schema,
    normalize: (document) => normalizeDocument('check', document),
    censusOf: reportCensus,
    refusingCodesOf: (document) => reportTally(document).codes,
  },
  query: queryVerb(DUMP_SQL),
  context: {
    name: 'context',
    args: ['claude', 'context', '.', '--format', 'json'],
    parse: parseJson,
    originsOf: dataOrigins,
    schema: CONTEXT_DOCUMENT_SCHEMA,
    normalize: (document) => normalizeDocument('context', document),
    censusOf: contextCensus,
    refusingCodesOf: (document) => contextTally(document).codes,
  },
  // `vat validate` offers no `--format`: its document is YAML. Its findings are every phase's, flat
  // and in phase order, and the comparison holds them, their order and the exit code to store-off's.
  // `--base HEAD` reaches only the checks phase, so a check reading `changed_files` answers rather
  // than breaks, as `query`'s does.
  vatValidate: {
    name: 'vatValidate',
    args: ['validate', '--base', 'HEAD'],
    parse: (stdout) => parseYaml(stdout) as unknown,
    originsOf: phaseOrigins,
    schema: reportShapeFor('validate').schema,
    normalize: (document) => normalizeDocument('vatValidate', document),
    censusOf: reportCensus,
    refusingCodesOf: (document) => reportTally(document).codes,
  },
};

/** Every verb, in the order a cell sequence runs them: the keys of {@link VERBS}, so none is skipped. */
export const VERB_NAMES = Object.keys(VERBS) as readonly VerbName[];

/** The verb rows a subject runs: {@link VERBS}, with any the subject states over them. */
type VerbRows = Readonly<Record<VerbName, VerbRow>>;

// ── Arms ────────────────────────────────────────────────────────────────────

/** One cell's private directories: `createIsolatedScratch`'s home and tmp, plus the store and timing dumps. */
export interface ArmDirs {
  readonly root: string;
  readonly tmp: string;
  readonly home: string;
  readonly store: string;
  readonly timing: string;
  /** Where this build keeps its parse cache under `store` (the cell's `VAT_CACHE_DIR`), asked of the build. */
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
  /** Where the run says its answer came from, read by its verb's row ({@link VerbRow.originsOf}). */
  readonly origins: Readonly<Record<string, unknown>>;
  /** Every contributor the run charged, from its own timing directory. */
  readonly charged: readonly string[];
  /** Every CLI process's work-counter dump, from the run's own directory (`VAT_WORK_COUNTERS`). */
  readonly work: readonly WorkCounterDump[];
  /** The store's extent manifest just before the run ({@link extentManifest}): what tells the oracle which extent is the run's. */
  readonly extentsBefore: readonly string[];
  /** The cell it ran in, the corpus it ran over, and the environment it ran git under. */
  readonly cell: { readonly dirs: ArmDirs; readonly corpus: string; readonly env: Readonly<Record<string, string>> };
  /**
   * Each git-kind content key the run's dump names, to the sha256 key of the bytes its object
   * holds: read from the cell's repository right after the run, while it holds the object.
   */
  readonly objectContent: ReadonlyMap<string, string>;
}

/** What an arm's `prepare` may do besides touching the corpus: run the subject's query, recorded as this cell's prime. */
type Prime = () => Promise<RunRecord>;

/** A run's positive tell. */
type Tell = (run: RunRecord, dirs: ArmDirs) => void;

/** One way a run reaches the store. */
interface Arm {
  readonly env: (dirs: ArmDirs) => Record<string, string>;
  /**
   * After the fixture and state A; returns the prime it ran, if any, having held `primeTell` on it
   * (the cold tell, unless the seed declares the store declines the prime).
   */
  readonly prepare: (dirs: ArmDirs, corpus: string, git: Git, prime: Prime, primeTell: Tell) => Promise<RunRecord | undefined>;
  /** The positive tell, asserted on every measured run the seed does not claim. */
  readonly tell: Tell;
}

/** The prefix of every charge the store itself files (`CRAWL_STORE_READ_ID`, `CRAWL_STORE_WRITE_ID`). */
const STORE_CHARGE_PREFIX = CRAWL_STORE_READ_ID.slice(0, CRAWL_STORE_READ_ID.indexOf(':') + 1);

/** The store's own charges, in charge order. */
function storeCharges(run: RunRecord): string[] {
  return run.charged.filter((id) => id.startsWith(STORE_CHARGE_PREFIX));
}

/**
 * Where a run says its answer came from, every origin field its verb's row reads
 * ({@link VerbRow.originsOf}). A lens population of `'none'` (no lens the statement
 * reached populates a lane of its own) carries no origin to judge; whether the arm
 * still answered alike is the compared document's to say.
 *
 * @param run - The run
 * @param origin - Where this arm's answer must have come from
 */
function expectOrigin(run: RunRecord, origin: 'derived' | 'store'): void {
  for (const [field, value] of Object.entries(run.origins)) {
    if (field.endsWith('lensPopulation') && value === 'none') continue;
    expect(value, `${run.label} ${run.verb} ${field}`).toBe(origin);
  }
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
    [VAT_CACHE_DIR_ENV]: dirs.store,
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

/** What the operator is told when git's index hides files from the tree key (`GIT_SNAPSHOT_INDEX_HIDES`). */
const INDEX_HIDES_NOTICE = 'this tree cannot be keyed';

/**
 * A store-on run whose tree git declined to key: it says why, opens no store,
 * charges none of it, and derives everything, as store-off does.
 */
function declinedTell(run: RunRecord, dirs: ArmDirs): void {
  expect(run.stderr, `${run.label} ${run.verb}: the decline was not told`).toContain(INDEX_HIDES_NOTICE);
  expect(storeFilesUnder(dirs.store), `${run.label} ${run.verb}: a declined run opened a store`).toEqual([]);
  expect(storeCharges(run), `${run.label} ${run.verb}`).toEqual([]);
  expectOrigin(run, 'derived');
}

// ── Partial eviction ────────────────────────────────────────────────────────

/** The blob-scoped tables, read off the registry, so a blob table added later is evicted too. */
const BLOB_TABLES = storedRelationSpecs().filter(isProjectionTable).filter((spec) => spec.scope === 'blob');

/**
 * The column a blob-scoped table is keyed by: its first primary-key column, which is
 * what the store keys every blob-tier select, delete and eviction on.
 *
 * @param spec - A blob-scoped table's registry entry
 * @returns The content-key column
 */
function contentKeyColumn(spec: (typeof BLOB_TABLES)[number]): string {
  const [first] = spec.primaryKey;
  if (first === undefined) throw new Error(`${spec.name} declares no primary key`);
  return first;
}

/** What a measured run does over a partly evicted blob tier: re-derive it, and where it says its answer came from. */
interface EvictionOutcome {
  /** Whether the run wrote, and so accounts for every evicted key again; otherwise it wrote nothing and accounts for none. */
  readonly rederives: boolean;
  /** Its {@link RunRecord.origins}, exactly. */
  readonly origins: Readonly<Record<string, unknown>>;
}

/**
 * Each verb's outcome under partial eviction, held exactly. An evicted key is one the
 * stored extent names and the blob tier does not account for, and ONE such key makes the
 * whole extent a miss for a population that projects the blob tier (`uncoveredContentKeys`,
 * ADR I10): it reads, misses, derives everything and writes it back. A resources registry
 * is served the extent and admits each member from its blob facts (`stored-admission.ts`),
 * so it reads the blob tier too, but per key: an evicted key is re-derived in memory for
 * that one file and nothing is written, so the eviction stays and the origin is `store`.
 *
 * - `validate` (`vat resources validate`) is a registry: served, the evicted keys re-derived in memory.
 * - `check`, `query` and `context` project the blob tier: re-derived. `query`'s lenses populate
 *   after its own population has written the extent back, so they are served.
 * - `vatValidate`: its resources phase is served, as `validate` is; its checks child
 *   projects the blob tier and re-derives it, which is the write.
 *
 * A store that serves the held keys around an evicted one rewrites this table.
 */
const EVICTION_OUTCOMES: { readonly [Name in VerbName]: EvictionOutcome } = {
  validate: { rederives: false, origins: { population: 'store' } },
  check: { rederives: true, origins: { population: 'derived', lensPopulation: 'none' } },
  query: { rederives: true, origins: { population: 'derived', lensPopulation: 'store' } },
  context: { rederives: true, origins: {} },
  vatValidate: { rederives: true, origins: { 'resources.population': 'store' } },
};

/**
 * How many store reads a served warm run makes: one per process that populates.
 * `vat validate` runs its checks phase as a child process, so it reads twice.
 */
const WARM_STORE_READS: { readonly [Name in VerbName]: number } = {
  validate: 1,
  check: 1,
  query: 1,
  context: 1,
  vatValidate: 2,
};

/** What an edit seed's measured verb runs in its counted scope ({@link populationCounts}). */
interface EditVerbScope {
  /** `store.reads.extent`, exactly. */
  readonly extentReads: number;
  /**
   * The populations it derives over the edited tree, `extent.derived` exactly. The first reads
   * the primed store, so it extracts the seed's uncovered keys; each later one runs after the
   * first has written the edited tree's blob facts, so it finds every key covered. One population
   * run shares one dispatcher, so parse lookups are the run's, not each population's.
   */
  readonly populations: number;
}

/**
 * Each verb an edit seed measures, and only those, measured on a one-file tracked edit of the
 * gate fixture over a build whose miss derives every key, each extent read traced to its call
 * site:
 *
 * - `vat validate` counts its parent's `resources` phase (its checks child is another process):
 *   the membership lane's `readStoredMembership` (a miss), then `populate`'s
 *   `readCachedProjection` (a miss, derived). One population.
 * - `vat resources query` is one process with no phases, so its counted scope is the process:
 *   the resources population's `populate` (a miss, derived and written), then the claude-context
 *   lens's `importRoots` `readStoredMembership` (the whole extent, under the lens's own key: its
 *   registry adds the `@`-import contributors, so its key differs; a miss). The lens's own
 *   `populate` reads nothing: the run's one reader holds that miss, so it derives over the same
 *   tree. Two populations; no phase separates them.
 *
 * A change that adds or drops a read or a population rewrites this table.
 *
 * Unproven until the stored tier is read on a miss: the `query` tell's `(populations - 1) *
 * distinct keys` term of `blob.storeServed` assumes the lens population's keys equal the resources
 * population's. If its `@`-import contributors add keys, restate the term from a measured run.
 */
const EDIT_VERBS = {
  query: { extentReads: 2, populations: 2 },
  vatValidate: { extentReads: 2, populations: 1 },
} as const satisfies Partial<Record<VerbName, EditVerbScope>>;

/** A verb an edit seed measures: one {@link EDIT_VERBS} holds. */
function isEditVerb(verb: VerbName): verb is keyof typeof EDIT_VERBS {
  return Object.hasOwn(EDIT_VERBS, verb);
}

/** Each cell's evicted content keys, from the arm's `prepare` to its measured run's tell. */
const evictedByCell = new Map<string, readonly string[]>();

/** Each `editServed` cell's uncovered keys, computed from the primed store before its measured run. */
const uncoveredByCell = new Map<string, readonly string[]>();

/** Each `editServed` cell's refused keys: the uncovered keys no run can file. */
const refusedByCell = new Map<string, readonly string[]>();

/** Each `editServed` cell's keys of the new tree its store does not cover after the measured run. */
const uncoveredAfterByCell = new Map<string, readonly string[]>();

/**
 * Run `body` against the cell's one projection store, opened read-write, then close it.
 *
 * @param dirs - The cell
 * @param body - What to do with the open database
 * @returns What `body` returned
 */
function withStore<T>(dirs: Pick<ArmDirs, 'store'>, body: (database: DatabaseSync) => T): T {
  const [file, ...others] = storeFilesUnder(dirs.store);
  if (file === undefined || others.length > 0) throw new Error(`expected one projection store under ${dirs.store}`);
  const database = new DatabaseSync(file);
  try {
    return body(database);
  } finally {
    database.close();
  }
}

/** Rows each blob-scoped table holds for one content key. */
function blobRowCounts(database: DatabaseSync, key: string): Record<string, number> {
  return Object.fromEntries(BLOB_TABLES.map((spec) => {
    const sql = `SELECT COUNT(*) AS n FROM ${quoteIdentifier(spec.name)} WHERE ${quoteIdentifier(contentKeyColumn(spec))} = ?`;
    return [spec.name, (database.prepare(sql).get(key) as { n: number }).n];
  }));
}

/** Whether the blob tier accounts for a key: a `blobs` row or a `blob_conditions` row at all. This is a presence probe, not the coverage rule: coverage is the one predicate (`uncoveredContentKeys`, over `BlobFactsReader.answer`). */
function accountedFor(database: DatabaseSync, key: string): boolean {
  const counts = blobRowCounts(database, key);
  return (counts[PROJECTION_TABLES.blobs.name] ?? 0) + (counts[PROJECTION_TABLES.blobConditions.name] ?? 0) > 0;
}

/**
 * Every keyed content key the stored realizations name, sorted.
 *
 * @param database - The primed cell's store
 * @returns The keys
 */
function keyedContentKeys(database: DatabaseSync): string[] {
  const realizations = quoteIdentifier(PROJECTION_TABLES.resourceRealizations.name);
  return (database
    .prepare(`SELECT DISTINCT "contentKey" AS key FROM ${realizations} WHERE "contentState" = 'keyed' ORDER BY "contentKey"`)
    .all() as { key: string }[]).map((row) => row.key);
}

/**
 * Evict a named subset of the blob tier the prime wrote: each given content key,
 * deleted from every blob-scoped table. Only the store's rows go: the parse cache
 * keeps its entries, so the measured run re-derives the evicted rows from parse
 * hits. The store's own `blob_keys` manifest is not a projection table and is
 * left: it orders eviction, and a re-derivation rewrites it.
 *
 * @param dirs - The primed cell
 * @param evicted - Keyed content keys of that cell to evict
 */
function evictBlobKeys(dirs: ArmDirs, evicted: readonly string[]): void {
  withStore(dirs, (database) => {
    const keyed = keyedContentKeys(database);
    expect(evicted.filter((key) => !keyed.includes(key)), 'evicted keys the prime never keyed').toEqual([]);
    const held = keyed.filter((key) => !evicted.includes(key));
    // Every key accounted for before, so it is the eviction that removes one.
    expect(keyed.filter((key) => !accountedFor(database, key)), 'keys the prime left unaccounted for').toEqual([]);
    database.exec('BEGIN IMMEDIATE');
    for (const spec of BLOB_TABLES) {
      const statement = database.prepare(`DELETE FROM ${quoteIdentifier(spec.name)} WHERE ${quoteIdentifier(contentKeyColumn(spec))} = ?`);
      for (const key of evicted) statement.run(key);
    }
    database.exec('COMMIT');
    const none = Object.fromEntries(BLOB_TABLES.map((spec) => [spec.name, 0]));
    for (const key of evicted) expect(blobRowCounts(database, key), `evicted ${key}`).toEqual(none);
    expect(held.filter((key) => !accountedFor(database, key)), 'held keys the eviction reached').toEqual([]);
  });
}

/** The skill-text tables: the facts row a markdown blob needs, and its match rows. */
const SKILL_TEXT_TABLES = [PROJECTION_TABLES.skillTextFacts, PROJECTION_TABLES.skillTextMatches] as const;

/** Whether the store holds a key's skill-text record: its one `skill_text_facts` row. */
function holdsSkillText(database: DatabaseSync, key: string): boolean {
  const facts = quoteIdentifier(PROJECTION_TABLES.skillTextFacts.name);
  return (database.prepare(`SELECT COUNT(*) AS n FROM ${facts} WHERE "blob" = ?`).get(key) as { n: number }).n > 0;
}

/** Every key whose skill-text record the store holds, sorted. */
function skillTextKeysIn(database: DatabaseSync): string[] {
  const facts = quoteIdentifier(PROJECTION_TABLES.skillTextFacts.name);
  return (database.prepare(`SELECT "blob" AS key FROM ${facts} ORDER BY "blob"`).all() as { key: string }[]).map((row) => row.key);
}

/**
 * Every key whose skill-text record the cell's store holds, read by raw SQL.
 *
 * @param dirs - A primed cell, or any cache directory holding one store
 * @returns The keys, sorted
 */
export function storedSkillTextKeys(dirs: Pick<ArmDirs, 'store'>): string[] {
  return withStore(dirs, skillTextKeysIn);
}

/**
 * Delete the skill-text rows of every other key that has them, in sorted order, by raw
 * SQL, and nothing else (a seed's plant, after a warm arm's prime): the key keeps its
 * `blobs` row and every other blob fact, so the store still accounts for it and serves
 * its resource facts, and only its skill-text record is gone. The writer never leaves a
 * markdown blob so, and the one blob-tier predicate (`uncoveredContentKeys`) calls such a
 * key uncovered: the next population that asks it (`vat validate`'s checks child)
 * re-derives the key and writes its record back, while the skills lane, which reads the
 * record and never repairs it, scans each file of such a key, as it does with no store.
 *
 * @param dirs - The primed cell, or any cache directory holding one store
 * @param mustEvict - Keys deleted whatever their place in the order: a case the caller needs evicted
 * @returns The keys whose skill-text rows were deleted
 */
export function evictHalfTheSkillText(dirs: Pick<ArmDirs, 'store'>, mustEvict: readonly string[]): string[] {
  return withStore(dirs, (database) => {
    const keys = skillTextKeysIn(database);
    expect(mustEvict.filter((key) => !keys.includes(key)), 'keys to evict that hold no skill-text record').toEqual([]);
    const evicted = keys.filter((key, index) => index % 2 === 0 || mustEvict.includes(key));
    expect(evicted.length, 'a skill-text eviction deletes a record').toBeGreaterThan(0);
    expect(keys.length - evicted.length, 'a skill-text eviction holds a record back').toBeGreaterThan(0);
    const others = (key: string): Record<string, number> => {
      const counts = blobRowCounts(database, key);
      for (const spec of SKILL_TEXT_TABLES) delete counts[spec.name];
      return counts;
    };
    const before = evicted.map((key) => others(key));
    database.exec('BEGIN IMMEDIATE');
    for (const spec of SKILL_TEXT_TABLES) {
      const statement = database.prepare(`DELETE FROM ${quoteIdentifier(spec.name)} WHERE "blob" = ?`);
      for (const key of evicted) statement.run(key);
    }
    database.exec('COMMIT');
    for (const key of evicted) expect(holdsSkillText(database, key), `skill text of ${key} deleted`).toBe(false);
    expect(evicted.map((key) => others(key)), 'every other blob fact of an evicted key kept').toEqual(before);
    expect(evicted.filter((key) => !accountedFor(database, key)), 'evicted keys still accounted for').toEqual([]);
    return evicted;
  });
}

/**
 * Every keyed realization the cell's store holds, by path: the content key each file's
 * bytes were filed under, read by raw SQL.
 *
 * @param dirs - A primed cell, or any cache directory holding one store
 * @returns Root-relative path to its content key
 */
export function storedContentKeys(dirs: Pick<ArmDirs, 'store'>): Map<string, ContentKey> {
  const realizations = quoteIdentifier(PROJECTION_TABLES.resourceRealizations.name);
  const rows = withStore(dirs, (database) => database
    .prepare(`SELECT DISTINCT "path", "contentKey" FROM ${realizations} WHERE "contentState" = 'keyed' ORDER BY "path"`)
    .all() as unknown as Array<{ path: string; contentKey: string }>);
  return new Map(rows.map((row) => [row.path, parseStoredKey(row.contentKey)]));
}

/**
 * A content key read back as text (a store row, a dump), parsed by the one parser.
 *
 * @param text - The key's text
 * @returns The key
 * @throws When the text is not a content key: a store or dump holding one is the defect
 */
function parseStoredKey(text: string): ContentKey {
  const key = parseContentKey(text);
  if (key === undefined) throw new Error(`not a content key: ${text}`);
  return key;
}

/**
 * Evict half the blob tier: every other keyed content key, in sorted order (the
 * first, third, fifth, ...). A content key is a digest, so which files that is is
 * arbitrary, but fixed for fixed bytes; and it is never all or none, so the store
 * holds an evicted key and a held one.
 *
 * @param dirs - The primed cell
 * @returns The evicted keys
 */
function evictHalfTheBlobTier(dirs: ArmDirs): string[] {
  const keyed = withStore(dirs, keyedContentKeys);
  const evicted = keyed.filter((_key, index) => index % 2 === 0);
  expect(keyed.length - evicted.length, 'a partial eviction holds a key back').toBeGreaterThan(0);
  evictBlobKeys(dirs, evicted);
  return evicted;
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
    prepare: async (dirs, _corpus, _git, prime, primeTell) => {
      const primed = await prime();
      primeTell(primed, dirs);
      return primed;
    },
    tell: (run) => {
      // Reads with no write. The read is charged for a miss too (it files from a `finally`), so only the
      // absent write proves a hit: a hit returns before anything is derived, and only a derivation is
      // written. Every verb hits after one query prime because every population a verb makes asks the
      // filesystem extent the same question (the ignored half declined), so one stored extent serves all.
      // One read per process that populates, counted exactly: a second read in one process is a
      // regression this arm must catch, and `vat validate`'s checks phase is a child with its own.
      expect(storeCharges(run), `${run.verb}: the warm run was not served by exactly its reads`)
        .toEqual(Array.from({ length: WARM_STORE_READS[run.verb] }, () => CRAWL_STORE_READ_ID));
      expectOrigin(run, 'store');
    },
  },
  partialEviction: {
    env: storeOnEnv,
    prepare: async (dirs, _corpus, _git, prime, primeTell) => {
      const primed = await prime();
      primeTell(primed, dirs);
      evictedByCell.set(dirs.root, evictHalfTheBlobTier(dirs));
      return primed;
    },
    tell: (run, dirs) => {
      const evicted = evictedByCell.get(dirs.root);
      if (evicted === undefined) throw new Error(`${run.verb}: no eviction recorded for this cell`);
      const expected = EVICTION_OUTCOMES[run.verb];
      const charges = storeCharges(run);
      expect(charges, `${run.label} ${run.verb}: the store was not read`).toContain(CRAWL_STORE_READ_ID);
      expect(charges.includes(CRAWL_STORE_WRITE_ID), `${run.label} ${run.verb}: wrote`).toBe(expected.rederives);
      const covered = withStore(dirs, (database) => evicted.filter((key) => accountedFor(database, key)));
      // Both ways: a re-deriving run accounts for every evicted key again, a served one for none.
      expect(covered, `${run.label} ${run.verb}: evicted keys accounted for after the run`).toEqual(expected.rederives ? evicted : []);
      expect(run.origins, `${run.label} ${run.verb} origins`).toEqual(expected.origins);
    },
  },
};

/** Every arm, read off {@link ARMS} so none is skipped. */
export const ARM_NAMES = Object.keys(ARMS) as readonly ArmName[];
if (ARM_NAMES[0] !== 'storeOff') throw new Error('ARMS must list store-off, the reference, first');

// ── Seeds ───────────────────────────────────────────────────────────────────

/** Which of a store-on cell's runs git declines to key. */
interface StoreDeclines {
  readonly prime: boolean;
  readonly measured: boolean;
}

/** What a seed must produce. */
type SeedExpectation =
  | { readonly diverges: { readonly relations: readonly string[]; readonly verbs: readonly VerbName[] } }
  /**
   * Every arm answers as store-off does: a plant the store must not mask. `storeDeclines` says which
   * store-on runs git declines to key (an index that hides files): a declined run is held to the
   * declined tell in place of its arm's, and a measured run after a declined prime to the cold tell,
   * since the prime filed nothing. `null` holds every arm to its own tell.
   */
  | { readonly agrees: { readonly because: string; readonly storeDeclines: StoreDeclines | null } }
  | { readonly refuses: { readonly cause: AbsenceMember; readonly perVerb: Readonly<Partial<Record<VerbName, number>>> } }
  | { readonly agreesAndMisses: { readonly arm: ArmName } }
  /**
   * Every arm answers as store-off does, and the seed's own consumed check holds `arm`'s
   * measured runs in place of that arm's tell: for a plant the store repairs, which the arm's
   * tell (a warm run only reads) would call a regression.
   */
  | { readonly agreesAndRepairs: { readonly arm: ArmName; readonly because: string } }
  /**
   * An edit the warm arm's miss serves from the stored blob tier: it extracts exactly the
   * keys `uncovered` names and reuses every other ({@link expectEditServed}). `uncovered` is
   * read off the primed store before the measured run: the new tree's keyed paths' keys the
   * store does not cover, plus every key the closure promotion adds outside the base's reads.
   * Before that run the harness holds the list to the store: each listed key is uncovered there
   * by the one predicate (`uncoveredContentKeys`), and each other key of the new tree covered.
   * An edit seed never moves `HEAD` (no commit, no checkout): `--base HEAD` would then name
   * another commit than the prime's. The harness asserts `HEAD` after `prepare` equals `HEAD`
   * just before the measured run.
   *
   * `refused` names the uncovered keys whose parse a run refuses at a limit or loses with its
   * worker: that refusal is filed nowhere (`storableBlobFacts` drops it, ADR I6), so the key stays
   * uncovered after every run, and no later population is served it from the store. The harness holds the
   * list both ways: to the refusal rows the store-off reference reports for the new tree before
   * the measured run, and to exactly the keys the store leaves uncovered after it.
   *
   * `storeOffReadsOtherBytes` is for an edit that makes git store other bytes than the disk
   * holds (a clean filter): store-on keys and parses git's bytes, store-off the disk's, so their
   * dumps differ by design. The arm must still exit and find as store-off does; only the dump
   * comparison is waived, and the reason is the value.
   */
  | {
    readonly editServed: {
      readonly arm: 'warmSameHistory';
      readonly uncovered: (dirs: ArmDirs, corpus: string) => readonly string[];
      readonly refused: (dirs: ArmDirs, corpus: string) => readonly string[];
      readonly storeOffReadsOtherBytes?: string;
    };
  }
  /**
   * The oracle's red proof: the arm's measured run is made to key the pre-edit tree, is served its
   * stale extent, and {@link expectEditOracle} alone must fail on it, naming `editedPath`. Nothing
   * else is asserted of the arm: a write, origin or agreement assertion would trip first.
   */
  | { readonly staleServed: { readonly arm: 'warmSameHistory'; readonly editedPath: string } }
  /**
   * A checkout change beneath one git tree (eol conversion, a filter): the bytes on disk move,
   * git's stored bytes do not. Store-on keys and reads git's bytes, so `arm` is served exactly
   * what its prime derived ({@link expectCheckoutStable}); store-off reads the working tree and
   * may differ in its dump, though never in which paths it realizes.
   *
   * `storeOffReads` says how the measured tree's disk bytes stand to git's, which decides what the
   * dump may differ in: `'git bytes'` when the checkout holds exactly git's stored bytes, so the
   * dumps agree outright; `{ otherBytes }` when it does not, so the dumps MUST differ, and only in
   * the blob-scoped relations, the {@link KEY_MOVED_COLUMNS} and the path-scoped relations named
   * in `parsedRelations`: those derived from what was parsed (a filter that stores a pointer in
   * place of the text leaves store-on no links to resolve). Required: only the seed knows.
   */
  | {
    readonly checkoutStable: {
      readonly arm: ArmName;
      readonly because: string;
      readonly storeOffReads: 'git bytes' | { readonly otherBytes: { readonly parsedRelations: readonly string[] } };
    };
  };

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
  /**
   * The arms it runs, store-off first. Required: an omitted list would run every arm of
   * {@link ARMS}, so a seed would silently grow every arm added later.
   */
  readonly arms: readonly ArmName[];
  /** Applied after the fixture is written. */
  readonly stateA?: (corpus: string, git: Git, dirs: ArmDirs) => Promise<void>;
  /**
   * Undoes a plant that would outlive the cell on the host (a directory's mode), so the
   * corpus can be removed: runs in a `finally` wrapping state A through the measured run.
   */
  readonly restore?: (corpus: string) => void;
  /**
   * After `arm.prepare`: a step the cell then runs the measured verb over once, unmeasured
   * (recorded as `<arm>:intermediate`), before `toB`. For an edit that must reach the store
   * before the measured edit does; a seed that uses it asserts its effect, so a dropped run reds.
   */
  readonly intermediate?: (arm: ArmName, dirs: ArmDirs, corpus: string, git: Git) => Promise<void>;
  /** After `arm.prepare` (and any intermediate run), before the measured run. */
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

/** Each build's parse directory, relative to the cache root it was asked under: asked once per build. */
const parseDirectoryUnderRoot = new Map<string, string>();

/**
 * Where the build at `binPath` keeps its parse cache in a cell: its own
 * `parseCacheDirectory()`, asked under the first cell's environment and accepted
 * only under that cell's cache root (`VAT_CACHE_DIR`). The build roots it there
 * under a name of its own, so a later cell's is that name under its own root,
 * with no spawn per cell.
 *
 * @param binPath - The CLI build
 * @param env - The cell's environment
 * @param cacheRoot - The cell's cache root
 * @returns The directory
 */
async function parseDirectoryOf(binPath: string, env: Record<string, string>, cacheRoot: string): Promise<string> {
  let relative = parseDirectoryUnderRoot.get(binPath);
  if (relative === undefined) {
    // `node --input-type=module -e <script> <entry>`: the entry is the script's argv[1].
    const entry = pathToFileURL(buildResourcesEntry(binPath)).href;
    const result = await executeCli(entry, [], { cwd: cacheRoot, env, nodeArgs: ['--input-type=module', '-e', PRINT_PARSE_DIRECTORY] });
    expect(result.status, result.stderr).toBe(0);
    const dir = toForwardSlash(result.stdout);
    expect(isUnderRoot(cacheRoot, dir), `the build's parse directory ${dir} is not under the cell's cache root ${cacheRoot}`).not.toBe('outside');
    relative = safePath.relative(cacheRoot, dir);
    // Lexically too, since later cells join this to their own root.
    expect(relativeEscapesRoot(relative), `the build's parse directory ${dir} is not spelled under the cell's cache root ${cacheRoot}`).toBe(false);
    parseDirectoryUnderRoot.set(binPath, relative);
  }
  return safePath.join(cacheRoot, relative);
}

/** Every cell directory made since the last {@link removeCells}. */
const cellRoots: string[] = [];

/** Remove every cell directory this process made; a suite's `afterAll`. */
export function removeCells(): void {
  for (const root of cellRoots.splice(0)) removeTempDir(root);
  evictedByCell.clear();
  uncoveredByCell.clear();
  refusedByCell.clear();
  uncoveredAfterByCell.clear();
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
  const parse = await parseDirectoryOf(binPath, baseEnv({ ...dirs, parse: '' }), dirs.store);
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

/**
 * Every CLI process's work-counter dump in a directory: the context-detecting
 * wrapper's are left out, since the work happens in the CLI.
 *
 * @param directory - The run's `VAT_WORK_COUNTERS` directory
 * @returns The dumps
 */
function workDumpsUnder(directory: string): WorkCounterDump[] {
  return readdirSync(directory)
    .map((name) => JSON.parse(readFileSync(safePath.join(directory, name), 'utf-8')) as WorkCounterDump)
    .filter((dump) => dump.role === 'cli');
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
      // Beside the timing directory, not in it: that one is read as charges.
      const work = safePath.join(options.dirs.timing, `${String(ordinal)}-work`);
      mkdirSyncReal(timing, { recursive: true });
      mkdirSyncReal(work, { recursive: true });
      const extentsBefore = extentManifest(options.dirs);
      const before = new Set(pathsUnder(options.dirs.root));
      const result = await executeCli(options.binPath, [...verb.args], {
        cwd: options.corpus,
        env: { ...options.env, VAT_CRAWL_TIMING: timing, [WORK_COUNTERS_ENV]: work },
        ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
      });
      // The published schema first: a document no consumer can read is not an answer to compare.
      let parsed: unknown;
      try {
        parsed = verb.parse(result.stdout);
      } catch {
        throw new Error(`${label} ${verb.name}: stdout is not its document (exit ${String(result.status)}): ${result.stderr}`);
      }
      const checked = verb.schema.safeParse(parsed);
      expect(checked.success, `${label} ${verb.name}: ${checked.success ? '' : checked.error.message}`).toBe(true);
      assertOnlyDeclaredCaches(options.dirs, before, `${label} ${verb.name}`);
      const document = parsed as Record<string, unknown>;
      return {
        label,
        verb: verb.name,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        document,
        origins: verb.originsOf(document),
        charged: contributorsCharged(timing),
        work: workDumpsUnder(work),
        extentsBefore,
        cell: { dirs: options.dirs, corpus: options.corpus, env: options.env },
        objectContent: objectContentOf(document, options.corpus, options.env),
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
  if ('agreesAndRepairs' in expectation) return expectation.agreesAndRepairs.arm === arm;
  if ('editServed' in expectation) return expectation.editServed.arm === arm;
  if ('staleServed' in expectation) return expectation.staleServed.arm === arm;
  if ('checkoutStable' in expectation) return expectation.checkoutStable.arm === arm;
  return false;
}

/**
 * The tells a seed's cell is held to: the arm's own, unless the seed declares the store declines.
 *
 * @param seed - The seed, or `undefined` for the unseeded gate
 * @param arm - The arm
 * @returns The prime's tell and the measured run's
 */
function cellTells(seed: I0Seed | undefined, arm: ArmName): { readonly prime: Tell; readonly measured: Tell } {
  const declines = seed !== undefined && 'agrees' in seed.expect ? seed.expect.agrees.storeDeclines : null;
  if (arm === 'storeOff' || declines === null) return { prime: coldTell, measured: ARMS[arm].tell };
  if (arm === 'partialEviction' && declines.prime) throw new Error(`${seed?.name ?? ''}: a declined prime leaves nothing to evict`);
  if (declines.measured) return { prime: declines.prime ? declinedTell : coldTell, measured: declinedTell };
  return declines.prime ? { prime: declinedTell, measured: coldTell } : { prime: coldTell, measured: ARMS[arm].tell };
}

/**
 * The new tree's keys as a store-on run keys them, by the key store-off gave the same bytes:
 * read off the store-off reference's dump, an arm no store reached, each keyed path rekeyed
 * by git membership ({@link diskKeyOf}). Store-off keys every file by its bytes; store-on keys a
 * git member by its OID, so one store-off key can stand for several store-on keys.
 *
 * @param reference - The store-off arm's measured query run, its corpus untouched since
 * @returns Store-off key to the store-on keys of the paths it keyed
 */
function storeOnKeysByReferenceKey(reference: RunRecord | undefined): Map<string, Set<string>> {
  if (reference === undefined) throw new Error('an editServed seed must run the query: its store-off dump names the new tree\'s keys');
  const members = gitMemberOids(reference.cell.corpus, reference.cell.env);
  const byKey = new Map<string, Set<string>>();
  for (const row of (rowsByRelation(reference.document).get('resource_realizations') ?? []).map((json) => JSON.parse(json) as { path: string; contentState: string; contentKey: string | null })) {
    if (row.contentState !== 'keyed' || row.contentKey === null) continue;
    const keys = byKey.get(row.contentKey) ?? new Set<string>();
    keys.add(diskKeyOf(reference.cell.corpus, row.path, keyParserKind(row.contentKey), members));
    byKey.set(row.contentKey, keys);
  }
  return byKey;
}

/**
 * The new tree's distinct keyed content keys as a store-on run keys them: what an edit seed's
 * measured run populates ({@link storeOnKeysByReferenceKey}).
 *
 * @param reference - The store-off arm's measured query run
 * @returns The keys, sorted
 */
function newTreeKeys(reference: RunRecord | undefined): string[] {
  return sortedKeys([...new Set([...storeOnKeysByReferenceKey(reference).values()].flatMap((keys) => [...keys]))]);
}

/** A content key's parser kind. */
function keyParserKind(contentKey: string): ParserKind {
  return contentKeyParts(parseStoredKey(contentKey)).parserKind;
}

/** Whether a content key names a document parser, so a miss looks a parse up for it. */
function hasParser(contentKey: string): boolean {
  return contentKeyParts(parseStoredKey(contentKey)).parserKind !== 'none';
}

/**
 * Before an `editServed` cell's measured run: read the seed's uncovered keys and hold them for
 * the tell, after asserting the primed store agrees with them (the one predicate calls exactly
 * those keys of the new tree uncovered) and that the seed can tell reuse from none. A seed whose
 * edit leaves no key with a parser covered is one where a miss that extracts every key and one
 * that reuses agree, so it cannot pass.
 *
 * @param seed - The `editServed` seed of the cell's claimed arm
 * @param dirs - The cell
 * @param corpus - The corpus, in its measured state
 * @param reference - The store-off arm's measured query run
 */
async function recordUncovered(seed: I0Seed, dirs: ArmDirs, corpus: string, reference: RunRecord | undefined): Promise<void> {
  if (!('editServed' in seed.expect)) return;
  const unmeasured = (seed.verbs ?? VERB_NAMES).filter((verb) => !isEditVerb(verb));
  expect(unmeasured, `${seed.name}: verbs an edit seed has no count for`).toEqual([]);
  const uncovered = seed.expect.editServed.uncovered(dirs, corpus);
  expect(new Set(uncovered).size, `${seed.name}: uncovered keys listed twice`).toBe(uncovered.length);
  const keys = newTreeKeys(reference);
  const asked = [...new Set([...keys, ...uncovered])];
  expect(
    sortedKeys(await primedUncovered(dirs, asked)),
    `${seed.name}: the keys the primed store does not cover, by the one predicate, are exactly the seed's`,
  ).toEqual(sortedKeys(uncovered));
  const parsed = keys.filter((key) => hasParser(key));
  expect(uncovered.length, `${seed.name}: uncovered keys must be fewer than the new tree's keys with a parser`).toBeLessThan(parsed.length);
  const refused = seed.expect.editServed.refused(dirs, corpus);
  expect(refused.filter((key) => !uncovered.includes(key)), `${seed.name}: refused keys the seed does not list uncovered`).toEqual([]);
  expect(
    sortedKeys(refused),
    `${seed.name}: the refused keys are exactly the new tree's keys the store-off reference refused a parse`,
  ).toEqual(parseRefusedKeys(reference, keys));
  uncoveredByCell.set(dirs.root, uncovered);
  refusedByCell.set(dirs.root, refused);
}

/** The parse refusals no store files (`storableBlobFacts`): a limit hit, a worker lost. */
const UNFILED_PARSE_REFUSALS: ReadonlySet<string> = new Set([BLOB_PARSE_LIMIT_EXCEEDED, BLOB_PARSE_WORKER_DIED]);

/**
 * The keys of the new tree whose parse the store-off reference refused with a code no store files,
 * as a store-on run keys those bytes.
 *
 * @param reference - The store-off arm's measured query run
 * @param keys - The new tree's keys
 * @returns The refused ones, sorted
 */
function parseRefusedKeys(reference: RunRecord | undefined, keys: readonly string[]): string[] {
  if (reference === undefined) throw new Error('an editServed seed must run the query: its store-off dump names the refusals');
  const storeOn = storeOnKeysByReferenceKey(reference);
  const refused = (rowsByRelation(reference.document).get(PROJECTION_TABLES.blobConditions.name) ?? [])
    .map((row) => JSON.parse(row) as { blob: string; code: string })
    .filter((row) => UNFILED_PARSE_REFUSALS.has(row.code))
    .flatMap((row) => [...(storeOn.get(row.blob) ?? [])])
    .filter((key) => keys.includes(key));
  return sortedKeys([...new Set(refused)]);
}

/** Keys sorted as every key list here is, a copy. */
function sortedKeys(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * After an `editServed` cell's measured run: the new tree's keys its store still does not cover,
 * by the one predicate, held for the tell to compare with the seed's refused keys.
 *
 * @param dirs - The cell
 * @param reference - The store-off arm's measured query run
 */
async function recordUncoveredAfter(dirs: ArmDirs, reference: RunRecord | undefined): Promise<void> {
  const keys = newTreeKeys(reference);
  const uncovered = uncoveredByCell.get(dirs.root) ?? [];
  uncoveredAfterByCell.set(dirs.root, await primedUncovered(dirs, [...new Set([...keys, ...uncovered])]));
}

/**
 * The keys the cell's store does not cover, by the one blob-tier predicate
 * (`uncoveredContentKeys` over `ALL_BLOB_REQUEST`), read through the store's own port.
 *
 * @param dirs - The primed cell
 * @param keys - The keys to ask about
 * @returns The uncovered ones, in `keys` order
 */
export async function primedUncovered(dirs: ArmDirs, keys: readonly string[]): Promise<string[]> {
  const [file, ...others] = storeFilesUnder(dirs.store);
  if (file === undefined || others.length > 0) throw new Error(`expected one projection store under ${dirs.store}`);
  const store = openSqliteFactStore({ directory: safePath.join(file, '..'), blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
  const asked = keys.map((key) => parseStoredKey(key));
  try {
    return uncoveredContentKeys((await store.readBlobFacts(asked, ALL_BLOB_REQUEST)).rows, asked);
  } finally {
    await store.close();
  }
}

/** The `editServed` seed whose claimed arm a cell runs, if any. */
function editSeedOf(seed: I0Seed | undefined, arm: ArmName): I0Seed | undefined {
  return seed !== undefined && 'editServed' in seed.expect && seed.expect.editServed.arm === arm ? seed : undefined;
}

/** One cell's recorded runs. */
interface CellRuns {
  readonly prime: RunRecord | undefined;
  readonly intermediate: RunRecord | undefined;
  readonly measured: RunRecord;
}

/**
 * Run one cell: fresh directories, the fixture, state A, prepare, any intermediate step and its
 * unmeasured run, B, the plant, one measured run.
 *
 * @param options - The build and subject
 * @param seed - The seed, or `undefined` for the unseeded gate
 * @param arm - The arm
 * @param verb - The verb measured
 * @param context - Every verb row, and the store-off reference's measured runs so far
 * @returns The cell's runs
 */
async function runCell(
  options: DifferentialOptions,
  seed: I0Seed | undefined,
  arm: ArmName,
  verb: VerbRow,
  context: { readonly rows: VerbRows; readonly reference: Partial<Record<VerbName, RunRecord>> },
): Promise<CellRuns> {
  const { rows } = context;
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
    const tells = cellTells(seed, arm);
    const prime = await ARMS[arm].prepare(dirs, corpus, git, () => runner.run(rows.query, `${arm}:prime`), tells.prime);
    const editSeed = editSeedOf(seed, arm);
    const head = editSeed === undefined ? undefined : git(['rev-parse', 'HEAD']);
    let intermediate: RunRecord | undefined;
    if (seed?.intermediate !== undefined) {
      await seed.intermediate(arm, dirs, corpus, git);
      intermediate = await runner.run(verb, `${arm}:intermediate`);
    }
    await seed?.toB?.(arm, dirs, corpus, git);
    await seed?.beforeRun?.(arm, dirs, corpus);
    if (editSeed !== undefined) {
      expect(git(['rev-parse', 'HEAD']), `${editSeed.name}: an edit seed moved HEAD`).toBe(head);
      await recordUncovered(editSeed, dirs, corpus, context.reference.query);
    }
    const measured = await runner.run(verb, `${arm}:measured`);
    if (editSeed !== undefined) await recordUncoveredAfter(dirs, context.reference.query);
    if (!seedClaims(seed, arm)) tells.measured(measured, dirs);
    return { prime, intermediate, measured };
  } finally {
    seed?.restore?.(corpus);
  }
}

/** One slice of the unseeded gate: the cells one system file runs. */
interface GateSlice {
  readonly slice: string;
  readonly arms: readonly ArmName[];
  readonly verbs: readonly VerbName[];
}

/**
 * The unseeded gate's cells, sliced so each file stays inside the system tier's
 * per-file budget (`docs/writing-tests.md`): every cell is a CLI spawn, a warm arm's
 * a second, and `vat validate` spawns its checks child. Every (arm, verb) cell but
 * store-off's lies in exactly one slice, and each slice runs store-off, the
 * reference, first and over its own verbs; the unit test holds both, so an arm or a
 * verb that lands in no slice reds.
 */
export const GATE_SLICES = {
  stores: { slice: 'stores', arms: ['storeOff', 'cold', 'warmSameHistory'], verbs: ['validate', 'check', 'query', 'context'] },
  vatValidate: { slice: 'vatValidate', arms: ['storeOff', 'cold', 'warmSameHistory', 'partialEviction'], verbs: ['vatValidate'] },
  partialEviction: { slice: 'partialEviction', arms: ['storeOff', 'partialEviction'], verbs: ['validate', 'check', 'query', 'context'] },
} as const satisfies Readonly<Record<string, GateSlice>>;

/**
 * Run every cell of a seed (or of a slice of the unseeded gate) and record what each produced.
 *
 * @param options - The build, the subject, any subject-specific verb rows
 * @param selection - The seed, or the gate slice
 * @returns Every run, by arm and verb, and by label
 */
export async function runDifferential(options: DifferentialOptions, selection: I0Seed | GateSlice): Promise<DifferentialResult> {
  const seed = 'slice' in selection ? undefined : selection;
  const { arms } = selection;
  const verbs = selection.verbs ?? VERB_NAMES;
  expect(arms[0], 'store-off is the reference arm and runs first').toBe('storeOff');
  const measured = Object.fromEntries(ARM_NAMES.map((arm) => [arm, {}])) as Record<ArmName, Partial<Record<VerbName, RunRecord>>>;
  const runs: Partial<Record<RunLabel, Partial<Record<VerbName, RunRecord>>>> = {};
  const rows: VerbRows = { ...VERBS, ...options.verbRows };
  for (const arm of arms) {
    for (const verb of verbs) {
      // eslint-disable-next-line no-await-in-loop -- one cell at a time: every cell rewrites the one corpus path
      const cell = await runCell(options, seed, arm, rows[verb], { rows, reference: measured.storeOff });
      measured[arm][verb] = cell.measured;
      runs[`${arm}:measured`] = { ...runs[`${arm}:measured`], [verb]: cell.measured };
      if (cell.prime !== undefined) runs[`${arm}:prime`] = { ...runs[`${arm}:prime`], [verb]: cell.prime };
      if (cell.intermediate !== undefined) runs[`${arm}:intermediate`] = { ...runs[`${arm}:intermediate`], [verb]: cell.intermediate };
    }
  }
  return { arms, verbs, measured, runs, rows };
}

// ── Comparing ───────────────────────────────────────────────────────────────

/** A dump row's column that is not comparable across arms: a digest over the content keys. */
const KEY_DIGEST_COLUMNS: Readonly<Record<string, string>> = { zone_provenance: 'extentDigest' };

/**
 * A value as a git-kind content key, when it is one.
 *
 * @param value - A dump row's column value
 * @returns The key, or `undefined` for anything else (a sha256 key included)
 */
function gitKeyOf(value: unknown): ContentKey | undefined {
  if (typeof value !== 'string') return undefined;
  const key = parseContentKey(value);
  return key !== undefined && contentKeyParts(key).keyKind !== 'sha256' ? key : undefined;
}

/**
 * Each git-kind content key a dump names, to the sha256 key of its object's bytes: one
 * `git cat-file --batch` over the distinct object names.
 *
 * @param document - A run's document; anything but a dump names none
 * @param corpus - The cell's repository
 * @param env - The cell's environment
 * @returns The map; empty when the document names no git key
 */
function objectContentOf(document: Record<string, unknown>, corpus: string, env: Record<string, string>): Map<string, string> {
  return gitKeysByContent(dumpRows(document).flatMap(({ row }) => Object.values(JSON.parse(row) as Record<string, unknown>)), corpus, env);
}

/**
 * Rows as a store-off run would name them: each git-kind key a column holds rewritten to the
 * sha256 key of its object's bytes, read from `corpus`, each key digest column dropped (a digest
 * over the keys is not comparable across keyings), and the rows sorted, since a key moves a row's
 * place in any order over it.
 *
 * @param rows - Rows a run answered
 * @param corpus - The repository holding every object a row names
 * @returns The rows, by content, in a stable order
 */
export function rowsByContent(rows: readonly Record<string, unknown>[], corpus: string): Record<string, unknown>[] {
  const content = gitKeysByContent(rows.flatMap((row) => Object.values(row)), corpus, {});
  return rows
    .map((row) => Object.fromEntries(Object.entries(row)
      .filter(([column]) => !Object.values(KEY_DIGEST_COLUMNS).includes(column))
      .map(([column, value]) => [column, typeof value === 'string' ? content.get(value) ?? value : value])))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * Each git-kind content key among `values`, to the sha256 key of its object's bytes: one
 * `git cat-file --batch` over the distinct object names.
 *
 * @param values - Column values; any that is not a git-kind key is ignored
 * @param corpus - The repository holding the objects
 * @param env - The environment git runs under
 * @returns The rewrite, keyed by the git-kind key
 */
function gitKeysByContent(values: readonly unknown[], corpus: string, env: Record<string, string>): Map<string, string> {
  const keys = new Set<ContentKey>();
  for (const value of values) {
    const key = gitKeyOf(value);
    if (key !== undefined) keys.add(key);
  }
  const content = new Map<string, string>();
  if (keys.size === 0) return content;
  const oids = [...new Set([...keys].map((key) => contentKeyParts(key).hex))];
  const result = runGitBytes(['cat-file', '--batch'], { cwd: corpus, env, input: `${oids.join('\n')}\n` });
  if (!result.ok) throw new Error(`git cat-file --batch in ${corpus}: ${result.stderr}`);
  const bodies = new Map<string, Buffer>();
  for (let at = 0; at < result.stdout.length;) {
    const frame = frameBatchRecord(result.stdout, at);
    if (frame.kind !== 'object') throw new Error(`git cat-file --batch in ${corpus}: ${frame.kind} at ${String(at)}`);
    bodies.set(frame.oid, frame.body);
    at = frame.next;
  }
  for (const key of keys) {
    const { hex, parserKind } = contentKeyParts(key);
    const body = bodies.get(hex);
    if (body === undefined) throw new Error(`${key}: the cell's repository holds no object ${hex}`);
    content.set(key, computeContentKey(body, parserKind));
  }
  return content;
}

/**
 * A dump value as the arms compare it: a git key rewritten to the sha256 key of its object's
 * bytes ({@link RunRecord.objectContent}), anything else as it is.
 *
 * @param run - The recorded run the value came from
 * @param value - A dump column's value
 * @returns The value, by content
 */
export function byContentKey(run: RunRecord, value: unknown): unknown {
  const key = gitKeyOf(value);
  if (key === undefined) return value;
  const byContent = run.objectContent.get(key);
  if (byContent === undefined) throw new Error(`${run.label} ${run.verb}: ${key} was not read when the run was recorded`);
  return byContent;
}

/**
 * A run's dump rows by relation, compared by content: each git key rewritten to the sha256 key
 * of its object's bytes, each key digest dropped, and each relation's rows a sorted set.
 *
 * @param run - A recorded run
 * @returns Relation name to its comparable rows
 */
function contentRowsOf(run: RunRecord): Map<string, string[]> {
  const compared = new Map<string, string[]>();
  for (const [relation, rows] of rowsByRelation(run.document)) {
    const rewritten = rows.map((row) => rowByContent(run, row, KEY_DIGEST_COLUMNS[relation]));
    compared.set(relation, [...new Set(rewritten)].sort((a, b) => a.localeCompare(b)));
  }
  return compared;
}

/**
 * One dump row with each git key rewritten to the sha256 key of its object's bytes
 * ({@link byContentKey}), and `dropped` (a key digest column) left out.
 *
 * @param run - The recorded run the row came from
 * @param row - The row, as the dump holds it
 * @param dropped - A column to leave out, when the relation has one
 * @returns The row, by content, as text
 */
export function rowByContent(run: RunRecord, row: string, dropped?: string): string {
  const record = JSON.parse(row) as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(Object.entries(record)
    .filter(([column]) => column !== dropped)
    .map(([column, value]) => [column, byContentKey(run, value)])));
}

/**
 * A run's document as the arms compare it: its verb's normalization, and a dump's rows by
 * content ({@link contentRowsOf}).
 *
 * @param rows - The verb rows
 * @param run - A recorded run
 * @returns The comparable document, as text
 */
export function comparableDocument(rows: VerbRows, run: RunRecord): string {
  const normalized = rows[run.verb].normalize(run.document);
  if (dumpRows(run.document).length === 0) return JSON.stringify(normalized);
  const data = normalized['data'] as Record<string, unknown>;
  return JSON.stringify({ ...normalized, data: { ...data, rows: Object.fromEntries(contentRowsOf(run)) } });
}

function sameRows(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

/**
 * The relations whose rows differ between two dumps, by content ({@link contentRowsOf}).
 *
 * @param reference - The store-off dump's run
 * @param other - Another arm's dump's run
 * @returns The relation names, sorted
 */
function divergingRelations(reference: RunRecord, other: RunRecord): string[] {
  const left = contentRowsOf(reference);
  const right = contentRowsOf(other);
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
      const sameDocument = comparableDocument(rows, other) === comparableDocument(rows, reference);
      if (!exit && sameDocument) continue;
      const relations = verb === 'query' ? divergingRelations(reference, other) : [];
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
 * The path-scoped columns a checkout change moves between store-on and store-off, by relation:
 * the realization's key for the bytes, and the extent digest, which is total over the
 * realizations and so moves with that key. Everything else in these relations must hold.
 */
export const KEY_MOVED_COLUMNS: Readonly<Record<string, string>> = {
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

/** The extent manifest's table (`projection-sqlite`'s `extents`): one row per extent the store files. */
const EXTENTS_TABLE = 'extents';

/**
 * The cell's extent manifest: one entry per extent the store files, `<storeRootId>\0<storeTreeHash>\0
 * <writtenAt>`, or none when the cell has no store yet. A write re-stamps `writtenAt`, so an entry
 * the run added is one it wrote, even under a key the store already held.
 *
 * @param dirs - The cell
 * @returns The entries, sorted
 */
function extentManifest(dirs: Pick<ArmDirs, 'store'>): string[] {
  if (storeFilesUnder(dirs.store).length === 0) return [];
  const rows = withStore(dirs, (database) => database
    .prepare(`SELECT "storeRootId" AS root, "storeTreeHash" AS tree, "writtenAt" AS at FROM ${quoteIdentifier(EXTENTS_TABLE)}`)
    .all() as unknown as Array<{ root: string; tree: string; at: string }>);
  return rows.map((row) => `${row.root}\0${row.tree}\0${row.at}`).sort((a, b) => a.localeCompare(b));
}

/**
 * The snapshot half of a stored extent key: `merge.ts`'s `storeKeyFor` files an extent under
 * `<snapshot hash> <ambient inputs>`, and the snapshot hash holds no space.
 *
 * @param storeTreeHash - The stored key's tree half
 * @returns The snapshot hash
 */
function snapshotHashOf(storeTreeHash: string): string {
  const space = storeTreeHash.indexOf(' ');
  return space === -1 ? storeTreeHash : storeTreeHash.slice(0, space);
}

/**
 * The distinct snapshot hashes a set of manifest entries files extents under.
 *
 * @param entries - {@link extentManifest} entries
 * @returns The hashes, sorted
 */
function snapshotHashesOf(entries: readonly string[]): string[] {
  return [...new Set(entries.map((entry) => snapshotHashOf(entry.split('\0')[1] ?? '')))].sort((a, b) => a.localeCompare(b));
}

/**
 * Every snapshot hash the cell's store files an extent under: what a seed reads to key a later
 * run to the primed tree.
 *
 * @param dirs - The cell
 * @returns The distinct hashes, sorted
 */
export function heldSnapshotHashes(dirs: Pick<ArmDirs, 'store'>): string[] {
  return snapshotHashesOf(extentManifest(dirs));
}

/**
 * The snapshot hash a run populated under, read from the store's extent manifest: the run reports
 * no key of its own (no debug-facts field, no row names it). A run that wrote filed its extents
 * under the key it used, so the entries it added name it; a run that wrote nothing was served, and
 * then the store must hold one tree, which is the one that served it. Never "the newest": after a
 * miss the store holds the primed tree's extents beside the run's.
 *
 * @param run - A store-on run, its cell untouched since
 * @returns The hash
 */
function runSnapshotHash(run: RunRecord): string {
  const before = new Set(run.extentsBefore);
  const after = extentManifest(run.cell.dirs);
  const written = after.filter((entry) => !before.has(entry));
  const trees = snapshotHashesOf(written.length > 0 ? written : after);
  const [tree, ...others] = trees;
  if (tree === undefined || others.length > 0) {
    const how = written.length > 0 ? 'wrote' : 'was served by';
    throw new Error(`${run.label} ${run.verb}: the run ${how} extents under ${String(trees.length)} trees (${trees.join(', ')}); the oracle cannot tell which is the run's`);
  }
  return tree;
}

/**
 * The independent oracle (D20), the `editServed` tell's first assertion and callable alone: every
 * member row of the extent the run served or wrote ({@link runSnapshotHash}), each keyed
 * `resource_realizations` path and content key, must key the path's bytes on disk now. A stale
 * hit serves rows without reading anything, so comparing only the bytes the run read could never
 * fail; this reads them itself. A path no longer on disk keys as `absent`, one it cannot read as
 * the read's error.
 *
 * What "keys" means is decided by git membership, asked of git here and never of the run
 * ({@link gitMemberOids}): a member keys as `<parserKind>.git-sha1.<oid>` (`git-sha256` for a
 * 64-hex OID), the OID `git hash-object` gives the file on disk now; anything else keys as
 * `computeContentKey` of its bytes. Comparing the whole key holds its KIND to membership first.
 *
 * @param run - A store-on measured run, its cell untouched since
 */
export function expectEditOracle(run: RunRecord): void {
  const label = `${run.label} ${run.verb}`;
  expect(storeFilesUnder(run.cell.dirs.store), `${label}: the oracle reads the cell's one store`).toHaveLength(1);
  const tree = runSnapshotHash(run);
  const realizations = quoteIdentifier(PROJECTION_TABLES.resourceRealizations.name);
  const members = withStore(run.cell.dirs, (database) => database
    .prepare(`SELECT DISTINCT "storeTreeHash" AS tree, "path", "contentKey" FROM ${realizations} WHERE "contentState" = 'keyed' AND "contentKey" IS NOT NULL`)
    .all() as unknown as Array<{ tree: string; path: string; contentKey: string }>)
    .filter((row) => snapshotHashOf(row.tree) === tree);
  expect(members.length, `${label}: the run's extent (${tree}) holds no keyed member to check`).toBeGreaterThan(0);
  const distinct = new Map(members.map((row) => [`${row.path}\0${row.contentKey}`, row]));
  const oids = gitMemberOids(run.cell.corpus, run.cell.env);
  const stale = [...distinct.values()]
    .map((row) => ({ path: row.path, stored: row.contentKey, onDisk: diskKeyOf(run.cell.corpus, row.path, keyParserKind(row.contentKey), oids) }))
    .filter((row) => row.onDisk !== row.stored)
    .sort((a, b) => a.path.localeCompare(b.path));
  expect(stale, `${label}: the extent under the run's key (${tree}) keys members to bytes that are not on disk`).toEqual([]);
}

/** The index modes of a regular file: a git member's (a symlink's 120000 and a submodule's 160000 are not). */
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

/**
 * The corpus's git members and the OID each keys to now, asked of git alone: what the snapshot
 * stages (`add --all`), so every index entry of a regular-file mode (`ls-files -s`) and every
 * untracked file git does not ignore (`ls-files -o --exclude-standard`), each a regular file on
 * disk now (a deleted entry, or a skip-worktree one never checked out, stages nothing), less a
 * `filter=lfs` path (`check-attr`); each OID is `git hash-object` of the file on disk, clean filter
 * applied, the object the snapshot stages for it.
 *
 * @param corpus - The repository's root
 * @param env - The cell's git environment
 * @returns Root-relative path to OID
 */
function gitMemberOids(corpus: string, env: Readonly<Record<string, string>>): Map<string, string> {
  const git = (args: readonly string[], input?: string): string[] =>
    runGitOrThrow(args, { cwd: corpus, env: { ...env }, ...(input === undefined ? {} : { input }) }).split('\0').filter((field) => field !== '');
  const onDisk = (path: string): boolean => lstatSync(safePath.join(corpus, path), { throwIfNoEntry: false })?.isFile() === true;
  const regular = [
    ...git(['ls-files', '-s', '-z'])
      .map((entry) => ({ mode: entry.slice(0, entry.indexOf(' ')), path: entry.slice(entry.indexOf('\t') + 1) }))
      .filter((entry) => REGULAR_FILE_MODES.has(entry.mode))
      .map((entry) => entry.path),
    ...git(['ls-files', '-o', '--exclude-standard', '-z']),
  ].filter((path) => onDisk(path));
  if (regular.length === 0) return new Map();
  const attributes = git(['check-attr', '--stdin', '-z', 'filter'], `${regular.join('\0')}\0`);
  const lfs = new Set<string>();
  for (let at = 0; at + 2 < attributes.length; at += 3) {
    if (attributes[at + 2] === 'lfs') lfs.add(attributes[at] ?? '');
  }
  const members = regular.filter((path) => !lfs.has(path));
  if (members.length === 0) return new Map();
  const oids = runGitOrThrow(['hash-object', '--stdin-paths'], { cwd: corpus, env: { ...env }, input: `${members.join('\n')}\n` }).split('\n').filter((line) => line !== '');
  expect(oids, 'one OID per member').toHaveLength(members.length);
  return new Map(members.map((path, index) => [path, oids[index] ?? '']));
}

/**
 * The key of a corpus path's bytes on disk now, under a parser kind, as a store-on run keys
 * them: a git member's OID key, or the sha256 key of anything else's bytes.
 *
 * @param corpus - The corpus
 * @param path - The root-relative path
 * @param parserKind - The parser kind it routes to
 * @param members - {@link gitMemberOids} of the corpus now
 * @returns The key; `absent` when the path is gone, or the read's error when it cannot be read
 */
function diskKeyOf(corpus: string, path: string, parserKind: ParserKind, members: ReadonlyMap<string, string>): string {
  let bytes: Buffer;
  try {
    bytes = corpusBytes(corpus, path);
  } catch (error) {
    return isPathAbsentError(error) ? 'absent' : `unreadable: ${String(error)}`;
  }
  const oid = members.get(path);
  if (oid === undefined) return computeContentKey(bytes, parserKind);
  return `${parserKind}.${oid.length === 40 ? 'git-sha1' : 'git-sha256'}.${oid}`;
}

/**
 * The keys a store-on run gives corpus paths' bytes on disk now ({@link diskKeyOf}), membership
 * asked of git once for all of them.
 *
 * @param corpus - The corpus, in the state to key
 * @param paths - Root-relative paths, each with the parser kind it routes to
 * @returns The keys, in `paths` order
 */
export function storeOnKeysAt(corpus: string, paths: ReadonlyArray<{ readonly path: string; readonly parserKind: ParserKind }>): string[] {
  const members = gitMemberOids(corpus, {});
  return paths.map(({ path, parserKind }) => diskKeyOf(corpus, path, parserKind, members));
}

/**
 * An edit seed's tell over its warm arm, in order: the oracle on every verb; agreement with
 * store-off (exit code, findings in order, and the dump's rows; the dump sorts its rows, `ORDER BY
 * relation, row` in `DUMP_SQL`, so row ORDER is not compared here: the tier-reuse integration test's
 * "row for row, in order" `toEqual` holds it); then per verb: the store after the run leaves exactly the
 * refused keys uncovered; and from its {@link populationCounts} and its {@link EDIT_VERBS} row:
 * `extent.derived` its populations; parse lookups; `blob.storeServed`; its extent reads; a
 * write; and a derived origin.
 *
 * With `D` distinct keys of the new tree, `U` uncovered (`R` of them refused, `R` within `U`),
 * `P` populations, and `Up`/`Rp` the uncovered/refused keys with a parser:
 *
 * ```text
 * parse lookups      = Up + Rp
 * blob.storeServed   = (D - U) + (P - 1) * (D - R)
 * ```
 *
 * The first population looks up each uncovered key with a parser and is served every other; its
 * write files every uncovered key but the refused ones, so each later population is served all
 * but the refused keys. A refusal is filed nowhere, so no store ever holds it: this is an exact
 * account, not an allowance.
 *
 * Lookups are `parseLookupsIn`'s sum (`PARSE_LOOKUP_COUNTERS`), which counts a refused parse
 * TWICE: the worker's dispatch (`parse.dispatched`) and its output-cap breach
 * (`parse.refused.keyDetermined`, `parse-pool.ts` `settleJob`); a breach of a cache hit is
 * likewise `parse.cache.hit` plus `parse.refused.keyDetermined`. So each refused key with a
 * parser adds `Rp` once more on top of its place in `Up`. A later population of the same run pays
 * no lookup for it: the run's one dispatcher holds each key's parse, rejection included, for the
 * run (`ParseDispatcher`'s `#parsed`), so the later ask settles from that and counts nothing. The
 * lookup terms are per run, not per population.
 *
 * @param result - The recorded runs
 * @param arm - The warm arm the seed claims
 */
function expectEditServed(result: DifferentialResult, arm: ArmName, storeOffReadsOtherBytes: string | undefined): void {
  const runs = result.verbs.map((verb) => {
    const run = result.measured[arm][verb];
    if (run === undefined) throw new Error(`no ${arm} run of ${verb}`);
    return run;
  });
  for (const run of runs) expectEditOracle(run);
  if (storeOffReadsOtherBytes === undefined) expectSameAnswers(result);
  else expectSameFindings(result);
  const keys = newTreeKeys(result.measured.storeOff.query);
  const recorded = (run: RunRecord): { uncovered: readonly string[]; refused: readonly string[] } => {
    const uncovered = uncoveredByCell.get(run.cell.dirs.root);
    const refused = refusedByCell.get(run.cell.dirs.root);
    const after = uncoveredAfterByCell.get(run.cell.dirs.root);
    if (uncovered === undefined || refused === undefined || after === undefined) throw new Error(`${run.label} ${run.verb}: no uncovered keys recorded for this cell`);
    expect(sortedKeys(after), `${run.label} ${run.verb}: after the run the store covers every key of the new tree but the refused ones`).toEqual(sortedKeys(refused));
    return { uncovered, refused };
  };
  // Every cell's store first (`map` runs eagerly), so a count's red on one verb never hides another's store.
  for (const { run, uncovered, refused } of runs.map((run) => ({ run, ...recorded(run) }))) {
    const label = `${run.label} ${run.verb}`;
    if (!isEditVerb(run.verb)) throw new Error(`${label}: an edit seed measures ${Object.keys(EDIT_VERBS).join(' and ')} only`);
    const scope: EditVerbScope = EDIT_VERBS[run.verb];
    const counts = populationCounts(run.work);
    expect(counts['extent.derived'], `${label}: populations derived over the edited tree`).toBe(scope.populations);
    expect(parseLookupsIn(counts), `${label}: parse lookups, one per uncovered key with a parser, and a refused one's dispatch and refusal both counted`)
      .toBe(uncovered.filter((key) => hasParser(key)).length + refused.filter((key) => hasParser(key)).length);
    expect(counts['blob.storeServed'], `${label}: the first population's covered keys, then every key but the refused per later population`)
      .toBe(keys.length - uncovered.length + (scope.populations - 1) * (keys.length - refused.length));
    expect(counts['store.reads.extent'], `${label}: extent reads`).toBe(scope.extentReads);
    expect(storeCharges(run), `${label}: the miss writes`).toContain(CRAWL_STORE_WRITE_ID);
    expectOrigin(run, 'derived');
  }
}

/**
 * The oracle's red proof over a stale hit: on every verb of the arm, {@link expectEditOracle}
 * fails, and its failure names the edited path.
 *
 * @param result - The recorded runs
 * @param stale - The arm made to key the pre-edit tree, and the path edited since the prime
 */
function expectStaleServed(result: DifferentialResult, stale: { readonly arm: ArmName; readonly editedPath: string }): void {
  for (const verb of result.verbs) {
    const run = result.measured[stale.arm][verb];
    if (run === undefined) throw new Error(`no ${stale.arm} run of ${verb}`);
    let failure = '';
    try {
      expectEditOracle(run);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure, `${run.label} ${verb}: the oracle passed a run served the pre-edit extent`).not.toBe('');
    expect(failure, `${run.label} ${verb}: the oracle's failure names the edited path`).toContain(stale.editedPath);
  }
}

/**
 * A checkout-stable seed's claim ({@link SeedExpectation}'s `checkoutStable`): the arm is served, it
 * serves exactly its prime's dump, and that dump differs from store-off's only as `storeOffReads`
 * allows.
 *
 * @param result - The recorded runs
 * @param stable - The arm, and how the measured checkout's bytes stand to git's
 */
function expectCheckoutStable(result: DifferentialResult, stable: Extract<SeedExpectation, { checkoutStable: unknown }>['checkoutStable']): void {
  const { arm, storeOffReads } = stable;
  for (const verb of result.verbs) {
    const run = result.measured[arm][verb];
    if (run === undefined) throw new Error(`no ${arm} run of ${verb}`);
    expect(storeCharges(run), `${arm} ${verb} must be served`).toEqual([CRAWL_STORE_READ_ID]);
    expectOrigin(run, 'store');
  }
  // Store-off reads the working tree. Where it holds git's bytes the two agree outright. Where it
  // does not, the key that names the bytes moves, and so does every blob-scoped fact parsed from
  // them and every path-scoped fact the seed names as parsed: only the dump may differ, and in it
  // nothing else. Any other path-scoped relation that differs is a store-on defect, whatever its
  // prime agreed to, since the warm-equals-prime check below compares store-on with store-on.
  const found = divergences(result).filter((divergence) => divergence.arm === arm);
  if (storeOffReads === 'git bytes') {
    expect(found, `${arm}: the checkout holds git's bytes, so store-off answers as store-on does`).toEqual([]);
  } else {
    const allowed = new Set([
      ...DUMPED_RELATIONS.filter((relation) => relation.blobScoped).map((relation) => relation.name),
      ...Object.keys(KEY_MOVED_COLUMNS),
      ...storeOffReads.otherBytes.parsedRelations,
    ]);
    expect(found.length, `${arm}: store-off reads other bytes, so the dump differs`).toBeGreaterThan(0);
    for (const divergence of found) {
      expect(divergence.verb).toBe('query');
      expect(divergence.relations.filter((name) => !allowed.has(name)), `${arm}: only what the bytes decide diverges`).toEqual([]);
    }
  }
  const reference = result.measured.storeOff.query;
  const warm = result.measured[arm].query;
  const primed = result.runs[`${arm}:prime`]?.query;
  if (reference === undefined || warm === undefined || primed === undefined) {
    throw new Error('checkoutStable needs the dump in both arms and the warm arm\'s prime');
  }
  // The tree hash did not move and neither did git's bytes, so the warm run is served exactly what
  // its prime derived, byte for byte.
  const normalized = (run: RunRecord): string => JSON.stringify(result.rows.query.normalize(run.document));
  expect(normalized(warm), `${arm} serves exactly its prime's dump`).toBe(normalized(primed));
  for (const [relation, column] of Object.entries(KEY_MOVED_COLUMNS)) {
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
  else if ('agrees' in expectation || 'agreesAndRepairs' in expectation) expectSameAnswers(result);
  else if ('refuses' in expectation) expectRefuses(result, expectation.refuses);
  else if ('agreesAndMisses' in expectation) expectAgreesAndMisses(result, expectation.agreesAndMisses.arm);
  else if ('editServed' in expectation) expectEditServed(result, expectation.editServed.arm, expectation.editServed.storeOffReadsOtherBytes);
  else if ('staleServed' in expectation) expectStaleServed(result, expectation.staleServed);
  else expectCheckoutStable(result, expectation.checkoutStable);
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
  // Its dated line is a skill-text match (`timeSensitive`), so `skill_text_matches` holds a row
  // as every markdown blob's `skill_text_facts` does: no skill reads it, the parse records it.
  'docs/guide.md': '# Guide\n\nRead [one](./one.md#detail) and [the spec][spec-ref].\n\nCurrent as of March 2024.\n',
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

/** A fixture a subject rewrites in every cell: what it commits, then what it leaves untracked. */
export interface FixtureTree {
  /** Writes the files the fixture commits, into an empty corpus. */
  readonly committed: (corpus: string) => void;
  /** Writes the files it leaves untracked, after the commit. */
  readonly untracked: (corpus: string) => void;
}

/** The gate fixture, committed, plus one untracked file. */
const GATE_TREE: FixtureTree = {
  committed: (corpus) => writeFileTree(corpus, GATE_FIXTURE),
  untracked: (corpus) => writeFileTree(corpus, GATE_UNTRACKED),
};

/**
 * A subject that rewrites a fixture tree in every cell: its committed files, a fresh
 * repository holding them, then its untracked files.
 *
 * @param corpus - The corpus path every arm measures at
 * @param tree - The fixture
 * @returns The subject
 */
function treeSubject(corpus: string, tree: FixtureTree): Subject {
  return {
    corpus,
    write: (git) => {
      tree.committed(corpus);
      git(['init', '-q', '-b', 'main']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'fixture']);
      tree.untracked(corpus);
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

/**
 * The ways git's index stops `git status` seeing a tracked file's edit: the two `update-index`
 * flags, and `core.ignoreStat`, which sets assume-unchanged on every entry it writes.
 */
type IndexFlag = 'assume-unchanged' | 'skip-worktree' | 'core.ignoreStat';

/** The link every index-flag seed's edit adds, to a file no fixture holds. */
const INDEX_FLAG_BROKEN_LINK = './gone.md';

/** Where an index-flag seed plants, and what it runs. */
interface IndexFlagPlant {
  /** A tracked file that links nowhere broken until edited. */
  readonly path: string;
  /** The edited bytes: the file with a link to {@link INDEX_FLAG_BROKEN_LINK} added. */
  readonly edited: string;
  readonly arms: readonly ArmName[];
  /** Must include `vatValidate`, whose store-off findings show the edit. */
  readonly verbs: readonly VerbName[];
}

/**
 * Set or clear a flag on one path, then assert `git status` clean for it either way.
 * `core.ignoreStat` is set in the repository's config and takes effect as the entry is written
 * again (`rm --cached`, then `add`), which marks it assume-unchanged.
 */
function setIndexFlag(git: Git, flag: IndexFlag, path: string, on: boolean): void {
  if (flag === 'core.ignoreStat') {
    if (on) {
      git(['config', 'core.ignoreStat', 'true']);
      git(['rm', '-q', '--cached', '--', path]);
      git(['add', '--', path]);
      expect(git(['ls-files', '-v', '--', path]).startsWith('h '), `${path} is assume-unchanged under core.ignoreStat`).toBe(true);
    } else {
      git(['config', '--unset', 'core.ignoreStat']);
      git(['update-index', '--no-assume-unchanged', '--', path]);
    }
  } else {
    git(['update-index', `--${on ? '' : 'no-'}${flag}`, '--', path]);
  }
  expect(git(['status', '--porcelain', '--', path]).trim(), `git status after ${on ? 'setting' : 'clearing'} ${flag}`).toBe('');
}

/**
 * The warm arm's measured runs keyed the flagged file's bytes on disk: the D20 oracle on each.
 *
 * @param runs - The recorded runs
 */
function expectWarmKeysDisk(runs: RecordedRuns): void {
  const measured = Object.values(runs['warmSameHistory:measured'] ?? {});
  expect(measured.length, 'a warm measured run to check').toBeGreaterThan(0);
  for (const run of measured) expectEditOracle(run);
}

/**
 * The two seeds for one index flag. A flagged file's edit leaves `git status` clean, yet the
 * snapshot keys it: the temp index it is taken in clears assume-unchanged, and skip-worktree on an
 * entry present on disk, so the edited bytes' OID moves the tree hash. Each store-on run keys and
 * keeps the store, misses where the bytes moved, and answers as store-off does; the oracle holds
 * every warm key to the bytes on disk.
 *
 * - forward: flag before the prime, edit after it. A tree hash that did not see the edit would
 *   serve the measured run the prime's facts for the unedited bytes and miss the broken link
 *   store-off reports.
 * - reverse: flag and edit before the prime, revert and unflag after it. A tree hash that did not
 *   see the edit would file the edited bytes' facts under the clean tree's hash, and the measured
 *   run, now over the clean tree, would be served a broken link that is not there.
 *
 * @param flag - How the index hides the edit
 * @param plant - The file, its edit, the arms and verbs
 * @returns The forward seed, then the reverse
 */
export function indexFlagSeeds(flag: IndexFlag, plant: IndexFlagPlant): readonly [I0Seed, I0Seed] {
  const { path, edited, arms, verbs } = plant;
  const referenceFindingsAtPath = (runs: RecordedRuns): unknown[][] => {
    const findings = (runs['storeOff:measured']?.vatValidate?.document['findings'] ?? []) as Array<Record<string, unknown>>;
    return findings
      .filter((finding) => finding['location'] === path && finding['code'] === 'LINK_BROKEN_FILE')
      .map((finding) => [finding['code'], finding['link']]);
  };
  const forward: I0Seed = {
    name: `${flag} edit after the prime`,
    needs: null,
    arms,
    verbs,
    stateA: (_corpus, git) => {
      setIndexFlag(git, flag, path, true);
      return Promise.resolve();
    },
    toB: (_arm, _dirs, corpus, git) => {
      writeFileSync(safePath.join(corpus, path), edited);
      expect(git(['status', '--porcelain', '--', path]).trim(), 'git does not see the edit').toBe('');
      return Promise.resolve();
    },
    expect: { agreesAndMisses: { arm: 'warmSameHistory' } },
    consumed: {
      runs: ['storeOff:measured', 'warmSameHistory:measured'],
      check: (runs) => {
        // The edit is observable: the reference reports the link it broke.
        expect(referenceFindingsAtPath(runs)).toEqual([['LINK_BROKEN_FILE', INDEX_FLAG_BROKEN_LINK]]);
        expectWarmKeysDisk(runs);
      },
    },
  };
  const original = new Map<string, Buffer>();
  const reverse: I0Seed = {
    name: `${flag} edit reverted before the measured run`,
    needs: null,
    arms,
    verbs,
    stateA: (corpus, git) => {
      original.set(corpus, corpusBytes(corpus, path));
      setIndexFlag(git, flag, path, true);
      writeFileSync(safePath.join(corpus, path), edited);
      expect(git(['status', '--porcelain', '--', path]).trim(), 'git does not see the edit').toBe('');
      return Promise.resolve();
    },
    toB: (_arm, _dirs, corpus, git) => {
      const bytes = original.get(corpus);
      if (bytes === undefined) throw new Error(`${path}: state A recorded no original bytes`);
      writeFileSync(safePath.join(corpus, path), bytes);
      setIndexFlag(git, flag, path, false);
      return Promise.resolve();
    },
    expect: { agreesAndMisses: { arm: 'warmSameHistory' } },
    consumed: {
      runs: ['warmSameHistory:prime', 'warmSameHistory:measured', 'storeOff:measured'],
      check: (runs) => {
        // Every prime (the dump, one per verb) ran over the flagged tree and answered: the dump
        // reads `changed_files`, which no longer refuses a flagged entry.
        const primes = Object.values(runs['warmSameHistory:prime'] ?? {});
        expect(primes, 'one warm prime per verb').toHaveLength(verbs.length);
        for (const primed of primes) expect(primed.document['error'], 'the prime over the flagged tree answered').toBeUndefined();
        // Store-off over the reverted tree reports no broken link.
        expect(referenceFindingsAtPath(runs), 'store-off over the reverted tree').toEqual([]);
        expectWarmKeysDisk(runs);
      },
    },
  };
  return [forward, reverse];
}

// ── Seed suites ─────────────────────────────────────────────────────────────

/**
 * How a seed's test reads: an expectation that carries a reason says it.
 *
 * @param seed - The seed
 * @returns The test title
 */
export function seedTitle(seed: I0Seed): string {
  const expectation = seed.expect;
  if ('checkoutStable' in expectation) return `${seed.name} is checkout-stable: ${expectation.checkoutStable.because}`;
  if ('agrees' in expectation) return `${seed.name} agrees: ${expectation.agrees.because}`;
  if ('agreesAndRepairs' in expectation) return `${seed.name} agrees and repairs: ${expectation.agreesAndRepairs.because}`;
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

/**
 * Run every step though an earlier one throws, then rethrow the first error, so
 * one failed restore cannot leave the cells and the suite's own temp tree behind.
 *
 * @param steps - The cleanup steps, in order
 */
export function runEveryStep(steps: ReadonlyArray<() => void>): void {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      errors.push(error);
    }
  }
  const [first] = errors;
  if (errors.length > 0) throw first instanceof Error ? first : new Error(String(first));
}

/** One unseeded slice's file: its recorded runs, and the judgment of them. */
interface GateSuite {
  /** The slice's recorded runs, once its `beforeAll` has run. */
  readonly result: () => DifferentialResult;
  /** Every arm of the slice answers every verb of it as store-off does, and whatever else the suite holds. */
  readonly expectAgreement: () => void | Promise<void>;
}

/**
 * Registers, in the calling `describe`, the hooks that run one unseeded slice over a
 * fixture tree, and returns its recorded runs.
 *
 * @param prefix - The suite's temp-directory prefix
 * @param slice - The cells
 * @param tree - The fixture every cell rewrites
 * @param testFileUrl - The calling file's `import.meta.url`, which locates the CLI build
 * @returns The recorded runs, once `beforeAll` has run
 */
function recordedSlice(prefix: string, slice: GateSlice, tree: FixtureTree, testFileUrl: string): () => DifferentialResult {
  const context = createSuiteContext(prefix, testFileUrl);
  let recorded: DifferentialResult | undefined;
  beforeAll(async () => {
    context.setup();
    recorded = await runDifferential({ binPath: context.binPath, subject: treeSubject(safePath.join(context.createTempDir(), 'corpus'), tree) }, slice);
  });
  afterAll(() => {
    removeCells();
    context.cleanup();
  });
  return () => {
    if (recorded === undefined) throw new Error(`the ${slice.slice} slice has not run`);
    expect(recorded.arms).toEqual(slice.arms);
    expect(recorded.verbs).toEqual(slice.verbs);
    return recorded;
  };
}

/**
 * One slice of the unseeded gate: registers its hooks in the calling `describe`, and
 * returns what the file's own test judges: no divergence, and a zero refusal census.
 *
 * @param slice - The slice ({@link GATE_SLICES})
 * @param testFileUrl - The calling file's `import.meta.url`, which locates the CLI build
 * @returns The suite
 */
export function gateSuite(slice: GateSlice, testFileUrl: string): GateSuite {
  const result = recordedSlice('vat-i0-gate-', slice, GATE_TREE, testFileUrl);
  return { result, expectAgreement: () => expectNoDivergenceAndNoRefusal(result()) };
}

/**
 * The store-fidelity differential's cells: `vat validate` in every arm. Warm `vat
 * validate` admits each resource from its stored blob facts, and partial eviction
 * re-derives in memory exactly the keys it lost, so these two arms are the ones a
 * wrong stored fact reaches.
 */
const FIDELITY_SLICE = { slice: 'fidelity', arms: ARM_NAMES, verbs: ['vatValidate'] } as const satisfies GateSlice;

/**
 * Each arm's findings, in order, as the comparison prints them: the first thing a
 * fidelity failure needs to show is which finding moved.
 *
 * @param result - The recorded runs
 * @param verb - The verb
 * @returns Arm to its status and findings
 */
function findingsByArm(result: DifferentialResult, verb: VerbName): Record<string, unknown> {
  return Object.fromEntries(result.arms.map((arm) => {
    const run = result.measured[arm][verb];
    if (run === undefined) throw new Error(`no ${arm} run of ${verb}`);
    return [arm, { status: run.status, findings: run.document['findings'] }];
  }));
}

/**
 * Every arm exits as store-off does with byte-identical findings in order (compared
 * first, so a failure shows which finding moved), and no other field of any verb's
 * document diverges.
 *
 * @param result - The recorded runs
 */
function expectSameAnswers(result: DifferentialResult): void {
  expectSameFindings(result);
  expect(divergences(result)).toEqual([]);
}

/**
 * Every arm exits as store-off does with byte-identical findings in order.
 *
 * @param result - The recorded runs
 */
function expectSameFindings(result: DifferentialResult): void {
  for (const verb of result.verbs) {
    const byArm = findingsByArm(result, verb);
    const reference = JSON.stringify(byArm['storeOff']);
    const differing = result.arms.filter((arm) => JSON.stringify(byArm[arm]) !== reference);
    expect(byArm, `${verb}: exit code or findings differ from store-off's in [${differing.join(', ')}]`)
      .toEqual(Object.fromEntries(result.arms.map((arm) => [arm, byArm['storeOff']])));
  }
}

// ── Hydration ───────────────────────────────────────────────────────────────

/**
 * What the resources phase of one `vat validate` run spent, from its work counters.
 * Findings cannot tell a warm run that admitted its view from the store apart from one
 * that fell back to the cold lane: the cold lane answers identically by design. These can.
 */
interface ResourcesPhaseSpend {
  /** `content.read`: files read from disk to be keyed. */
  readonly read: number;
  /** `content.hashedBytes`: the bytes those reads keyed, which pin which files they were. */
  readonly hashedBytes: number;
  /** `content.gitRead`: git members' bytes read from git's object store, keyed by their OID unread. */
  readonly gitRead: number;
  /** Every `parse.*` counter: each way a parse was answered. */
  readonly parseLookups: number;
  /** `registry.admitted`: every member admitted, from the store or computed. */
  readonly admitted: number;
  /**
   * `fs.stat` less `registry.admitted`: the readability probes a store admission makes
   * in place of the cold read (`readRefusal`, `run-population.ts`), each a stat. Every
   * admitted member costs the registry's one stat whichever way it came; only one
   * admitted from the store costs a probe as well. No counter names a store admission,
   * so this is its tell.
   */
  readonly probed: number;
}

/**
 * The resources phase's spend, read off the one dump that carries the phase (the
 * `vat validate` process; its checks child is another process).
 *
 * @param work - A run's CLI dumps
 * @returns The spend
 */
export function resourcesPhaseSpend(work: readonly WorkCounterDump[]): ResourcesPhaseSpend {
  const phase = resourcesPhaseOf(work);
  if (phase === undefined) throw new Error('expected one dump with a resources phase, found 0');
  return {
    read: phase['content.read'],
    hashedBytes: phase['content.hashedBytes'],
    gitRead: phase['content.gitRead'],
    parseLookups: parseLookupsIn(phase),
    admitted: phase['registry.admitted'],
    probed: phase['fs.stat'] - phase['registry.admitted'],
  };
}

/**
 * The `resources` phase of the one dump that carries it (the `vat validate` process; its
 * checks child is another process), or `undefined` when no dump does.
 *
 * @param work - A run's CLI dumps
 * @returns The phase's counts
 */
function resourcesPhaseOf(work: readonly WorkCounterDump[]): Readonly<Record<WorkCounter, number>> | undefined {
  const phases = work.flatMap((dump) => {
    const phase = dump.phases['resources'];
    return phase === undefined ? [] : [phase];
  });
  if (phases.length > 1) throw new Error(`expected at most one dump with a resources phase, found ${String(phases.length)}`);
  return phases[0];
}

/**
 * What a run's population counted, never summed over every process's dump: the `resources`
 * phase of the parent (`vat validate`), or, for a verb that runs no phases, its one CLI process.
 *
 * @param work - A run's CLI dumps
 * @returns The counts
 */
function populationCounts(work: readonly WorkCounterDump[]): Readonly<Record<WorkCounter, number>> {
  const phase = resourcesPhaseOf(work);
  if (phase !== undefined) return phase;
  const [only, ...others] = work;
  if (only === undefined || others.length > 0) throw new Error(`expected one CLI dump for a verb without phases, found ${String(work.length)}`);
  return only.counters;
}

/** A file a hydrated resources phase still reads, with its size, and how it is read. */
export interface ReadFile {
  readonly path: string;
  readonly bytes: number;
  /** A git member, read from git's object store (`content.gitRead`), never from disk and never hashed. */
  readonly member: boolean;
  /** Whether its bytes route to a parse; bytes that are not text are declined before one. */
  readonly parsed: boolean;
}

/** What a hydrated resources phase must spend, from what the cell holds. */
export interface HydrationFacts {
  /** The resources view's members: what the store-off reference's resources phase admitted. */
  readonly members: number;
  /** The view's members whose content key was evicted from the blob tier, each with that key. */
  readonly evicted: ReadonlyArray<ReadFile & { readonly contentKey: string }>;
  /** Members the store refuses by size (`oversize`), each probed and never admitted. */
  readonly refusedFromStore: number;
}

/**
 * What a hydrated resources phase spends. Every member is admitted. One whose key the
 * tier holds is admitted from the store: probed, never read, keyed or parsed. One whose
 * key was evicted is computed for that key alone: read (a git member from git once per distinct
 * key, however many paths hold its object, keyed by its OID and probed once on disk per path, the probe the store's admission uses, so an unreadable member
 * reads as unreadable store-on as store-off; any other file from disk, and hashed, its read its
 * own probe), and parsed once per distinct key whose bytes are
 * text (the dispatcher answers a second file of one key from its memo). The
 * phase's skill discovery (`computeDeferredArtifacts`) reads each SKILL.md's stored
 * facts, so it adds nothing: a fixture whose skills the store cannot serve declares
 * them, and holds their cost in its own suite.
 *
 * @param facts - The cell's facts
 * @returns The spend
 */
export function hydratedSpend(facts: HydrationFacts): ResourcesPhaseSpend {
  const bytes = (files: readonly ReadFile[]): number => files.reduce((sum, file) => sum + file.bytes, 0);
  const fromDisk = facts.evicted.filter((file) => !file.member);
  const parsedKeys = new Set(facts.evicted.filter((file) => file.parsed).map((file) => file.contentKey));
  return {
    read: fromDisk.length,
    hashedBytes: bytes(fromDisk),
    gitRead: new Set(facts.evicted.filter((file) => file.member).map((file) => file.contentKey)).size,
    parseLookups: parsedKeys.size,
    admitted: facts.members,
    probed: facts.members - fromDisk.length + facts.refusedFromStore,
  };
}

/** The arms whose resources phase admits from the store. */
const HYDRATING_ARMS = ['warmSameHistory', 'partialEviction'] as const satisfies readonly ArmName[];

/** One stored realization's path, state and key. */
interface StoredPath {
  readonly path: string;
  readonly contentState: string;
  readonly contentKey: string | null;
}

/**
 * A run's {@link HydrationFacts}, read off its cell: the store's realizations (the
 * blob tier was evicted, never the realizations) and the corpus's bytes.
 *
 * @param run - A hydrating arm's measured run
 * @param members - The view's member count
 * @param inView - Whether a root-relative path is a member of the resources view
 * @returns The facts
 */
async function hydrationFactsOf(run: RunRecord, members: number, inView: (path: string) => boolean): Promise<HydrationFacts> {
  const { dirs, corpus, env } = run.cell;
  const realizations = quoteIdentifier(PROJECTION_TABLES.resourceRealizations.name);
  const stored = withStore(dirs, (database) =>
    database.prepare(`SELECT DISTINCT "path", "contentState", "contentKey" FROM ${realizations} ORDER BY "path"`).all() as unknown as StoredPath[]);
  const evictedKeys = new Set(evictedByCell.get(dirs.root) ?? []);
  const gitMembers = gitMemberOids(corpus, env);
  const evicted = await Promise.all(stored.flatMap((row) => {
    const { contentKey } = row;
    if (contentKey === null || !evictedKeys.has(contentKey) || !inView(row.path)) return [];
    const absolute = safePath.join(corpus, row.path);
    return [readContentWithKey(absolute, keyParserKind(contentKey), null).then((keyed) => ({
      path: row.path,
      bytes: statSync(absolute).size,
      member: gitMembers.has(row.path),
      parsed: contentRoute(keyed).kind === 'parse',
      contentKey,
    }))];
  }));
  return {
    members,
    evicted,
    refusedFromStore: stored.filter((row) => row.contentState === 'oversize' && inView(row.path)).length,
  };
}

/**
 * Warm and partly evicted, the resources phase admitted its view from the store: it
 * spent exactly {@link hydratedSpend}. Without this an arm that fell back to the cold
 * lane for every file would agree with store-off and pass.
 *
 * @param result - The fidelity slice's recorded runs
 * @param inView - Whether a root-relative path is a member of the resources view
 */
async function expectHydrated(result: DifferentialResult, inView: (path: string) => boolean): Promise<void> {
  const run = (arm: ArmName): RunRecord => {
    const measured = result.measured[arm].vatValidate;
    if (measured === undefined) throw new Error(`no ${arm} run of vatValidate`);
    return measured;
  };
  const members = resourcesPhaseSpend(run('storeOff').work).admitted;
  expect(members, 'the store-off reference admits the resources view').toBeGreaterThan(0);
  const facts = Object.fromEntries(await Promise.all(HYDRATING_ARMS.map(async (arm) => [arm, await hydrationFactsOf(run(arm), members, inView)] as const)));
  const evicted = facts['partialEviction']?.evicted.length ?? 0;
  // A partial eviction that reached no view member, or every one, would hold nothing apart.
  expect(evicted, 'evicted view members').toBeGreaterThan(0);
  expect(evicted, 'evicted view members').toBeLessThan(members);
  expect(
    Object.fromEntries(HYDRATING_ARMS.map((arm) => [arm, resourcesPhaseSpend(run(arm).work)])),
    'resources phase spend: reads, keys and parses only the evicted view members; '
      + 'every other member admitted from the store (a probe each), none read',
  ).toEqual(Object.fromEntries(HYDRATING_ARMS.map((arm) => [arm, hydratedSpend(facts[arm] as HydrationFacts)])));
}

/**
 * The store-fidelity differential over a fixture seeding every fidelity case (the
 * calling file's): every arm's `vat validate` exits as store-off's does with
 * byte-identical findings in order, and no other field of its document diverges;
 * and warm and partly evicted, its resources phase admitted from the store
 * ({@link expectHydrated}). Refusals are part of the fixture, so no zero census is
 * asked of it.
 *
 * @param tree - The fixture
 * @param inView - Whether a root-relative path is a member of the fixture's resources view
 * @param testFileUrl - The calling file's `import.meta.url`, which locates the CLI build
 * @returns The suite
 */
export function fidelitySuite(tree: FixtureTree, inView: (path: string) => boolean, testFileUrl: string): GateSuite {
  const result = recordedSlice('vat-i0-fidelity-', FIDELITY_SLICE, tree, testFileUrl);
  return {
    result,
    expectAgreement: async () => {
      expectSameAnswers(result());
      await expectHydrated(result(), inView);
    },
  };
}

/** A seed file's suite: its hooks, and one seed run over a fresh gate fixture and judged. */
interface SeedSuite {
  readonly setup: () => void;
  readonly cleanup: () => void;
  /** Runs and judges the seed; resolves to the arms it ran, which must be the seed's own. */
  readonly run: (seed: I0Seed) => Promise<readonly ArmName[]>;
}

/**
 * The suite a seed file runs its seeds in, over the gate fixture.
 *
 * @param testFileUrl - The calling file's `import.meta.url`, which locates the CLI build
 * @returns The suite
 */
export function seedSuite(testFileUrl: string): SeedSuite {
  return treeSeedSuite(GATE_TREE, testFileUrl);
}

/**
 * The suite a seed file runs its seeds in, over a fixture of its own: for a seed whose
 * claim the gate fixture's custom checks would blur.
 *
 * @param tree - The fixture every cell rewrites before the seed's state A
 * @param testFileUrl - The calling file's `import.meta.url`, which locates the CLI build
 * @param verbRows - The verb rows to run in place of {@link VERBS}' own, when the subject needs its own (a dump leaving out a relation its seeds refuse)
 * @returns The suite
 */
export function treeSeedSuite(tree: FixtureTree, testFileUrl: string, verbRows?: Partial<Record<VerbName, VerbRow>>): SeedSuite {
  const context = createSuiteContext('vat-i0-seed-', testFileUrl);
  const tempDirs: string[] = [];
  return {
    setup: context.setup,
    cleanup: () => {
      runEveryStep([...tempDirs.map((tempDir) => () => restoreDirectoryModes(tempDir)), removeCells, () => context.cleanup()]);
    },
    run: async (seed) => {
      const tempDir = context.createTempDir();
      tempDirs.push(tempDir);
      const subject = treeSubject(safePath.join(tempDir, 'corpus'), tree);
      const result = await runDifferential({ binPath: context.binPath, subject, ...(verbRows === undefined ? {} : { verbRows }) }, seed);
      expectSeed(seed, result);
      return result.arms;
    },
  };
}

/**
 * One suite's hooks, registered in the caller's `describe`, and its seed runner.
 *
 * @param suite - The suite the seeds run in
 * @returns Run and judge one seed, answering the arms it ran
 */
export function seedRunner(suite: SeedSuite): SeedSuite['run'] {
  beforeAll(suite.setup);
  afterAll(suite.cleanup);
  return suite.run;
}
