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
import { DataRouteRowSchema, DataValueRowSchema } from '../schemas/projection-data.js';
import { EdgeResolutionRowSchema, EdgeRowSchema } from '../schemas/projection-edges.js';
import { GitContentRowSchema } from '../schemas/projection-git-content.js';
import {
  TsImportConditionRowSchema,
  TsImportTargetRowSchema,
  TsProgramFileRowSchema,
} from '../schemas/projection-ts-resolve.js';
import { TsImportsRowSchema, TsRouteRowSchema } from '../schemas/projection-ts.js';
import {
  TsconfigClosureRowSchema,
  TsconfigConditionRowSchema,
  TsconfigConfigRowSchema,
  TsconfigExtendsRowSchema,
  TsconfigFileRowSchema,
  TsconfigInvocationRowSchema,
  TsconfigPathRowSchema,
  TsconfigReferenceRowSchema,
} from '../schemas/projection-tsconfig.js';
import {
  WorkspaceConditionRowSchema,
  WorkspaceDependencyRowSchema,
  WorkspacePackageRowSchema,
} from '../schemas/projection-workspace.js';
import { ResolutionContextRowSchema } from '../schemas/projection-zones.js';

import {
  OTHER,
  projectionRowShape,
  ROOT_RELATIVE_PATH,
  type ProjectionColumnTypeSource,
  type ColumnRoles,
} from './column-kinds.js';
import { ROW_SET_TABLES, type MutableRowSetRows, type RowSetTableName } from './row-set-table-registry.js';
import { PROJECTION_TABLES } from './table-registry.js';

/**
 * What fills a derived relation: a lens evaluated over the run (`lens`), a row-set instance's
 * stage (`data`: the routes and the values joined from the stored nodes), or the workspace resolve
 * step over the data instance's rows (`workspace`), or the run's git snapshot (`git`: git content,
 * through the membership function the git crawl is built on), or the tsconfig resolve step over the
 * data instance's rows, git content and TypeScript's config parser (`tsconfig`), or the `ts`
 * instance's stage (`ts`: its routes, and its imports joined to the routes with the per-run facts),
 * or the resolve step over the `ts` rows, the workspace and tsconfig relations and git content
 * (`tsResolve`: what TypeScript resolves each reference to).
 */
export type DerivedProducer = 'lens' | 'data' | 'workspace' | 'git' | 'tsconfig' | 'ts' | 'tsResolve';

/**
 * A relation a lens produces, as a store needs to see it.
 *
 * Structurally a `StoredTableSpec` minus `scope` and `contextColumn` — see the
 * header for why that absence is load-bearing rather than an omission.
 */
export interface DerivedTableSpec extends ProjectionColumnTypeSource {
  /** Which registry: always `derived`. */
  readonly kind: 'derived';
  /** What fills the relation: a lens, or a row-set instance's stage. */
  readonly producer: DerivedProducer;
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
  }, 'lens'),
  edges: derived('edges', 'edges', EdgeRowSchema, ['src', 'refOrdinal', 'contextId'], {
    src: OTHER, contextId: OTHER, kind: OTHER, origin: OTHER,
  }, 'lens'),
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
  }, 'lens'),
  claudeContextChains: derived(
    'claudeContextChains',
    'claude_context_chains',
    ClaudeContextChainRowSchema,
    ['chainId', 'directory'],
    { chainId: OTHER, directory: ROOT_RELATIVE_PATH, representative: ROOT_RELATIVE_PATH },
    'lens',
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
    'lens',
  ),
  // What changed since the run's `--base`. Derived for the reason the others
  // are, and one more: its rows are a function of a BASE COMMIT the run was
  // handed, which no population knows.
  changedFiles: derived('changedFiles', 'changed_files', ChangedFileRowSchema, ['path', 'status'], {
    path: ROOT_RELATIVE_PATH, status: OTHER, oldPath: ROOT_RELATIVE_PATH,
  }, 'lens'),
  // The data instance's per-run relations: which path routed to which row set and how it stands,
  // and the routes joined to the nodes no later sibling shadows. Never stored: their keys carry the
  // root and the path, which no row set holds. `root` is the root id of the realization's extent.
  dataRoutes: derived('dataRoutes', 'data__routes', DataRouteRowSchema, ['root', 'path'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, blob: OTHER, variant: OTHER, state: OTHER, code: OTHER,
  }, 'data'),
  dataValues: derived('dataValues', 'data__values', DataValueRowSchema, ['root', 'path', 'variant', 'doc', 'pointer'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, variant: OTHER, pointer: OTHER, key: OTHER, type: OTHER, lexeme: OTHER,
  }, 'data'),
  // The workspace resolve step's relations (`workspace-packages.ts`): derived per run, never
  // stored, since membership, names and links each depend on many files.
  workspacePackages: derived('workspacePackages', 'workspace_packages', WorkspacePackageRowSchema, ['root', 'path'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, dir: ROOT_RELATIVE_PATH, name: OTHER, version: OTHER,
  }, 'workspace'),
  workspaceDependencies: derived('workspaceDependencies', 'workspace_dependencies', WorkspaceDependencyRowSchema, ['root', 'path', 'field', 'name'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, field: OTHER, name: OTHER, range: OTHER, targetPath: ROOT_RELATIVE_PATH, protocol: OTHER,
  }, 'workspace'),
  workspaceConditions: derived('workspaceConditions', 'workspace_conditions', WorkspaceConditionRowSchema, ['root', 'path', 'code', 'seq'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, code: OTHER, message: OTHER,
  }, 'workspace'),
  // Git's own content under each root, from the run's memoized snapshot (`git-content.ts`): derived
  // per run, never stored. `repository` is the repository relative to the analysis root, `''` for
  // the top, so a nested repository adds rows without a shape change.
  gitContent: derived('gitContent', 'git_content', GitContentRowSchema, ['root', 'repository', 'path'], {
    root: OTHER, repository: OTHER, path: ROOT_RELATIVE_PATH,
  }, 'git'),
  // The tsconfig resolve step's relations (`tsconfig-step.ts`): derived per run, never stored, since
  // each config's answer depends on its chain, its references and the run's git content.
  tsconfigInvocations: derived('tsconfigInvocations', 'tsconfig_invocations', TsconfigInvocationRowSchema, ['root', 'path', 'script', 'segment', 'ordinal'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, script: OTHER, package: OTHER, packageDir: ROOT_RELATIVE_PATH,
    compiler: OTHER, project: ROOT_RELATIVE_PATH, config: ROOT_RELATIVE_PATH,
  }, 'tsconfig'),
  tsconfigReferences: derived('tsconfigReferences', 'tsconfig_references', TsconfigReferenceRowSchema, ['root', 'config', 'ordinal'], {
    root: OTHER, config: ROOT_RELATIVE_PATH, spec: OTHER, path: ROOT_RELATIVE_PATH,
  }, 'tsconfig'),
  tsconfigClosure: derived('tsconfigClosure', 'tsconfig_closure', TsconfigClosureRowSchema, ['root', 'config', 'member'], {
    root: OTHER, config: ROOT_RELATIVE_PATH, member: ROOT_RELATIVE_PATH,
  }, 'tsconfig'),
  tsconfigConfigs: derived('tsconfigConfigs', 'tsconfig_configs', TsconfigConfigRowSchema, ['root', 'path'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, outDir: ROOT_RELATIVE_PATH, rootDir: ROOT_RELATIVE_PATH, baseUrl: ROOT_RELATIVE_PATH,
  }, 'tsconfig'),
  tsconfigExtends: derived('tsconfigExtends', 'tsconfig_extends', TsconfigExtendsRowSchema, ['root', 'config', 'ordinal'], {
    root: OTHER, config: ROOT_RELATIVE_PATH, path: ROOT_RELATIVE_PATH,
  }, 'tsconfig'),
  tsconfigFiles: derived('tsconfigFiles', 'tsconfig_files', TsconfigFileRowSchema, ['root', 'config', 'path'], {
    root: OTHER, config: ROOT_RELATIVE_PATH, path: ROOT_RELATIVE_PATH,
  }, 'tsconfig'),
  tsconfigPaths: derived('tsconfigPaths', 'tsconfig_paths', TsconfigPathRowSchema, ['root', 'config', 'pattern', 'ordinal'], {
    root: OTHER, config: ROOT_RELATIVE_PATH, pattern: OTHER, target: OTHER, basePath: ROOT_RELATIVE_PATH,
  }, 'tsconfig'),
  tsconfigConditions: derived('tsconfigConditions', 'tsconfig_conditions', TsconfigConditionRowSchema, ['root', 'path', 'code', 'seq'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, code: OTHER, message: OTHER, kind: OTHER, reached: ROOT_RELATIVE_PATH,
  }, 'tsconfig'),
  // The `ts` instance's per-run relations, as the data instance's: never stored, since their keys
  // carry the root and the path. `lexicalTarget` is a relative specifier folded against the file's
  // directory, so a path under the root.
  tsRoutes: derived('tsRoutes', 'ts__routes', TsRouteRowSchema, ['root', 'path'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, blob: OTHER, variant: OTHER, state: OTHER, code: OTHER,
  }, 'ts'),
  tsImports: derived('tsImports', 'ts_imports', TsImportsRowSchema, ['root', 'path', 'ordinal'], {
    root: OTHER, path: ROOT_RELATIVE_PATH, variant: OTHER, kind: OTHER, specifier: OTHER, specifierForm: OTHER,
    resolutionMode: OTHER, attributeType: OTHER, scope: OTHER, package: OTHER, lexicalTarget: ROOT_RELATIVE_PATH,
  }, 'ts'),
  // The resolve step's relations (`ts-resolve-step.ts`): what TypeScript resolves each reference to
  // under each demanded config, derived per run, never stored. A root-level condition row
  // (`TS_VERSION_SKEW`) has a null `config`, `path` and `ordinal`, as `edges.refOrdinal` can be null
  // inside its key; `compareRows` orders a null key column first.
  tsImportTargets: derived('tsImportTargets', 'ts_import_targets', TsImportTargetRowSchema, ['root', 'config', 'path', 'ordinal'], {
    root: OTHER, config: ROOT_RELATIVE_PATH, path: ROOT_RELATIVE_PATH, kind: OTHER, specifier: OTHER, mode: OTHER,
    targetKind: OTHER, target: ROOT_RELATIVE_PATH, package: OTHER,
  }, 'tsResolve'),
  tsProgramFiles: derived('tsProgramFiles', 'ts_program_files', TsProgramFileRowSchema, ['root', 'config', 'path'], {
    root: OTHER, config: ROOT_RELATIVE_PATH, path: ROOT_RELATIVE_PATH,
  }, 'tsResolve'),
  tsImportConditions: derived('tsImportConditions', 'ts_import_conditions', TsImportConditionRowSchema, ['root', 'config', 'path', 'ordinal', 'code'], {
    root: OTHER, config: ROOT_RELATIVE_PATH, path: ROOT_RELATIVE_PATH, code: OTHER, message: OTHER, declaredMajors: OTHER,
  }, 'tsResolve'),
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

/** A projection table's registry entry. */
export type ProjectionTableEntry = (typeof PROJECTION_TABLES)[keyof typeof PROJECTION_TABLES];

/** A row-set table's registry entry. */
export type RowSetTableEntry = (typeof ROW_SET_TABLES)[keyof typeof ROW_SET_TABLES];

/** One relation a store holds: a projection table's registry entry, or a row-set table's. */
export type StoredRelationSpec = ProjectionTableEntry | RowSetTableEntry;

/** One relation a statement can name: a stored relation, or a derived relation. Each carries its `kind`. */
export type QueryableRelationSpec = StoredRelationSpec | DerivedTableSpec;

/**
 * Every relation a store holds — every projection table, then every row-set table, each registry
 * in declaration order. The shape digest, the store's DDL and the copy lane's eligibility read it.
 *
 * @returns The relations' specifications
 */
export function storedRelationSpecs(): readonly StoredRelationSpec[] {
  return [...Object.values(PROJECTION_TABLES), ...Object.values(ROW_SET_TABLES)];
}

/**
 * Every relation a statement can name — every projection table, then every row-set table, then
 * every derived relation, each registry in declaration order — and nothing else.
 *
 * 🔑 The ONE list. Hydration, the compile probe, the SQL gate, the planner, the failure listing and
 * {@link rootlessPathRelations} all derive from it, so no reader holds a second copy that a new
 * relation could be missing from.
 *
 * @returns The relations' specifications
 */
export function queryableRelationSpecs(): readonly QueryableRelationSpec[] {
  return [...storedRelationSpecs(), ...allDerivedSpecs()];
}

/**
 * Every row-set table's name, of every instance, in registry order.
 *
 * @returns The names
 */
export function rowSetTableNames(): readonly RowSetTableName[] {
  return storedRelationSpecs().filter(isRowSetTable).map((spec) => spec.key);
}

/**
 * Every row-set table, of every instance, empty: what a holder of rows starts from.
 *
 * @returns A fresh array per table
 */
export function emptyRowSetRows(): MutableRowSetRows {
  return Object.fromEntries(rowSetTableNames().map((table) => [table, []])) as unknown as MutableRowSetRows;
}

/**
 * Whether a queryable relation is a projection table, by its `kind`.
 *
 * @param spec - A queryable relation
 * @returns True for a projection table
 */
export function isProjectionTable(spec: QueryableRelationSpec): spec is ProjectionTableEntry {
  return spec.kind === 'projection';
}

/**
 * Whether a queryable relation is a row-set table, by its `kind`.
 *
 * @param spec - A queryable relation
 * @returns True for a row-set table
 */
export function isRowSetTable(spec: QueryableRelationSpec): spec is RowSetTableEntry {
  return spec.kind === 'rowSet';
}

/**
 * Every relation a statement can name, by SQL name, in {@link queryableRelationSpecs} order.
 *
 * @returns The names
 */
export function queryableRelationNames(): readonly string[] {
  return queryableRelationSpecs().map((spec) => spec.name);
}

/** The column a relation carries to say which root a row is under (`data__routes`, `data__values`). */
const ROOT_COLUMN = 'root';

/**
 * The queryable relations — every table, row-set table and derived relation — whose rows cannot say which
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
 * @param producer - What fills the relation: a lens, or a row-set instance's stage
 * @returns The relation's specification
 */
function derived(
  key: string,
  name: string,
  schema: ProjectionColumnTypeSource['schema'],
  primaryKey: readonly string[],
  columnRoles: ColumnRoles,
  producer: DerivedProducer,
): DerivedTableSpec {
  return {
    kind: 'derived',
    producer,
    key,
    name,
    schema,
    primaryKey,
    columnRoles,
    columns: Object.keys(projectionRowShape(schema)),
  };
}
