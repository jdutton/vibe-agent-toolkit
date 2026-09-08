/**
 * The relations a LENS produces, described the way the store describes a table
 * — and deliberately not registered as tables.
 *
 * ## Why these are a separate registry rather than four more `PROJECTION_TABLES`
 *
 * `projection.ts` places `edges`, `edge_resolutions` and `lens_entry_points` in
 * the derived-per-lens column: they are *the output of evaluating a lens*, not
 * rows anything populates. Three shipped rulings refuse to materialise them —
 * `closure-extent.ts` declined an `extent_edges` table, `claude-context-query.ts`
 * re-runs a traversal rather than storing its result, and `ExtentContribution`
 * carries no edge field at all, so a contributor literally cannot emit one.
 * Adding them to `PROJECTION_TABLES` would be materialising them, which is the
 * thing all three refuse.
 *
 * But a relation still has to be *shaped* to be queryable, and the shape is the
 * same shape: an ordered column list, a key, and a row schema that types each
 * column. So this registry says what a derived relation looks like without
 * claiming anything populates it.
 *
 * ## 🚨 The trap this type exists to avoid: a derived relation has no SCOPE
 *
 * `ProjectionTableScope` is `'blob' | 'extent'`, and a derived relation is
 * honestly **neither**. Passing `'blob'` would emit structurally-correct DDL —
 * no extent-key columns, which is what a derived relation wants — while
 * *claiming the rows are a pure function of bytes*. They are not: they are a
 * function of bytes AND of the lens that read them, which is the entire reason
 * they are derived. ⛔ Widening `ProjectionTableScope` is the other wrong
 * answer: it ripples into the store's scope-partitioned row bundles, which
 * derived relations must never enter — those bundles are what a shared on-disk
 * store persists, and a lens's output is per-lens and per-question.
 *
 * So {@link DerivedTableSpec} simply has no `scope` field. The absence is the
 * statement, and it is enforced by the type rather than by a comment.
 *
 * ## ⛔ A derived relation never adds a row to a materialised table
 *
 * Including `resolution_contexts`, which is why {@link DERIVED_TABLES} carries
 * `lensContexts` rather than inserting invented lenses into the materialised
 * one. zones.md §2 says a lens may be "invented on demand" and costs "a cheap
 * row" — true, and that row belongs *here*, beside the relations it explains.
 * Putting it in `resolution_contexts` would make `SELECT COUNT(*)` from a
 * materialised table answer differently depending on whether a lens had been
 * evaluated, with nothing in the document to say so.
 *
 * It reuses `ResolutionContextRowSchema` rather than declaring a new shape: a
 * lens IS a resolution context — `species: 'lens'` is a member of that schema's
 * own enum, and its `extentContextId` invariant (non-null for a lens) is already
 * enforced there. Reusing it means an invented lens is validated by the same
 * shipped, published schema a declared one would be, so the two cannot drift.
 */

import { EdgeResolutionRowSchema, EdgeRowSchema } from '../schemas/projection-edges.js';
import { ResolutionContextRowSchema } from '../schemas/projection-zones.js';

import { projectionRowShape, type ProjectionColumnTypeSource } from './column-kinds.js';

/**
 * A relation a lens produces, as a store needs to see it.
 *
 * Structurally a `StoredTableSpec` minus `scope` and `contextColumn` — see the
 * header for why that absence is load-bearing rather than an omission.
 */
export interface DerivedTableSpec extends ProjectionColumnTypeSource {
  /** The field an evaluation's result carries these rows under. */
  readonly key: string;
  /** The relation's snake_case name, as SQL spells it. */
  readonly name: string;
  /** The columns that identify a row, in comparison order. */
  readonly primaryKey: readonly string[];
}

/**
 * The relations `resolveEdges` produces, plus the lens rows that explain them.
 *
 * 🪤 `edges.refOrdinal` is nullable AND part of the key. SQLite permits NULL in
 * a `PRIMARY KEY` column of an ordinary rowid table and treats two NULLs as
 * distinct, so the key is declared for the index it builds and the contract it
 * documents, not for a uniqueness it cannot fully enforce — exactly as
 * `schema-sql.ts` already records for three materialised tables.
 */
export const DERIVED_TABLES = {
  lensContexts: derived('lensContexts', 'lens_contexts', ResolutionContextRowSchema, ['contextId']),
  edges: derived('edges', 'edges', EdgeRowSchema, ['src', 'refOrdinal', 'contextId']),
  edgeResolutions: derived('edgeResolutions', 'edge_resolutions', EdgeResolutionRowSchema, [
    'src',
    'refOrdinal',
    'contextId',
    'candidateOrdinal',
  ]),
} as const satisfies Readonly<Record<string, DerivedTableSpec>>;

/** The name a derived relation is carried under. */
export type DerivedTableName = keyof typeof DERIVED_TABLES;

/**
 * Every derived relation, for a backend that creates them all.
 *
 * @returns The specifications, in declaration order
 */
export function allDerivedSpecs(): readonly DerivedTableSpec[] {
  return Object.values(DERIVED_TABLES);
}

/**
 * Describe one derived relation, deriving its column list from its schema.
 *
 * The SQL name is stated rather than computed from the key. `PROJECTION_TABLES`
 * can derive it (`blobReferences` → `blob_references`) because every one of its
 * keys is the `Projection` field name; a derived relation's key is the field of
 * an evaluation RESULT, which is not the same vocabulary — `lensContexts` is
 * carried as `lensContexts` and spelled `lens_contexts`, but nothing guarantees
 * a future one lines up, and a silently-derived name is a rename waiting to be
 * missed.
 *
 * @param key - The field an evaluation's result carries these rows under
 * @param name - The relation's snake_case SQL name
 * @param schema - The row schema, which supplies the column order and types
 * @param primaryKey - The columns that identify a row, in comparison order
 * @returns The relation's specification
 */
function derived(
  key: string,
  name: string,
  schema: ProjectionColumnTypeSource['schema'],
  primaryKey: readonly string[],
): DerivedTableSpec {
  return {
    key,
    name,
    schema,
    primaryKey,
    columns: Object.keys(projectionRowShape(schema)),
  };
}
