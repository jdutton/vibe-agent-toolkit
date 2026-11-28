/**
 * The row-set stage: route a run's realizations to every demanded instance's row sets (the `data`
 * instance's JSON, JSONC, YAML, `.npmrc` and `.yarnrc.yml` files, the `ts` instance's TypeScript and JavaScript
 * files), serve each from the row-set tier or extract it, and say where every named relation's rows
 * come from.
 *
 * It runs after the population and before hydration, and only for the instances a statement names a
 * relation of ({@link rowSetDemandOf}): a run that names none of an instance's relations routes,
 * reads, decodes, extracts and writes nothing of that instance. Each instance is a descriptor
 * (`row-set-instances.ts`); one route, coverage, extract, write and read-back path serves them all.
 *
 * ## One state per routed pair
 *
 * Every statically routed path has one state this run, carried in its instance's routes relation
 * (`data__routes`, `ts__routes`): `facts` (its head row was read from the store or extracted now),
 * `defective` (the bytes or the file decide it) or `refused` (this run decided it), as the route
 * state schema defines them. A filesystem fault takes its state from the one fault table
 * (`fsFaultRefusal`, a source found as content): the fault is `defective` exactly where that table
 * says `INPUT_UNREADABLE`. Only `facts` are stored. Every relation of an instance answers from its
 * `facts` pairs, and every pair that is not `facts` is a {@link RowSetDefect}: one error finding at
 * its path, its instance's lane-owned code (`DATA_FILE_NO_ROWS`, `TS_FILE_NO_ROWS`;
 * {@link rowSetDefectIssues}), so one broken file fails the run without blinding a statement over
 * the others.
 *
 * ## Git content only, for the `ts` instance
 *
 * A `ts` route is git content. On the git crawl every realization is, by construction. With the
 * filesystem crawl forced in a git tree the routing keeps only the paths in the run's memoized
 * snapshot's git content (`snapshotGitContentMembers`, symlinks excluded), so an ignored file is never
 * routed. With no git answer (outside a work tree, no git binary) the snapshot's own coded error is
 * the instance's refusal ({@link DataStageResult}`.refusals`): every statement naming a `ts` relation
 * is refused, and every other instance still stages.
 *
 * ## The resolve steps over the instances
 *
 * Each step runs only when one of its own relations is named, or a later step reads it, and only
 * the named steps' answers are published: the workspace step (its links), then the tsconfig step
 * (its parsed configs), then the TypeScript resolve step (`ts_import_targets`, `ts_program_files`,
 * `ts_import_conditions`), which reads both and the `ts` instance's rows. The resolve step is the one
 * main-thread loader of TypeScript, so a run naming none of its relations never loads it here.
 *
 * ## Store on, every consumer reads through the run's reader
 *
 * The coverage read decodes head rows only, of every demanded instance. What the stage extracts it
 * writes through ONE writer across instances (with the head rows of what it was served and of every
 * earlier batch, of every instance, listed as covered at read, so no write evicts another instance's
 * row sets), then reads the head rows of what it wrote back through the reader, so the routes
 * relations and the states come from reader rows on every arm, and the named row-set tables are
 * copied inside SQLite from the store for exactly the run's `facts` row sets. `data__values` and
 * `ts_imports` read the routed pairs' nodes and imports through the reader, an extending read. A row
 * set the reader finds gone is a {@link StoredRowsEvictedError} of the row-set tier: the lane forgets
 * it and runs the stage once more, which misses on exactly it. Store off, every relation comes from
 * the rows in hand, never mixed with stored rows in one attempt.
 */

import { anchoredAt, fsFaultRefusal, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { appendAll, countWork, fsFaultOf, isVatError, realpathNativeSync, safePath, toForwardSlash, type FsFaultClass } from '@vibe-agent-toolkit/utils';
import { gitFindRoot, GIT_NO_ANSWER_CODE, GIT_NOT_FOUND_CODE } from '@vibe-agent-toolkit/utils/git';

import type { ContentKey, KeyedContent, ParserKind } from '../content-key.js';
import { DATA_OUTPUT_CAPS, isParseLimitError, isParseWorkerDiedError, type ParseLimitName } from '../parse-limits.js';
import { DATA_INSTANCE, type DataNodeRow, type DataRouteRow, type DataValueRow } from '../schemas/projection-data.js';
import type { GitContentRow } from '../schemas/projection-git-content.js';
import { TS_INSTANCE, type TsImportRow, type TsImportsRow, type TsRouteRow } from '../schemas/projection-ts.js';

import { BLOB_CONTENT_CHANGED, BLOB_NOT_TEXT, BLOB_UNREADABLE } from './blob-condition-codes.js';
import { isSizeRefusal, readKeyedContent, type RunContentCache } from './content-cache.js';
import { gitExtentSelected, snapshotGitContentMembers } from './crawl-source.js';
import { dataValueRows } from './data-values.js';
import { declaredReadsOver, type DeclaredPair, type DeclaredReads } from './declared-reads.js';
import { allDerivedSpecs, DERIVED_TABLES, emptyRowSetRows, isRowSetTable, storedRelationSpecs } from './derived-table-registry.js';
import { contentRoute } from './document-facts.js';
import { compareRows } from './export.js';
import { StoredRowsEvictedError, type QueryProjection } from './query-projection.js';
import { dataCredentialFileFindings, parserKindForMime, routingEmptiness } from './router.js';
import { rowSetIdOf, rowSetIdText, type RowSetId, type RowSetIdText, type RowSetInstanceId } from './row-set-id.js';
import {
  headIdsOf,
  ROW_SET_INSTANCES,
  rowSetInstance,
  type ExtractedTables,
  type RowSetAnswer,
  type RowSetExtractor,
  type RowSetInstanceDescriptor,
  type RowSetRoutings,
} from './row-set-instances.js';
import { ROW_SET_TABLES, type MutableRowSetRows, type RowSetHeadTableName, type RowSetRows, type RowSetTableName } from './row-set-table-registry.js';
import { runContentSource } from './run-population.js';
import { rowSetCoverage } from './store-hydration.js';
import type { FactStore, RowSetRequest } from './store.js';
import type { StoreReads } from './stored-reads.js';
import { tsImportsRows } from './ts-imports.js';
import { resolveTsImports, type TsResolveAnswer } from './ts-resolve-step.js';
import type { TsconfigJobAnswer, TsconfigJobInput } from './tsconfig-parse.js';
import { isTsconfigRootInput, resolveTsconfig, type TsconfigAnswer } from './tsconfig-step.js';
import { workspaceLinks, type WorkspaceLinkTable } from './workspace-links.js';
import { isWorkspaceRootInput, resolveWorkspace, type WorkspaceAnswer } from './workspace-packages.js';

/** The workspace resolve step's relations: naming any one demands the stage and the step. */
const WORKSPACE_RELATIONS: ReadonlySet<string> = new Set(allDerivedSpecs().filter((spec) => spec.producer === 'workspace').map((spec) => spec.name));

/** The tsconfig resolve step's relations: naming any one demands the stage and the step. */
const TSCONFIG_RELATIONS: ReadonlySet<string> = new Set(allDerivedSpecs().filter((spec) => spec.producer === 'tsconfig').map((spec) => spec.name));

/** The TypeScript resolve step's relations: naming any one demands the stage, the step and every step it reads. */
const TS_RESOLVE_RELATIONS: ReadonlySet<string> = new Set(allDerivedSpecs().filter((spec) => spec.producer === 'tsResolve').map((spec) => spec.name));

/** Every row-set table, of every instance, by SQL name. */
const ROW_SET_TABLE_BY_NAME: ReadonlyMap<string, RowSetTableName> = new Map(
  storedRelationSpecs().filter(isRowSetTable).map((spec) => [spec.name, spec.key] as const),
);

/**
 * Why a pair has no rows, as far as what helps: the bytes are malformed (`malformed`), past a cap the
 * bytes decide (`bytes-cap`), past the time cap (`time-cap`) or the heap or stack cap (`memory-cap`),
 * changed or gone under the run (`changed`), their parse worker died (`worker-died`), the run
 * already holds as many bytes of rows as it may with no store to write them to (`held-cap`), or a
 * filesystem fault with its own fix (`fs`).
 */
type NoRowsCause = 'malformed' | 'bytes-cap' | 'time-cap' | 'memory-cap' | 'changed' | 'worker-died' | 'held-cap' | 'fs';

/**
 * What each limit's breach is. A cap the bytes decide is `defective`; every other is `refused`. The
 * time caps are the run's (a loaded machine may pass on a rerun); heap and stack are the parse's own,
 * reached again on every run. `loadMs` never refuses a document (a parser that cannot load is a
 * broken install), and is a clock like `timeMs` should it ever. Keyed by the limit list, so a limit
 * the pool adds fails the typecheck here.
 */
const LIMIT_CAUSES: Readonly<Record<ParseLimitName, Extract<NoRowsCause, 'bytes-cap' | 'time-cap' | 'memory-cap'>>> = {
  inputBytes: 'bytes-cap',
  outputRows: 'bytes-cap',
  outputBytes: 'bytes-cap',
  outputDepth: 'bytes-cap',
  timeMs: 'time-cap',
  loadMs: 'time-cap',
  heapMb: 'memory-cap',
  stackMb: 'memory-cap',
};

/** What frees a run that holds as many bytes of rows as it may: the store takes them as they are extracted. */
const HELD_CAP_FIX = 'run with the projection store on, inside a git repository, so each row set is written as it is extracted instead of held';

/** What makes a root input of the workspace step read again, by cause: never routing it away, which refuses the root instead. */
const ROOT_INPUT_REMEDIES: Readonly<Record<Exclude<NoRowsCause, 'fs'>, string>> = {
  'malformed': 'fix the file',
  'bytes-cap': 'make the file smaller or simpler; its bytes reach the same cap on every run',
  'time-cap': 'run again; if the file is refused on every run, its parse runs out of time on it, so make the file smaller or simpler',
  'memory-cap': 'make the file smaller or simpler; its parse runs out of heap or stack on it on every run',
  'changed': 'run again, after stopping whatever is writing the file',
  'worker-died': 'run again',
  'held-cap': HELD_CAP_FIX,
};

/** The causes a rerun may answer: the run, not the bytes, decided. A filesystem fault is retryable exactly when it is `refused`. */
const RETRYABLE_CAUSES: ReadonlySet<NoRowsCause> = new Set(['time-cap', 'changed', 'worker-died']);

/**
 * The remedy for a `defective` pair: the bytes will fail the same way on every run.
 *
 * @param routeAway - How a user stops the pair's instance reading a file
 * @returns The remedy
 */
function defectiveRemedy(routeAway: string): string {
  return `fix the file, or ${routeAway}`;
}

/**
 * The remedy for a `refused` pair with no remedy of its own: the run, not the bytes, decided. What is
 * left after the fault table took the filesystem's faults is a file that changed or vanished while the
 * run read it, and a limit the run sets on itself (time, heap, stack) or a parse worker that died.
 *
 * @param routeAway - How a user stops the pair's instance reading a file
 * @returns The remedy
 */
function refusedRemedy(routeAway: string): string {
  return 'run again, after stopping whatever is writing the file if it changed or vanished while the run read it;'
    + ` if the same file is refused on every run, the parse is running out of time, heap or stack on it, so ${routeAway}`;
}

/** What one filesystem fault class means for a routed file: the words a pair's detail renders, and what helps. */
interface RoutedFault {
  /** The fault in words, never the class name (`refused` would read as the pair state). */
  readonly words: string;
  /** What helps, for a file the user never named: a `defective` pair's ends on its instance's route-away where it is rendered, unless the file is a root input. */
  readonly fix: string;
}

/**
 * Every fault class but absence, as a routed file meets it. The fault table decides the state; its
 * remedies are written for an input a command or a config named ("point the command at ...", "the
 * message names ..."), which a routed file is not, so the words here are the stage's own.
 * Keyed by the class list, so a class utils adds fails the typecheck here.
 */
const ROUTED_FAULTS: Readonly<Record<Exclude<FsFaultClass, 'absent'>, RoutedFault>> = {
  refused: { words: 'permission was refused', fix: 'grant read permission on the file' },
  'wrong-type': { words: 'it is not a regular file (a directory, a pipe, socket or device, a link loop, or a name too long)', fix: 'make the path a regular file' },
  occupied: { words: 'something was in the way at the path', fix: 'remove what is in the way at the path' },
  unsupported: { words: 'its filesystem does not support reading it', fix: 'move the file to a filesystem that can read it' },
  device: { words: 'its disk or network share failed', fix: 'check the disk or network share holding the file, then run again' },
  exhausted: { words: 'the machine ran out of open files, disk space or quota', fix: 'free open files, disk space or quota on this machine, then run again' },
  busy: { words: 'the file was busy', fix: 'wait for whatever holds the file to release it, then run again' },
};

/** Which row-set relations a run's statements name, of every instance. */
export interface RowSetDemand {
  /** The named row-set tables of every instance, in registry order. */
  readonly tables: readonly RowSetTableName[];
  /** Whether `data__routes` is named. */
  readonly dataRoutes: boolean;
  /** Whether `data__values` is named. */
  readonly dataValues: boolean;
  /** Whether `ts__routes` is named. */
  readonly tsRoutes: boolean;
  /** Whether `ts_imports` is named. */
  readonly tsImports: boolean;
  /** Whether a workspace relation (`workspace_packages`, ...) is named: the workspace step runs over the `data` instance. */
  readonly workspace: boolean;
  /** Whether a `tsconfig_*` relation is named: the tsconfig step runs over the `data` instance. */
  readonly tsconfig: boolean;
  /**
   * Whether `ts_import_targets`, `ts_program_files` or `ts_import_conditions` is named: the
   * TypeScript resolve step runs after the tsconfig step, over the `ts` instance's rows, the
   * workspace step's links and the tsconfig step's parsed configs, so it stages both instances and
   * runs both steps (whose own relations are published only when named).
   */
  readonly tsResolve: boolean;
}

/** Whether a demand names a derived relation of an instance, or a step over it, by instance. */
const DERIVED_DEMAND: { readonly [Instance in RowSetInstanceId]: (demand: RowSetDemand) => boolean } = {
  data: (demand) => demand.dataRoutes || demand.dataValues || demand.workspace || demand.tsconfig || demand.tsResolve,
  ts: (demand) => demand.tsRoutes || demand.tsImports || demand.tsResolve,
};

/**
 * Whether a demand stages one instance: a statement names one of its tables, its derived relations
 * or a step over it.
 *
 * @param demand - The run's demand
 * @param instance - The instance
 * @returns True when the instance is staged
 */
export function instanceDemanded(demand: RowSetDemand, instance: RowSetInstanceId): boolean {
  return demand.tables.some((table) => ROW_SET_TABLES[table].instance === instance) || DERIVED_DEMAND[instance](demand);
}

/**
 * The row-set demand from the relations a run's statements name.
 *
 * @param named - Every relation the statements name, by SQL name
 * @returns What is demanded, or `undefined` when no relation of any instance is named
 */
export function rowSetDemandOf(named: ReadonlySet<string>): RowSetDemand | undefined {
  const demand: RowSetDemand = {
    tables: [...ROW_SET_TABLE_BY_NAME].filter(([name]) => named.has(name)).map(([, key]) => key),
    dataRoutes: named.has(DERIVED_TABLES.dataRoutes.name),
    dataValues: named.has(DERIVED_TABLES.dataValues.name),
    tsRoutes: named.has(DERIVED_TABLES.tsRoutes.name),
    tsImports: named.has(DERIVED_TABLES.tsImports.name),
    workspace: [...WORKSPACE_RELATIONS].some((name) => named.has(name)),
    tsconfig: [...TSCONFIG_RELATIONS].some((name) => named.has(name)),
    tsResolve: [...TS_RESOLVE_RELATIONS].some((name) => named.has(name)),
  };
  return ROW_SET_INSTANCES.some(({ instance }) => instanceDemanded(demand, instance)) ? demand : undefined;
}

/** Why one routed pair has no rows this run: what its no-rows finding says. */
export interface RowSetDefect {
  /** The instance the path is routed to: its finding code and words. */
  readonly instance: RowSetInstanceId;
  /** The routed path, relative to its root. */
  readonly path: string;
  readonly state: 'defective' | 'refused';
  /** The per-pair code (`DATA_PARSE_ERROR`, `TS_PARSE_ERROR`, `BLOB_NOT_TEXT`, `PARSE_LIMIT_EXCEEDED`, ...). */
  readonly code: string;
  /** What happened, in words: the parse error's position, the limit and how far past it. */
  readonly detail: string;
  readonly remedy: string;
}

/**
 * One error finding per routed pair that has no rows, at its path, in route order: its instance's
 * code (`DATA_FILE_NO_ROWS`, `TS_FILE_NO_ROWS`), the pair's state, code and detail in the message, its
 * remedy as the fix. Lane-owned (a `NonOverridableCode`): no `validation.severity` key moves it, so
 * the one way to stop a file failing the run is to fix it or route it away with its instance's
 * `exclude`, both visible in the tree.
 *
 * @param defects - The stage's defects
 * @returns The findings
 */
export function rowSetDefectIssues(defects: readonly RowSetDefect[]): ValidationIssue[] {
  return defects.map((defect) => {
    const { noRows, routesRelation } = rowSetInstance(defect.instance);
    return {
      // One code per instance whatever the pair code, which the message names (each a literal in the descriptor, so the doc test sees it).
      code: noRows.code,
      severity: 'error',
      fix: defect.remedy,
      ...anchoredAt(
        `'${defect.path}' is routed to the ${defect.instance} instance and has no rows this run: ${defect.state} ${defect.code}: ${defect.detail}.`
          + ` ${noRows.answering} answers without it; ${routesRelation} names it.`,
        defect.path,
      ),
    };
  });
}

/** Where one row-set table's rows reach the run database from: the rows in hand, or a copy from the store. */
export type RowSetSource =
  | { readonly rows: readonly Readonly<Record<string, unknown>>[] }
  | { readonly stored: { readonly tier: 'rowSet'; readonly store: FactStore; readonly ids: readonly RowSetId[] } };

/** The derived row-set relations a run named, each with its rows. */
export interface DataDerivedRows {
  readonly dataRoutes?: readonly DataRouteRow[];
  readonly dataValues?: readonly DataValueRow[];
  readonly tsRoutes?: readonly TsRouteRow[];
  readonly tsImports?: readonly TsImportsRow[];
}

/** What one row-set stage answers. */
export type DataStageResult =
  | {
    /** The config declares a demanded instance and does not allow emptiness, and it, or one `include` glob, routed nothing in the run's extent. */
    readonly outcome: 'examined-nothing';
    readonly message: string;
  }
  | {
    readonly outcome: 'staged';
    /** Each named row-set table's source. */
    readonly sources: ReadonlyMap<RowSetTableName, RowSetSource>;
    /** Each named derived relation's rows, from the `facts` pairs. */
    readonly derived: DataDerivedRows;
    /** Every routed pair that has no rows, in route order; empty when every pair is `facts`. */
    readonly defects: readonly RowSetDefect[];
    /**
     * The demanded instances the run could not route at all, each with the coded error that refuses
     * every statement naming one of its relations: a git-content-only instance with no git answer.
     * Such an instance has no sources, derived rows or defects.
     */
    readonly refusals: ReadonlyMap<RowSetInstanceId, Error>;
    /** The workspace step's rows or refusal, when a workspace relation is demanded. */
    readonly workspace?: WorkspaceAnswer;
    /** The tsconfig step's rows or refusal, with the TypeScript version that answered, when a `tsconfig_*` relation is demanded. */
    readonly tsconfig?: TsconfigAnswer;
    /**
     * The TypeScript resolve step's rows or refusal, with the TypeScript version that answered, when
     * one of its three relations is demanded and the `ts` instance was not refused (a refused
     * instance is git's no-answer, which refuses the listing these relations are defined over).
     */
    readonly tsResolve?: TsResolveAnswer;
  };

/** A staged answer with the handle a resolve step reads through: the seam a test of the handle reaches. */
interface StagedWithReads {
  readonly result: DataStageResult;
  /** The handle over a declared set, when the stage staged. */
  readonly declaredReads: ((declared: readonly DeclaredPair[]) => DeclaredReads) | undefined;
}

/** How the stage reads bytes: only through the run's one content reader. */
interface DataStageContent {
  /** A keyed realization's bytes, re-keyed under its parser kind, or null when the file is gone (`RunContentSource.read`). */
  read(entry: { readonly absolutePath: string; readonly contentKey: ContentKey }): Promise<KeyedContent | null>;
  /** A deferred realization's bytes, read and keyed now under its parser kind. */
  readUnkeyed(absolutePath: string, parserKind: ParserKind): Promise<KeyedContent>;
}

/**
 * The stage's content reader over a run's one read-and-key memo.
 *
 * @param cache - The run's content cache
 * @returns The reader
 */
export function dataStageContentOf(cache: RunContentCache): DataStageContent {
  const source = runContentSource(cache);
  return {
    read: (entry) => source.read(entry),
    readUnkeyed: (absolutePath, parserKind) => readKeyedContent(absolutePath, parserKind, cache),
  };
}

/**
 * Where a test seam acts. Production passes {@link NO_DATA_STAGE_SEAMS}; the query lane passes its
 * env-driven seams, honoured only in a test process.
 */
export interface DataStageSeams {
  /** After the write and its read-back, before any copy, with the run's `facts` row sets in route order. */
  afterWrite(facts: readonly RowSetId[]): void;
  /** Before `data__values` reads the nodes, with the `data` instance's `facts` row sets. */
  beforeValues(facts: readonly RowSetId[]): void;
  /** Before a declared read ({@link DeclaredReads}) reads the store, with the row sets it reads. */
  beforeDeclaredRead(ids: readonly RowSetId[]): void;
}

/** No seam acts. */
export const NO_DATA_STAGE_SEAMS: DataStageSeams = Object.freeze({
  afterWrite: () => undefined,
  beforeValues: () => undefined,
  beforeDeclaredRead: () => undefined,
});

/** The projection tables the stage routes from. */
type DataStageProjection = Pick<QueryProjection, 'roots' | 'resolutionContexts' | 'resourceRealizations'>;

/** One row-set stage's inputs. */
interface DataStageInput {
  readonly demand: RowSetDemand;
  readonly projection: DataStageProjection;
  /** Every instance's static routing. */
  readonly routing: RowSetRoutings;
  readonly content: DataStageContent;
  /** The run's parse dispatcher: extraction runs on its pool, under its limits. */
  readonly extractor: RowSetExtractor;
  /** The run's store and its one reader of it, or `undefined` with the store off. */
  readonly store: { readonly store: FactStore; readonly reads: StoreReads } | undefined;
  readonly seams: DataStageSeams;
  /**
   * The most bytes of extracted rows' JSON, as each instance's byte cap counts them, the stage holds
   * at once, of every instance: store on, what it holds before writing a batch to the store; store
   * off, what it holds at all, past which a file is `refused`. One data file's own byte cap
   * ({@link DATA_OUTPUT_CAPS}) unless a test names less, so a run holds no more extracted rows
   * than one data job may produce.
   */
  readonly rowBytesHeld?: number;
  /**
   * A root's repository top level, or null outside a repository. Defaults to `gitFindRoot`, which
   * the crawl already asked for each root (memoized; it lstats `.git` on the root's ancestors). The
   * stage adds only the realpaths of the root and that top level: no file content above the root
   * is read.
   */
  readonly repositoryTop?: (rootPath: string) => string | null;
  /**
   * The paths under a root that are git content, root-relative, or `undefined` when every
   * realization of the root is (the git crawl lane): what a git-content-only instance routes from.
   * Defaults to {@link gitContentPathsOf}; asked once per root, and only when such an instance is
   * demanded. Throws the snapshot's coded error when git gives no answer.
   */
  readonly gitContentPaths?: (rootPath: string) => ReadonlySet<string> | undefined;
  /** The tsconfig step's inputs: required when the demand names the family or the resolve step, unread otherwise. */
  readonly tsconfig?: TsconfigStageInput;
}

/** What the tsconfig step reads beside the stage's own handle. */
interface TsconfigStageInput {
  /** The run's git content (`gitContentListing`), every root. */
  readonly gitContent: readonly GitContentRow[];
  /** The compiler basenames a script segment is read as invoking (`compilersFromConfig`). */
  readonly compilers: readonly string[];
  /** One parse job: the run's parse dispatcher's `tsconfig`. */
  readonly parse: (job: TsconfigJobInput) => Promise<TsconfigJobAnswer>;
}

/**
 * The paths under a root that are git content: `undefined` (every realization is) when the git crawl
 * enumerates the root, else the files of the run's memoized snapshot under it (symlinks excluded), so
 * the forced filesystem crawl's ignored files are not.
 *
 * @param rootPath - The root, absolute
 * @returns The root-relative paths, or `undefined`
 * @throws The snapshot's own coded error when git gives no answer (outside a work tree, no git binary)
 */
export function gitContentPathsOf(rootPath: string): ReadonlySet<string> | undefined {
  if (gitExtentSelected(rootPath)) return undefined;
  return new Set(snapshotGitContentMembers(rootPath).files.map((absolutePath) => toForwardSlash(safePath.relative(rootPath, absolutePath))));
}

/**
 * The roots that sit below their repository's top level: a workspace above one may enclose it.
 *
 * Compared as the directories they are, not as spelled: git may report the top level through a
 * symlink the root's path does not take (`/private/var` for `/var` on macOS), and the same
 * directory spelled twice is not "below". A path that cannot be resolved compares as spelled.
 *
 * @param input - The stage's input
 * @param input.projection - Its roots
 * @param input.repositoryTop - A root's repository top level, or null outside a repository
 * @returns Their ids
 */
export function rootsBelowRepositoryTop(input: {
  readonly projection: { readonly roots: ReadonlyArray<Pick<QueryProjection['roots'][number], 'id' | 'path'>> };
  readonly repositoryTop?: DataStageInput['repositoryTop'];
}): Set<string> {
  const topOf = input.repositoryTop ?? gitFindRoot;
  return new Set(input.projection.roots.flatMap((root) => {
    const top = topOf(root.path);
    return top !== null && directoryOf(top) !== directoryOf(root.path) ? [root.id] : [];
  }));
}

/**
 * An edge path's realpath, forward-slashed; its own spelling when the filesystem cannot resolve it
 * (absent, refused, a link chain VAT will not follow), since a spelling is still a comparison. Any
 * other throw is a defect, and surfaces.
 */
function directoryOf(path: string): string {
  try {
    return realpathNativeSync(path, path);
  } catch (error) {
    if (fsFaultOf(error) === undefined) throw error;
    return toForwardSlash(path);
  }
}

/** One realization an instance reads. */
interface Route {
  readonly descriptor: RowSetInstanceDescriptor;
  readonly root: string;
  readonly path: string;
  readonly absolutePath: string;
  /** One of the descriptor's instance's variants, as its routing named it. */
  readonly variant: string;
  readonly contentKey: ContentKey | null;
  readonly contentState: QueryProjection['resourceRealizations'][number]['contentState'];
  readonly contentFaultClass: FsFaultClass | null;
  readonly mime: string | null;
}

/** Why one pair has no rows. */
interface PairFailure {
  readonly state: 'defective' | 'refused';
  readonly code: string;
  readonly detail: string;
  readonly cause: NoRowsCause;
  /** A filesystem fault's own fix, from {@link ROUTED_FAULTS}: present exactly when `cause` is `fs`. */
  readonly fix?: string;
}

/** What a pair with no rows is told to do, and whether a rerun may give it rows. */
interface NoRowsRemedy {
  readonly remedy: string;
  readonly retryable: boolean;
}

/**
 * The one remedy for a pair with no rows: its no-rows finding's fix, and (for a root input of the
 * workspace step) the root's `WORKSPACE_ROOT_NO_ROWS` remedy, so the two never disagree. Any other
 * pair may be routed away; a root input may not, since routing it away refuses its root
 * `DATA_REQUEST_UNROUTED`, whose only remedy is to route it back.
 *
 * @param failure - Why the pair has no rows
 * @param rootInput - Whether the pair is a root input of a workspace step this run runs
 * @param routeAway - How a user stops the pair's instance reading a file
 * @returns The remedy, and whether a rerun may answer
 */
function noRowsRemedy(failure: PairFailure, rootInput: boolean, routeAway: string): NoRowsRemedy {
  const retryable = failure.cause === 'fs' ? failure.state === 'refused' : RETRYABLE_CAUSES.has(failure.cause);
  if (failure.cause === 'fs') {
    const fix = failure.fix ?? '';
    return { remedy: failure.state === 'defective' && !rootInput ? `${fix}, or ${routeAway}` : fix, retryable };
  }
  if (rootInput) return { remedy: ROOT_INPUT_REMEDIES[failure.cause], retryable };
  if (failure.cause === 'held-cap') return { remedy: `${HELD_CAP_FIX}, or ${routeAway}`, retryable };
  return { remedy: failure.state === 'defective' ? defectiveRemedy(routeAway) : refusedRemedy(routeAway), retryable };
}

/** A route with its row set, or why it has none before any extraction. */
type ResolvedRoute = { readonly route: Route; readonly id: RowSetId } | { readonly route: Route; readonly failure: PairFailure };

/** Any instance's routes row: every instance's routes relation has the one shape. */
type RouteRow = DataRouteRow | TsRouteRow;

/** The routes of the demanded instances, and the instances refused before any route. */
interface InstanceRoutes {
  /** Every route, instance by instance, each in projection order. */
  readonly routes: readonly Route[];
  readonly refusals: ReadonlyMap<RowSetInstanceId, Error>;
}

/**
 * Run the row-set stage for one attempt of a query.
 *
 * @param input - The run's demand, projection, routing, reader, extractor, store and seams
 * @returns Each named relation's source or rows, and the defects, or the examined-nothing refusal
 * @throws A {@link StoredRowsEvictedError} of the row-set tier when a row set the run wrote or was
 *   served left the store before it was read back
 */
export async function runDataStage(input: DataStageInput): Promise<DataStageResult> {
  return (await runDataStageWithReads(input)).result;
}

/**
 * {@link runDataStage}, with the declared-reads handle a resolve step reads through. Module-only: the
 * handle is the stage's to hand its steps, never a caller's.
 *
 * @param input - The run's demand, projection, routing, reader, extractor, store and seams
 * @returns The stage's answer, and the handle when it staged
 * @throws A {@link StoredRowsEvictedError} of the row-set tier, as {@link runDataStage}
 */
export async function runDataStageWithReads(input: DataStageInput): Promise<StagedWithReads> {
  const { routes, refusals } = staticRoutes(input);
  const emptiness = emptinessOf(input, routes, refusals);
  if (emptiness !== undefined) return { result: { outcome: 'examined-nothing', message: emptiness }, declaredReads: undefined };
  const resolved = await Promise.all(routes.map((route) => resolveRoute(route, input.content)));
  const held = await heldRowSets(distinctIds(resolved), resolved, input);
  input.seams.afterWrite(held.facts);
  const states = resolved.map((entry) => routeState(entry, held));
  countRefusedPairs(states);
  const read = heldRead(input, held);
  const dataStates = states.filter((state) => state.instance === DATA_INSTANCE);
  const dataRouteRows = dataStates.map((state) => state.row as DataRouteRow);
  const tsRouteRows = states.filter((state) => state.instance === TS_INSTANCE).map((state) => state.row as TsRouteRow);
  // A resolve demand runs the tsconfig step for its configs, and either runs the workspace step for its links: each
  // step's rows are published only when one of its own relations is named.
  const tsconfigRuns = input.demand.tsconfig || input.demand.tsResolve;
  const workspaceRuns = input.demand.workspace || tsconfigRuns;
  // Every place a step declared, so a root input's remedy and the run's report are both decided from what the step reads.
  const declaredPlaces = new Set<string>();
  const failureAt = new Map(states.flatMap(({ instance, row, failure }) => (failure === undefined ? [] : [[failureKey(instance, row), failure] as const])));
  const remedyOf = (state: RouteState, failure: PairFailure): NoRowsRemedy => {
    const { row, instance } = state;
    const rootInput = instance === DATA_INSTANCE && declaredPlaces.has(placeOf(row))
      && ((workspaceRuns && isWorkspaceRootInput(row.path)) || (tsconfigRuns && isTsconfigRootInput(row.path)));
    return noRowsRemedy(failure, rootInput, rowSetInstance(instance).noRows.routeAway);
  };
  const declaredReads = (declared: readonly DeclaredPair[]): DeclaredReads => {
    for (const pair of declared) if (pair.instance === DATA_INSTANCE) declaredPlaces.add(placeOf(pair));
    return declaredReadsOver(declared, {
      routing: input.routing,
      routes: dataRouteRows,
      tsRoutes: instanceDemanded(input.demand, TS_INSTANCE) ? tsRouteRows : undefined,
      read: (ids, request) => read(ids, request, { relation: relationOf(request.tables), before: input.seams.beforeDeclaredRead }),
      noRows: (instance, route) => {
        const failure = failureAt.get(failureKey(instance, route));
        if (failure === undefined) throw new Error(`The routed pair '${route.path}' is ${route.state} with no failure.`);
        return remedyOf({ instance, row: route, failure }, failure);
      },
    });
  };
  const workspace = workspaceRuns
    ? await resolveWorkspace({ roots: input.projection.roots.map((root) => root.id), files: heldFiles(input.projection), belowRepositoryTop: rootsBelowRepositoryTop(input), declaredReads })
    : undefined;
  const links = linksOf(workspace);
  const tsconfig = tsconfigRuns
    ? await resolveTsconfig({ ...tsconfigInputOf(input), roots: input.projection.roots, files: heldFiles(input.projection), declaredReads, links })
    : undefined;
  // After the tsconfig step, over its parsed configs; TypeScript loads on this thread only here.
  const tsResolve = tsconfig !== undefined && input.demand.tsResolve && !refusals.has(TS_INSTANCE)
    ? await resolveTsImports({ roots: input.projection.roots, tsconfig, workspace, links, gitContent: tsconfigInputOf(input).gitContent, tsRoutes: tsRouteRows, declaredReads })
    : undefined;
  // A run whose statements name only workspace_* or tsconfig_* relations of the data instance reads only what those steps declared, so it reports only those.
  const dataStepsOnly = !input.demand.tables.some((table) => ROW_SET_TABLES[table].instance === DATA_INSTANCE) && !input.demand.dataRoutes && !input.demand.dataValues;
  const reported = ({ instance, row }: RouteState): boolean => instance !== DATA_INSTANCE || !dataStepsOnly || declaredPlaces.has(placeOf(row));
  const result: DataStageResult = {
    outcome: 'staged',
    sources: sourcesOf(input, held),
    derived: {
      ...(input.demand.dataRoutes ? { dataRoutes: dataRouteRows } : {}),
      ...(input.demand.dataValues ? { dataValues: dataValueRows(dataRouteRows, await nodesOf(input, held, read)) } : {}),
      ...(input.demand.tsRoutes ? { tsRoutes: tsRouteRows } : {}),
      ...(input.demand.tsImports ? { tsImports: tsImportsRows(tsRouteRows, await importsOf(held, read)) } : {}),
    },
    defects: defectsOf(states, reported, remedyOf),
    refusals,
    ...(workspace === undefined || !input.demand.workspace ? {} : { workspace }),
    ...(tsconfig === undefined || !input.demand.tsconfig ? {} : { tsconfig }),
    ...(tsResolve === undefined ? {} : { tsResolve }),
  };
  return { result, declaredReads };
}

/**
 * Each root's workspace link table, from the workspace step's rows. A refused root has no package
 * or dependency rows, so it has no links, and a refused family has none at all: every
 * `node_modules` path under such a root does not exist, as with no workspace.
 *
 * @param workspace - The workspace step's answer, when it ran
 * @returns The tables, by root id; a root absent has no links
 */
function linksOf(workspace: WorkspaceAnswer | undefined): Map<string, WorkspaceLinkTable> {
  const tables = new Map<string, WorkspaceLinkTable>();
  if (workspace?.outcome !== 'rows') return tables;
  const roots = new Set(workspace.packages.map((row) => row.root));
  for (const root of roots) {
    const mine = <Row extends { readonly root: string }>(row: Row): boolean => row.root === root;
    // Keyed by spelling: the job re-keys under TypeScript's own case rule, which only it can ask.
    tables.set(root, workspaceLinks(workspace.packages.filter(mine), workspace.dependencies.filter(mine), false));
  }
  return tables;
}

/** @returns A text key for a route's failure: its instance and place */
function failureKey(instance: RowSetInstanceId, at: Pick<RouteRow, 'root' | 'path'>): string {
  return `${instance}\0${placeOf(at)}`;
}

/** @returns A text key for a path under a root */
function placeOf(at: Pick<RouteRow, 'root' | 'path'>): string {
  return `${at.root}\0${at.path}`;
}

/**
 * The tsconfig step's inputs a demand for the family requires.
 *
 * @param input - The stage's input
 * @returns The inputs
 * @throws Error when the caller demanded the family without handing them (a defect of the caller)
 */
function tsconfigInputOf(input: DataStageInput): TsconfigStageInput {
  if (input.tsconfig === undefined) throw new Error('The data stage was demanded the tsconfig or TypeScript resolve relations without the tsconfig step\'s inputs (git content, compilers, parse).');
  return input.tsconfig;
}

/**
 * Every path the run holds a file with content at, by root id: what a resolve step's own inputs
 * are named from, before it declares a read.
 *
 * @param projection - The run's projection
 * @returns The paths, by root id
 */
function heldFiles(projection: DataStageProjection): Map<string, Set<string>> {
  const rootOf = rootsByExtent(projection);
  const files = new Map<string, Set<string>>();
  for (const realization of projection.resourceRealizations) {
    if (realization.contentState === 'none') continue;
    const root = rootOf(realization.extentId).id;
    const held = files.get(root);
    if (held === undefined) files.set(root, new Set([realization.path]));
    else held.add(realization.path);
  }
  return files;
}

/**
 * Every realization each demanded instance's routing reads, instance by instance, each in projection
 * order, with its root. A git-content-only instance with no git answer is refused, not routed.
 *
 * @param input - The stage's inputs
 * @returns The routes, and the refused instances
 * @throws Any error routing raises other than git giving no answer
 */
function staticRoutes(input: DataStageInput): InstanceRoutes {
  const routes: Route[] = [];
  const refusals = new Map<RowSetInstanceId, Error>();
  const isGitContent = gitContentOf(input);
  for (const descriptor of ROW_SET_INSTANCES.filter(({ instance }) => instanceDemanded(input.demand, instance))) {
    try {
      appendAll(routes, instanceRoutes(input, descriptor, isGitContent));
    } catch (error) {
      if (!isVatError(error, GIT_NO_ANSWER_CODE) && !isVatError(error, GIT_NOT_FOUND_CODE)) throw error;
      refusals.set(descriptor.instance, error);
    }
  }
  return { routes, refusals };
}

/** Whether a root-relative path under a root is git content. */
type GitContentTest = (root: { readonly id: string; readonly path: string }, path: string) => boolean;

/**
 * The git-content test over the stage's `gitContentPaths`, asked once per root.
 *
 * @param input - The stage's inputs
 * @returns The test
 */
function gitContentOf(input: DataStageInput): GitContentTest {
  const pathsOf = input.gitContentPaths ?? gitContentPathsOf;
  const byRoot = new Map<string, ReadonlySet<string> | undefined>();
  return (root, path) => {
    if (!byRoot.has(root.id)) byRoot.set(root.id, pathsOf(root.path));
    const paths = byRoot.get(root.id);
    return paths === undefined || paths.has(path);
  };
}

/**
 * One instance's routes, in projection order.
 *
 * @param input - The stage's inputs
 * @param descriptor - The instance
 * @param isGitContent - Whether a path is git content, for a git-content-only instance
 * @returns The routes; a realization with no content (`none`: a dangling link, a directory) is not routed
 */
function instanceRoutes(input: DataStageInput, descriptor: RowSetInstanceDescriptor, isGitContent: GitContentTest): Route[] {
  const rootOf = rootsByExtent(input.projection);
  const routes: Route[] = [];
  for (const realization of input.projection.resourceRealizations) {
    if (realization.contentState === 'none') continue;
    const variant = descriptor.variantOf(realization.path, input.routing);
    if (variant === undefined) continue;
    const root = rootOf(realization.extentId);
    if (descriptor.gitContentOnly && !isGitContent(root, realization.path)) continue;
    routes.push({
      descriptor,
      root: root.id,
      path: realization.path,
      absolutePath: safePath.join(root.path, realization.path),
      variant,
      contentKey: realization.contentKey,
      contentState: realization.contentState,
      contentFaultClass: realization.contentFaultClass,
      mime: realization.mime,
    });
  }
  return routes;
}

/**
 * Why the routing is a config error over this run's extent: the first demanded, unrefused instance
 * that is declared, does not allow emptiness and routed nothing.
 *
 * @param input - The stage's inputs
 * @param routes - Every route
 * @param refusals - The refused instances, which routed nothing to judge
 * @returns The `CONFIG_INVALID` message, or undefined
 */
function emptinessOf(input: DataStageInput, routes: readonly Route[], refusals: ReadonlyMap<RowSetInstanceId, Error>): string | undefined {
  for (const { instance } of ROW_SET_INSTANCES) {
    if (!instanceDemanded(input.demand, instance) || refusals.has(instance)) continue;
    const routed = routes.filter((route) => route.descriptor.instance === instance).length;
    const refusedCredentials = instance === 'data' && routed === 0
      ? dataCredentialFileFindings(input.projection.resourceRealizations, input.routing.data).length
      : 0;
    const emptiness = routingEmptiness(instance, routed, input.routing[instance], refusedCredentials);
    if (emptiness !== undefined) return emptiness;
  }
  return undefined;
}

/**
 * The root each extent's realizations are under: its resolution context's root, or the run's one
 * root when a realization's extent has none.
 *
 * @param projection - The run's projection
 * @returns The lookup
 * @throws Error When an extent's root cannot be named
 */
function rootsByExtent(projection: DataStageProjection): (extentId: string) => { readonly id: string; readonly path: string } {
  const roots = new Map(projection.roots.map((root) => [root.id, root]));
  const rootIdOf = new Map(projection.resolutionContexts.map((context) => [context.contextId, context.rootId]));
  return (extentId) => {
    const rootId = rootIdOf.get(extentId) ?? (projection.roots.length === 1 ? projection.roots[0]?.id : undefined);
    const root = rootId === undefined ? undefined : roots.get(rootId);
    if (root === undefined) throw new Error(`The extent ${extentId} names no root in this projection, so its row-set routes have no root.`);
    return root;
  };
}

/**
 * A route's row set, or why it has none, from its realization's content state. A deferred
 * realization is read and keyed now, through the run's reader. An unreadable one is never read
 * again: the fault class the population recorded from its one failed read decides the pair's state
 * by the fault table.
 *
 * @param route - The route
 * @param content - The run's content reader
 * @returns The resolved route
 */
async function resolveRoute(route: Route, content: DataStageContent): Promise<ResolvedRoute> {
  const idOf = (contentKey: ContentKey): ResolvedRoute => ({ route, id: rowSetIdOf(contentKey, route.descriptor.instance, route.variant) });
  if (route.contentKey !== null) return idOf(route.contentKey);
  if (route.contentFaultClass !== null) return { route, failure: fsFailureOf(route.contentFaultClass, (words) => `the population could not read it: ${words}`) };
  if (route.contentState === 'oversize') {
    return { route, failure: { state: 'defective', code: 'PARSE_LIMIT_EXCEEDED', detail: 'it is past the input cap (inputBytes)', cause: 'bytes-cap' } };
  }
  try {
    return idOf((await content.readUnkeyed(route.absolutePath, parserKindForMime(route.mime))).key);
  } catch (error) {
    return { route, failure: failureOf(error) };
  }
}

/**
 * The row sets of the resolved routes, each once, in route order.
 *
 * @param resolved - The resolved routes
 * @returns The ids
 */
function distinctIds(resolved: readonly ResolvedRoute[]): RowSetId[] {
  const seen = new Map<RowSetIdText, RowSetId>();
  for (const entry of resolved) {
    if ('id' in entry && !seen.has(rowSetIdText(entry.id))) seen.set(rowSetIdText(entry.id), entry.id);
  }
  return [...seen.values()];
}

/** Some row sets' head rows, of every instance; a head table that is absent holds none. */
type HeadRows = Partial<Pick<RowSetRows, RowSetHeadTableName>>;

/** What the stage holds after coverage, extraction, the write and its read-back. */
interface HeldRowSets {
  /** The `facts` row sets, in route order, of every instance. */
  readonly facts: readonly RowSetId[];
  /** Why each other row set has no rows. */
  readonly failures: ReadonlyMap<RowSetIdText, PairFailure>;
  /** Store off: every table's rows in hand. Store on: undefined, every consumer reads the reader. */
  readonly inHand: Readonly<MutableRowSetRows> | undefined;
}

/**
 * The head tables of the instances some row sets belong to, in instance order.
 *
 * @param ids - The row sets
 * @returns Their head tables, each once
 */
function headTablesOf(ids: readonly RowSetId[]): RowSetHeadTableName[] {
  const instances = new Set(ids.map((id) => id.instance));
  return ROW_SET_INSTANCES.filter(({ instance }) => instances.has(instance)).map(({ head }) => head);
}

/**
 * Read the head rows of some row sets through the reader: what coverage and presence are read from.
 *
 * @param reads - The run's reader
 * @param ids - The row sets
 * @returns Their head rows, every instance's
 */
function headsOf(reads: StoreReads, ids: readonly RowSetId[]): Promise<HeadRows> {
  return ids.length === 0 ? Promise.resolve({}) : reads.rowSets(ids, { tables: headTablesOf(ids) });
}

/**
 * Serve what the store covers, extract the rest, and (store on) write what was extracted and read
 * its head rows back through the reader. One writer serves every instance.
 *
 * @param ids - The routed row sets, of every demanded instance
 * @param resolved - The resolved routes, for each row set's path
 * @param input - The stage's inputs
 * @returns What the run holds
 */
async function heldRowSets(ids: readonly RowSetId[], resolved: readonly ResolvedRoute[], input: DataStageInput): Promise<HeldRowSets> {
  const { store } = input;
  const servedHeads = store === undefined ? {} : await headsOf(store.reads, ids);
  const { covered, uncovered } = rowSetCoverage(servedHeads, ids);
  if (covered.length > 0) countWork('rowSet.storeServed', covered.length);
  const limit = input.rowBytesHeld ?? DATA_OUTPUT_CAPS.outputBytes;
  if (store === undefined) {
    const inHand = new InHandRows(limit);
    const extraction = await extractAll(uncovered, resolved, input, inHand);
    return { facts: extraction.extracted, failures: extraction.failures, inHand: inHand.sorted() };
  }
  const writer = new BatchedRowSetWriter(store.reads, { servedHeads, covered }, limit);
  const extraction = await extractAll(uncovered, resolved, input, writer);
  await writer.finish();
  const writtenHeads = await headsOf(store.reads, extraction.extracted);
  assertPresent(extraction.extracted, writtenHeads, relationOf(headTablesOf(extraction.extracted)));
  // Every head row the reader answered is a `facts` row set: the served ones and the written ones read back.
  const facts = new Set([...covered, ...extraction.extracted].map((id) => rowSetIdText(id)));
  return { facts: ids.filter((id) => facts.has(rowSetIdText(id))), failures: extraction.failures, inHand: undefined };
}

/**
 * Refuse the attempt when a row set the run holds is missing from what the reader answered: it left
 * the store since the run read or wrote it.
 *
 * @param ids - The row sets the run holds
 * @param heads - The head rows the reader answered for them
 * @param relation - What was being read
 * @throws A {@link StoredRowsEvictedError} of the row-set tier naming the missing row sets
 */
function assertPresent(ids: readonly RowSetId[], heads: HeadRows, relation: string): void {
  const present = new Set(headIdsOf(heads).map((id) => rowSetIdText(id)));
  const missing = ids.filter((id) => !present.has(rowSetIdText(id)));
  if (missing.length > 0) throw new StoredRowsEvictedError({ tier: 'rowSet', relation, ids: missing });
}

/** What extracting the uncovered row sets produced. */
interface Extraction {
  /** The row sets the holder took, in the order they were uncovered. */
  readonly extracted: readonly RowSetId[];
  readonly failures: ReadonlyMap<RowSetIdText, PairFailure>;
}

/** One extraction's rows, and the bytes of their JSON as its instance's byte cap counted them. */
type ExtractedRows = Extract<RowSetAnswer, { outcome: 'rows' }>;

/**
 * Where extracted rows go the moment their extraction settles, so no run holds every row set at
 * once only to hand them on together.
 */
interface RowHolder {
  /**
   * Take one row set's rows.
   *
   * @returns Why the run cannot hold them, or `undefined` once they are held
   */
  take(id: RowSetId, extracted: ExtractedRows): Promise<PairFailure | undefined>;
}

/**
 * Extract every uncovered row set from its bytes, each read once through the run's reader, handing
 * each one's rows to `holder` as its extraction settles.
 *
 * @param uncovered - The row sets to extract
 * @param resolved - The resolved routes, for each row set's first path
 * @param input - The stage's inputs
 * @param holder - Where the rows go
 * @returns The row sets held, and why each other one has none
 */
async function extractAll(uncovered: readonly RowSetId[], resolved: readonly ResolvedRoute[], input: DataStageInput, holder: RowHolder): Promise<Extraction> {
  const pathOf = new Map<RowSetIdText, string>();
  for (const entry of resolved) {
    if ('id' in entry && !pathOf.has(rowSetIdText(entry.id))) pathOf.set(rowSetIdText(entry.id), entry.route.absolutePath);
  }
  const failures = new Map<RowSetIdText, PairFailure>();
  await Promise.all(uncovered.map(async (id) => {
    const outcome = await extractOne(id, pathOf.get(rowSetIdText(id)) ?? '', input);
    const failure = 'failure' in outcome ? outcome.failure : await holder.take(id, outcome.rows);
    if (failure !== undefined) failures.set(rowSetIdText(id), failure);
  }));
  const extracted = uncovered.filter((id) => !failures.has(rowSetIdText(id)));
  if (extracted.length > 0) countWork('rowSet.extracted', extracted.length);
  return { extracted, failures };
}

/**
 * Store off: every held row set's rows stay in hand, since every relation is answered from them,
 * so the run holds at most `limit` bytes of them, of every instance. A row set that would pass it is
 * `refused`: the run, not the file, decided, and naming the file is the answer an out-of-memory
 * abort never gives. Which file that is depends on the order extractions settle in.
 */
class InHandRows implements RowHolder {
  readonly #rows = emptyRowSetRows();
  #bytes = 0;

  constructor(private readonly limit: number) {}

  take(id: RowSetId, extracted: ExtractedRows): Promise<PairFailure | undefined> {
    if (this.#bytes + extracted.bytes > this.limit) {
      return Promise.resolve({
        state: 'refused',
        code: 'PARSE_LIMIT_EXCEEDED',
        detail: `the run already holds ${String(this.#bytes)} bytes of rows with no store to write them to, and this file's ${String(extracted.bytes)} would pass the ${String(this.limit)} a run holds in hand (one data file's byte cap)`,
        cause: 'held-cap',
      });
    }
    this.#bytes += extracted.bytes;
    appendRows(this.#rows, id, extracted.tables);
    return Promise.resolve(undefined);
  }

  /** @returns The rows held, each table in primary-key order */
  sorted(): MutableRowSetRows {
    return sortedRows(this.#rows);
  }
}

/**
 * Store on: rows go to the store in batches of about `limit` bytes as their extractions settle, so
 * the run holds one batch (plus whatever settles while one is written), never every row set at
 * once. One writer serves every instance, and each write carries the head rows of what the run was
 * served and of every row set an earlier batch wrote, of every instance, listed as covered at read:
 * the store rewrites none of them and evicts none of them for this write, as one write of
 * everything would not have, so one instance's batch never evicts another's row sets.
 */
class BatchedRowSetWriter implements RowHolder {
  #batch = emptyRowSetRows();
  #batchBytes = 0;
  /** The writes, one after another: each one's covered list names every batch before it. */
  #writing: Promise<void> = Promise.resolve();
  readonly #writtenHeads = emptyRowSetRows();
  readonly #writtenIds: RowSetId[] = [];

  constructor(
    private readonly reads: StoreReads,
    private readonly served: { readonly servedHeads: HeadRows; readonly covered: readonly RowSetId[] },
    private readonly limit: number,
  ) {}

  async take(id: RowSetId, extracted: ExtractedRows): Promise<undefined> {
    appendRows(this.#batch, id, extracted.tables);
    this.#batchBytes += extracted.bytes;
    if (this.#batchBytes >= this.limit) await this.#flush();
    return undefined;
  }

  /** Write what is left, and wait for every write. */
  async finish(): Promise<void> {
    await this.#flush();
  }

  #flush(): Promise<void> {
    const batch = this.#batch;
    this.#batch = emptyRowSetRows();
    this.#batchBytes = 0;
    if (ROW_SET_INSTANCES.some(({ head }) => batch[head].length > 0)) this.#writing = this.#writing.then(() => this.#write(sortedRows(batch)));
    return this.#writing;
  }

  async #write(rows: MutableRowSetRows): Promise<void> {
    await this.reads.writeSets({
      rows: withHeads(rows, this.served.servedHeads, this.#writtenHeads),
      coveredAtRead: [...this.served.covered, ...this.#writtenIds],
    });
    appendHeads(this.#writtenHeads, rows);
    appendAll(this.#writtenIds, headIdsOf(rows));
  }
}

/**
 * A batch's rows with more head rows after its own, every instance's head table.
 *
 * @param rows - The batch
 * @param more - The head rows to list after the batch's, in order
 * @returns The rows to write
 */
function withHeads(rows: MutableRowSetRows, ...more: readonly HeadRows[]): MutableRowSetRows {
  const out: Record<string, readonly unknown[]> = { ...rows };
  for (const { head } of ROW_SET_INSTANCES) out[head] = [rows[head], ...more.map((heads) => heads[head] ?? [])].flat();
  return out as unknown as MutableRowSetRows;
}

/**
 * Add some rows' head rows, every instance's, to a holder's.
 *
 * @param target - The holder's rows
 * @param rows - The rows whose heads are added
 */
function appendHeads(target: MutableRowSetRows, rows: HeadRows): void {
  for (const { head } of ROW_SET_INSTANCES) appendAll(target[head] as unknown[], rows[head] ?? []);
}

/** The rows of one extraction, or why it has none. */
type ExtractOutcome = { readonly rows: ExtractedRows } | { readonly failure: PairFailure };

/**
 * Read one row set's bytes through the run's reader and extract its rows on the pool, through its
 * instance's extractor.
 *
 * @param id - The row set
 * @param absolutePath - Where its bytes are
 * @param input - The stage's inputs
 * @returns Its rows, or why it has none
 */
async function extractOne(id: RowSetId, absolutePath: string, input: DataStageInput): Promise<ExtractOutcome> {
  try {
    const keyed = await input.content.read({ absolutePath, contentKey: id.contentKey });
    if (keyed === null) return { failure: { state: 'refused', code: BLOB_UNREADABLE, detail: 'the file is gone', cause: 'changed' } };
    if (keyed.key !== id.contentKey) {
      return { failure: { state: 'refused', code: BLOB_CONTENT_CHANGED, detail: 'its bytes no longer match the key the population recorded', cause: 'changed' } };
    }
    if (contentRoute(keyed).kind === 'not-text') return { failure: { state: 'defective', code: BLOB_NOT_TEXT, detail: 'its bytes are not text', cause: 'malformed' } };
    const answer = await rowSetInstance(id.instance).extract(input.extractor, id, keyed);
    if (answer.outcome === 'defect') return { failure: { state: 'defective', code: answer.code, detail: answer.message, cause: 'malformed' } };
    return { rows: answer };
  } catch (error) {
    return { failure: failureOf(error) };
  }
}

/**
 * Why a read or an extraction failed, as a pair state, or the error itself when it is no pair's.
 *
 * @param error - What the read or the extraction threw
 * @returns The failure
 * @throws `error` when it is neither a limit, a worker death, a size refusal nor a file fault
 */
function failureOf(error: unknown): PairFailure {
  const detail = error instanceof Error ? error.message : String(error);
  if (isParseLimitError(error)) {
    const cause = LIMIT_CAUSES[error.limit];
    return { state: cause === 'bytes-cap' ? 'defective' : 'refused', code: error.code, detail, cause };
  }
  if (isParseWorkerDiedError(error)) return { state: 'refused', code: error.code, detail, cause: 'worker-died' };
  if (isSizeRefusal(error)) return { state: 'defective', code: 'PARSE_LIMIT_EXCEEDED', detail, cause: 'bytes-cap' };
  const fault = fsFaultOf(error);
  if (fault !== undefined) return fsFailureOf(fault.faultClass, () => `reading it failed with ${fault.errno}`);
  throw error;
}

/**
 * A filesystem fault on a routed file's read, as a pair state, by the one fault table: the file is
 * a source the run found as content, so the pair is `defective` exactly where the table refuses
 * `INPUT_UNREADABLE` (a refused permission, a failed device, ...) and `refused` where it stops the
 * run (`RUN_INCOMPLETE`: out of descriptors, a busy path). The fix is the stage's own
 * ({@link ROUTED_FAULTS}), never the table's, which addresses an input someone named.
 *
 * Absence is the one class read otherwise: the population listed the path in this run, so nothing
 * there now is the file vanishing under the run, `refused` like the reader's own "gone"
 * ({@link extractOne}), never the table's restore-the-reference remedy for a path an input names.
 *
 * @param faultClass - The fault's class, as {@link fsFaultOf} read it
 * @param detailOf - What failed, given the class in words; asked for every class but absence
 * @returns The failure
 */
function fsFailureOf(faultClass: FsFaultClass, detailOf: (words: string) => string): PairFailure {
  if (faultClass === 'absent') return { code: BLOB_UNREADABLE, state: 'refused', detail: 'the file is gone', cause: 'changed' };
  const { words, fix } = ROUTED_FAULTS[faultClass];
  const state = fsFaultRefusal('source', faultClass, 'content').refusal === 'INPUT_UNREADABLE' ? 'defective' : 'refused';
  return { code: BLOB_UNREADABLE, detail: detailOf(words), state, cause: 'fs', fix };
}

/**
 * Add one extraction's rows to the stage's, each carrying its row set's `blob` and `variant`.
 *
 * @param rows - The stage's rows
 * @param id - The row set
 * @param extracted - Its rows by table, without the pair
 */
function appendRows(rows: MutableRowSetRows, id: RowSetId, extracted: ExtractedTables): void {
  const pair = { blob: id.contentKey, variant: id.variant };
  for (const [table, tableRows] of Object.entries(extracted) as [RowSetTableName, readonly object[] | undefined][]) {
    appendAll(rows[table] as object[], (tableRows ?? []).map((row) => ({ ...pair, ...row })));
  }
}

/**
 * Each table's rows in its primary-key order, the order a copy from the store scans in.
 *
 * @param rows - The rows
 * @returns The same rows, each table sorted
 */
function sortedRows(rows: MutableRowSetRows): MutableRowSetRows {
  return Object.fromEntries(storedRelationSpecs().filter(isRowSetTable).map((spec) => [
    spec.key,
    (rows[spec.key] as readonly Record<string, unknown>[]).toSorted(compareRows(spec)),
  ])) as unknown as MutableRowSetRows;
}

/** One route's routes row, its instance, and why it has no rows when it is not `facts`. */
interface RouteState {
  readonly instance: RowSetInstanceId;
  readonly row: RouteRow;
  readonly failure: PairFailure | undefined;
}

/**
 * One route's state this run.
 *
 * @param entry - The resolved route
 * @param held - What the run holds
 * @returns Its row and failure
 */
function routeState(entry: ResolvedRoute, held: HeldRowSets): RouteState {
  const { route } = entry;
  const { instance } = route.descriptor;
  // The variant is one the instance's own routing named, so the row is its routes relation's.
  const rowOf = (blob: ContentKey | null, state: RouteRow['state'], code: string | null): RouteRow =>
    ({ root: route.root, path: route.path, variant: route.variant, blob, state, code }) as RouteRow;
  if ('failure' in entry) return { instance, row: rowOf(null, entry.failure.state, entry.failure.code), failure: entry.failure };
  const failure = held.failures.get(rowSetIdText(entry.id));
  if (failure !== undefined) return { instance, row: rowOf(entry.id.contentKey, failure.state, failure.code), failure };
  return { instance, row: rowOf(entry.id.contentKey, 'facts', null), failure: undefined };
}

/**
 * Count `rowSet.refused`: one per routed pair that is `defective` or `refused`, so a row set two
 * paths share counts twice, as each path is its own pair.
 *
 * @param states - Every route's state
 */
function countRefusedPairs(states: readonly RouteState[]): void {
  const refused = states.filter((state) => state.failure !== undefined).length;
  if (refused > 0) countWork('rowSet.refused', refused);
}

/**
 * Every routed pair that has no rows this run and that the run reports, from the routes' states.
 *
 * @param states - Every route's state, in route order
 * @param reported - Whether a route's pair is reported
 * @param remedyOf - A reported pair's remedy
 * @returns The defects, in route order
 */
function defectsOf(states: readonly RouteState[], reported: (state: RouteState) => boolean, remedyOf: (state: RouteState, failure: PairFailure) => NoRowsRemedy): RowSetDefect[] {
  return states.flatMap((state): RowSetDefect[] => {
    const { instance, row, failure } = state;
    if (failure === undefined || !reported(state)) return [];
    return [{ instance, path: row.path, state: failure.state, code: failure.code, detail: failure.detail, remedy: remedyOf(state, failure).remedy }];
  });
}

/**
 * The `facts` row sets of one instance.
 *
 * @param held - What the run holds
 * @param instance - The instance
 * @returns Its `facts` row sets, in route order
 */
function factsOf(held: HeldRowSets, instance: RowSetInstanceId): RowSetId[] {
  return held.facts.filter((id) => id.instance === instance);
}

/**
 * Each named row-set table's source: a copy of the run's `facts` row sets of the table's instance from
 * the store, or the rows in hand.
 *
 * @param input - The stage's inputs
 * @param held - What the run holds
 * @returns The sources, by table
 */
function sourcesOf(input: DataStageInput, held: HeldRowSets): ReadonlyMap<RowSetTableName, RowSetSource> {
  const { store } = input;
  return new Map(input.demand.tables.map((table): [RowSetTableName, RowSetSource] => {
    if (held.inHand !== undefined) return [table, { rows: held.inHand[table] }];
    if (store === undefined) throw new Error('A store-on row-set stage holds no rows in hand.');
    return [table, { stored: { tier: 'rowSet', store: store.store, ids: factsOf(held, ROW_SET_TABLES[table].instance) } }];
  }));
}

/** Where one read of the held row sets is made: what it reads, for an eviction, and the seam before it. */
interface HeldReadSite {
  readonly relation: string;
  readonly before: (ids: readonly RowSetId[]) => void;
}

/** The stage's one read of its `facts` row sets. */
type HeldReader = <Table extends RowSetTableName>(ids: readonly RowSetId[], request: RowSetRequest<Table>, site: HeldReadSite) => Promise<Pick<RowSetRows, Table>>;

/**
 * The one read every consumer of the run's `facts` row sets reads through: store off, the rows in
 * hand; store on, the run's reader, which holds each table of a row set from one read (an extending
 * read reads only the tables not yet held), the head tables of the ids' instances read beside every
 * read so a row set gone from the store is seen.
 *
 * @param input - The stage's inputs
 * @param held - What the run holds
 * @returns The read: the requested tables of `ids`, each in primary-key order
 */
function heldRead(input: DataStageInput, held: HeldRowSets): HeldReader {
  const { inHand } = held;
  const { store } = input;
  return async <Table extends RowSetTableName>(ids: readonly RowSetId[], request: RowSetRequest<Table>, site: HeldReadSite) => {
    if (inHand !== undefined) {
      const wanted = new Set(ids.map((id) => rowSetIdText(id)));
      const ofTable = (table: Table): readonly unknown[] => {
        const { instance } = ROW_SET_TABLES[table];
        return (inHand[table] as readonly { readonly blob: ContentKey; readonly variant: string }[])
          .filter((row) => wanted.has(rowSetIdText(rowSetIdOf(row.blob, instance, row.variant))));
      };
      return Object.fromEntries(request.tables.map((table) => [table, ofTable(table)])) as unknown as Pick<RowSetRows, Table>;
    }
    if (store === undefined) throw new Error('A store-on row-set stage holds no rows in hand.');
    if (ids.length === 0) return Object.fromEntries(request.tables.map((table) => [table, []])) as unknown as Pick<RowSetRows, Table>;
    site.before(ids);
    const answer = await store.reads.rowSets(ids, { tables: [...new Set<RowSetTableName>([...headTablesOf(ids), ...request.tables])] });
    assertPresent(ids, answer, site.relation);
    return Object.fromEntries(request.tables.map((table) => [table, answer[table]])) as unknown as Pick<RowSetRows, Table>;
  };
}

/** @returns The SQL names of some row-set tables, for an eviction's message */
function relationOf(tables: readonly RowSetTableName[]): string {
  return tables.map((table) => ROW_SET_TABLES[table].name).join(', ');
}

/**
 * The nodes of the run's `data` `facts` row sets, for `data__values`, through the stage's one read
 * (store on, an extending read: the head rows already held).
 *
 * @param input - The stage's inputs
 * @param held - What the run holds
 * @param read - The stage's one read
 * @returns The nodes, in primary-key order
 * @throws A {@link StoredRowsEvictedError} of the row-set tier when a row set left the store since its head row was read
 */
async function nodesOf(input: DataStageInput, held: HeldRowSets, read: HeldReader): Promise<readonly DataNodeRow[]> {
  const site = { relation: DERIVED_TABLES.dataValues.name, before: input.seams.beforeValues };
  return (await read(factsOf(held, DATA_INSTANCE), { tables: ['dataNodes'] }, site)).dataNodes;
}

/**
 * The imports of the run's `ts` `facts` row sets, for `ts_imports`, through the stage's one read
 * (store on, an extending read: the head rows already held, so no row is decoded twice).
 *
 * @param held - What the run holds
 * @param read - The stage's one read
 * @returns The imports, in primary-key order
 * @throws A {@link StoredRowsEvictedError} of the row-set tier when a row set left the store since its head row was read
 */
async function importsOf(held: HeldRowSets, read: HeldReader): Promise<readonly TsImportRow[]> {
  const site = { relation: DERIVED_TABLES.tsImports.name, before: () => undefined };
  return (await read(factsOf(held, TS_INSTANCE), { tables: ['tsImports'] }, site)).tsImports;
}
