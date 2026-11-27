/**
 * What the query lane holds in memory, and where its `blob_references` rows come from.
 *
 * The query lane (`vat resources query`, the checks child of `vat validate`) runs SQL on a run
 * database and reads a few tables in process: the built-in checks, the authored-link lens, the
 * not-admitted findings. In process, nothing reads a LEXICAL reference (`bare-token`,
 * `at-prefixed`, `env-anchored`); only SQL can. On a store hit those rows, most of the tier, are
 * therefore never decoded into JavaScript: the run database copies them from the store inside
 * SQLite, and the in-process projection holds the AST forms alone.
 *
 * 🔑 The narrowed field is a different field, not a narrower array under the old name. A
 * {@link QueryProjection} has no `blobReferences`, so it is not assignable to a `Projection`, and
 * code that wants a lexical reference from it does not compile: it reads `astReferences`, whose
 * `syntacticForm` is typed {@link AstSyntacticForm}, so `row.syntacticForm === 'bare-token'` is a
 * type error rather than a silent empty answer.
 */

import { deepFreeze, isVatError, VatError } from '@vibe-agent-toolkit/utils';

import type { ContentKey } from '../content-key.js';
import type { LexicalReference } from '../schemas/parse-facts.js';
import type { BlobReferenceRow, ReferenceSyntacticForm } from '../schemas/projection-blobs.js';

import { AST_SYNTACTIC_FORMS } from './blob-references.js';
import type { PopulationOutcome } from './merge.js';
import type { Projection } from './projection.js';
import type { RowSetId } from './row-set-id.js';
import { ALL_BLOB_REQUEST, type BlobRequest, type BlobScopedTableName, type FactStore } from './store.js';

/** A reference form a parser's AST produces: every form but the lexer's. */
type AstSyntacticForm = Exclude<ReferenceSyntacticForm, LexicalReference['syntacticForm']>;

/** A `blob_references` row of an AST form. */
export type AstReferenceRow = BlobReferenceRow & { readonly syntacticForm: AstSyntacticForm };

/**
 * Every projection table the query lane holds in memory, and of `blob_references` only the AST
 * forms, under their own field. See the module header for why the field is renamed.
 */
export interface QueryProjection extends Omit<Projection, 'blobReferences'> {
  /** The AST-form references, in the projection's order: what an in-process reader may read. */
  readonly astReferences: readonly AstReferenceRow[];
}

/**
 * Where the run database's `blob_references` come from: the run's own decoded rows (store off, a
 * derived population, or a hit that read every form), or the store a hit was served from,
 * restricted to exactly the content keys the hit admitted. The store is the one the hit read, set
 * by the population: never one the caller supplies beside it. Required and one of the two: there
 * is no default lane.
 */
export type QueryReferenceSource =
  | { readonly rows: readonly BlobReferenceRow[] }
  | { readonly stored: { readonly tier: 'blob'; readonly store: FactStore; readonly contentKeys: readonly ContentKey[] } };

/**
 * Where a query-lane store hit's `blob_references` reach the run database from: `'copy'` reads the
 * AST forms and copies every form from the store inside SQLite, as every first population does;
 * `'rows'` reads every form and hands them, as the one repopulation after a copy found a key
 * evicted does (`populateForQuery`). Required, so a caller states it.
 */
export type QueryReferences = 'copy' | 'rows';

/**
 * The code a run database's hydration refuses with when a content key the hit admitted left the
 * store before its rows were copied. Engine-free and declared here, so the query lane dispatches on
 * it without loading the backend that throws it.
 */
export const PROJECTION_STORE_ROWS_EVICTED_CODE = 'PROJECTION_STORE_ROWS_EVICTED';

/**
 * Which stored rows left the store before the run used them, by tier: for the blob tier, how many
 * admitted content keys the ledger no longer holds; for the row-set tier, exactly which row sets, so
 * the retry forgets those and re-reads nothing else.
 */
export type StoredRowsEviction =
  | {
    readonly tier: 'blob';
    /** The relation being copied. */
    readonly relation: string;
    /** How many admitted keys the ledger no longer holds. */
    readonly missing: number;
  }
  | {
    readonly tier: 'rowSet';
    /** The relation being copied or read. */
    readonly relation: string;
    /** The row sets the ledger no longer holds. */
    readonly ids: readonly RowSetId[];
  };

/**
 * A row the run was served left the store before it was used: an eviction landed between the run's
 * read and its copy (or, for row sets, a stage's later read). Rows leave the store only with their
 * ledger row, so a held ledger row is proof its rows are the ones the read saw. The query lane
 * catches it with {@link isStoredRowsEvicted} and retries once; the retry misses on what was evicted
 * and derives it.
 */
export class StoredRowsEvictedError extends VatError {
  /** What was evicted, by tier. */
  readonly eviction: StoredRowsEviction;

  /**
   * @param eviction - What was evicted, by tier
   */
  constructor(eviction: StoredRowsEviction) {
    const count = eviction.tier === 'blob' ? eviction.missing : eviction.ids.length;
    const unit = eviction.tier === 'blob' ? 'content key(s)' : 'row set(s)';
    super(
      PROJECTION_STORE_ROWS_EVICTED_CODE,
      `${String(count)} ${unit} this run was served were evicted from the projection store before "${eviction.relation}" could be read from it.`,
    );
    this.eviction = eviction;
  }
}

/**
 * Whether `error` is a {@link StoredRowsEvictedError}: the code AND the eviction it carries, read by
 * brand and field rather than by prototype, so an instance from another copy of this module answers
 * yes, and a bare error carrying only the code answers no.
 *
 * @param error - Anything a catch block received
 * @returns True for a stored-rows eviction
 */
export function isStoredRowsEvicted(error: unknown): error is StoredRowsEvictedError {
  if (!isVatError(error, PROJECTION_STORE_ROWS_EVICTED_CODE)) return false;
  const { eviction } = error as { eviction?: { tier?: unknown } };
  return eviction?.tier === 'blob' || eviction?.tier === 'rowSet';
}

/** What the query lane's population hands back. */
export interface QueryPopulateResult {
  readonly projection: QueryProjection;
  readonly outcome: PopulationOutcome;
  /** Every form of `blob_references`, for the run database only. */
  readonly blobReferences: QueryReferenceSource;
}

/**
 * What a query-lane store hit decodes of the blob tier: every table, and of `blobReferences` only
 * the AST forms. Frozen: every caller shares it, its forms set included.
 */
export const QUERY_BLOB_REQUEST: BlobRequest<BlobScopedTableName> = deepFreeze({
  tables: ALL_BLOB_REQUEST.tables,
  referenceForms: AST_SYNTACTIC_FORMS,
});

/**
 * Whether a reference row is of an AST form.
 *
 * @param row - A `blob_references` row
 * @returns True for an AST form
 */
function isAstReference(row: BlobReferenceRow): row is AstReferenceRow {
  return AST_SYNTACTIC_FORMS.has(row.syntacticForm);
}

/**
 * The query lane's view of a projection: every table but `blobReferences`, and its AST forms as
 * `astReferences`.
 *
 * @param projection - A projection; on a query hit, one whose references were read AST-only
 * @returns The view
 */
export function queryProjectionOf(projection: Projection): QueryProjection {
  const { blobReferences, ...rest } = projection;
  return { ...rest, astReferences: blobReferences.filter((row) => isAstReference(row)) };
}
