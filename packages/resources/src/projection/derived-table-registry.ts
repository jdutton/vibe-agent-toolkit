/**
 * The relations a LENS produces, described the way the store describes a table
 * — and deliberately not registered as tables.
 *
 * ## Why these are a separate registry rather than three more `PROJECTION_TABLES`
 *
 * `projection.ts` places the per-lens relations in the derived column: they are
 * *the output of evaluating a lens*, not rows anything populates. This registry
 * declares three of them — `lens_contexts`, `edges` and `edge_resolutions`;
 * `lens_entry_points` is also derived-per-lens but has no spec here yet, so a
 * query cannot reach it until one is added. Three shipped rulings refuse to
 * materialise any of them —
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

import { ChangedFileRowSchema } from '../schemas/projection-changed-files.js';
import {
  ClaudeContextChainRowSchema,
  ClaudeContextLoadRowSchema,
} from '../schemas/projection-claude-context.js';
import { EdgeResolutionRowSchema, EdgeRowSchema } from '../schemas/projection-edges.js';
import { ResolutionContextRowSchema } from '../schemas/projection-zones.js';

import {
  OTHER,
  projectionRowShape,
  ROOT_RELATIVE_PATH,
  type ProjectionColumnTypeSource,
  type ColumnRoles,
} from './column-kinds.js';
import { PROJECTION_TABLES } from './table-registry.js';

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
  /** Every `text` and `json` column, classified — see `ColumnRoles`. */
  readonly columnRoles: ColumnRoles;
}

/**
 * The relations `resolveEdges` produces, plus the lens rows that explain them —
 * and the always-loaded context chain, which is derived the same way for the
 * same reason.
 *
 * 🪤 `edges.refOrdinal` is nullable AND part of the key. SQLite permits NULL in
 * a `PRIMARY KEY` column of an ordinary rowid table and treats two NULLs as
 * distinct, so the key is declared for the index it builds and the contract it
 * documents, not for a uniqueness it cannot fully enforce — exactly as
 * `schema-sql.ts` already records for three materialised tables.
 *
 * ## Why the two `claude_context_*` relations are HERE and not tables
 *
 * They are the output of `whatLoadsAt` — a fixpoint over admissions, run per
 * instruction chain — which is a question asked of a projection rather than a
 * fact any contributor emits. `claude-context-query.ts` says so at length and
 * declines to materialise the same traversal's provenance; putting these in
 * `PROJECTION_TABLES` would be materialising it after all, and would file rows
 * that are a function of a LENS into scope-partitioned bundles a shared on-disk
 * store persists. They have no scope, and {@link DerivedTableSpec} has no field
 * for one. That is the whole statement.
 */
export const DERIVED_TABLES = {
  lensContexts: derived('lensContexts', 'lens_contexts', ResolutionContextRowSchema, ['contextId'], {
    contextId: OTHER, species: OTHER, kind: OTHER, rootId: OTHER, extentContextId: OTHER, role: OTHER,
  }),
  edges: derived('edges', 'edges', EdgeRowSchema, ['src', 'refOrdinal', 'contextId'], {
    src: OTHER, contextId: OTHER, kind: OTHER, origin: OTHER,
  }),
  edgeResolutions: derived('edgeResolutions', 'edge_resolutions', EdgeResolutionRowSchema, [
    'src',
    'refOrdinal',
    'contextId',
    'candidateOrdinal',
  ], {
    src: OTHER,
    contextId: OTHER,
    dstKind: OTHER,
    // A normalized root-relative path for the "out-of-corpus" class, so the column can hold one.
    dstKey: ROOT_RELATIVE_PATH,
    dstResource: OTHER,
    dstAnchor: OTHER,
    tier: OTHER,
  }),
  claudeContextChains: derived(
    'claudeContextChains',
    'claude_context_chains',
    ClaudeContextChainRowSchema,
    ['chainId', 'directory'],
    { chainId: OTHER, directory: ROOT_RELATIVE_PATH, representative: ROOT_RELATIVE_PATH },
  ),
  claudeContextLoads: derived(
    'claudeContextLoads',
    'claude_context_loads',
    ClaudeContextLoadRowSchema,
    ['chainId', 'resourceId'],
    {
      chainId: OTHER,
      resourceId: OTHER,
      path: ROOT_RELATIVE_PATH,
      loadClass: OTHER,
      admissionKind: OTHER,
      pattern: OTHER,
      sizeCliff: OTHER,
      launchCharge: OTHER,
    },
  ),
  // What changed since the run's `--base`. Derived for the reason the others
  // are, and one more: its rows are a function of a BASE COMMIT the run was
  // handed, which no population knows.
  changedFiles: derived('changedFiles', 'changed_files', ChangedFileRowSchema, ['path', 'status'], {
    path: ROOT_RELATIVE_PATH, status: OTHER, oldPath: ROOT_RELATIVE_PATH,
  }),
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

/** One relation a statement can name: a projection table's registry entry, or a derived relation's. */
export type QueryableRelationSpec = (typeof PROJECTION_TABLES)[keyof typeof PROJECTION_TABLES] | DerivedTableSpec;

/**
 * Every relation a statement can name — every projection table, then every derived relation, each
 * registry in declaration order — and nothing else.
 *
 * 🔑 The ONE list. Hydration, the compile probe, the SQL gate, the planner, the failure listing and
 * {@link rootlessPathRelations} all derive from it, so no reader holds a second copy that a new
 * relation could be missing from.
 *
 * @returns The relations' specifications
 */
export function queryableRelationSpecs(): readonly QueryableRelationSpec[] {
  return [...Object.values(PROJECTION_TABLES), ...allDerivedSpecs()];
}

/**
 * Whether a queryable relation is a projection table — copied into a run by hydration — rather than
 * a derived relation a lens fills. The one test of it: a projection table carries a `scope`, and a
 * derived relation has none.
 *
 * @param spec - A queryable relation
 * @returns True for a projection table
 */
export function isProjectionTable(spec: QueryableRelationSpec): spec is (typeof PROJECTION_TABLES)[keyof typeof PROJECTION_TABLES] {
  return 'scope' in spec;
}

/**
 * Every relation a statement can name, by SQL name, in {@link queryableRelationSpecs} order.
 *
 * @returns The names
 */
export function queryableRelationNames(): readonly string[] {
  return queryableRelationSpecs().map((spec) => spec.name);
}

/** The column a relation will carry to say which root a row is under; no relation carries it yet. */
const ROOT_COLUMN = 'root';

/**
 * The queryable relations — every table and every derived relation — whose rows cannot say which
 * root they are under: a {@link ROOT_RELATIVE_PATH} column, and no {@link ROOT_COLUMN}.
 *
 * Derived from each spec's `columnRoles`, never listed: in a run holding more than one root, two
 * roots can each hold `docs/a.md`, and a statement over one of these would answer for both under
 * one path. ⚠️ Transitional: the set empties as relations gain a `root` column.
 *
 * @returns Their SQL names, tables first, each registry in declaration order
 */
export function rootlessPathRelations(): readonly string[] {
  return queryableRelationSpecs()
    .filter((spec) => !(spec.columns as readonly string[]).includes(ROOT_COLUMN))
    .filter((spec) => Object.values<string | undefined>(spec.columnRoles).includes(ROOT_RELATIVE_PATH))
    .map((spec) => spec.name);
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
 * @param columnRoles - Every `text` and `json` column, classified — see `ColumnRoles`
 * @returns The relation's specification
 */
function derived(
  key: string,
  name: string,
  schema: ProjectionColumnTypeSource['schema'],
  primaryKey: readonly string[],
  columnRoles: ColumnRoles,
): DerivedTableSpec {
  return {
    key,
    name,
    schema,
    primaryKey,
    columnRoles,
    columns: Object.keys(projectionRowShape(schema)),
  };
}
