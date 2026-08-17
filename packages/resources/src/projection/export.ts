/**
 * Emitting a {@link Projection} as a document. **No engine** (zones.md §15
 * step 6).
 *
 * This module emits rows. It does not index them, does not join them, does not
 * filter them, and accepts no query. Anything that reads like a query is a
 * lens's job, over the projection, and belongs nowhere near here — the whole
 * point of materialising twelve flat tables is that the consumer chooses the
 * engine (DuckDB, a JSON reader, a golden diff) rather than inheriting one.
 *
 * ## Two properties the emitted document must have
 *
 * 1. **No absolute path survives.** `roots.path` is an absolute filesystem path
 *    by design and is the only column that carries one — every other path in
 *    the projection is root-relative. It is replaced with
 *    {@link ROOT_PATH_PLACEHOLDER}. This is not hypothetical tidiness: VAT has
 *    already shipped a lane whose evidence leaked `$HOME`. A root is identified
 *    by `roots.id` and joined through `resolution_contexts.rootId`, so nothing
 *    downstream reads `path` back — federation was the reason it is a table at
 *    all, not the reason it is a path.
 * 2. **Byte-identical across runs.** Every table is sorted by its primary key.
 *    Insertion order is not a stable input: one of `crawlDirectory`'s two routes
 *    enumerates in **filesystem order**, and ext4, APFS and NTFS all differ. An
 *    export carrying insertion order would make any golden host-dependent, which
 *    is the specific failure a golden exists to rule out.
 *
 * The sort is by primary key rather than by whole-row canonical form so the
 * ordering a reader sees is the ordering the schema documents. Numeric key
 * columns (`blob_references.ordinal`, `blob_sections.ordinal`) compare
 * numerically — string order would place 10 before 2.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';

import type { Projection } from './projection.js';

/**
 * What `roots.path` holds in an exported document.
 *
 * A single constant rather than a per-root token: `roots.id` already tells two
 * federated roots apart, and a per-root placeholder would only re-encode the
 * ordering of a path column that no longer exists.
 */
export const ROOT_PATH_PLACEHOLDER = '<root>';

/**
 * An exported projection: the twelve tables, and nothing else.
 *
 * The tables stay nested under one key rather than spread across the document
 * so a consumer can enumerate exactly the tables without filtering metadata out
 * of the same object. `tables` is typed as {@link Projection} itself, so adding
 * a thirteenth table is a compile error here rather than a silently unexported
 * one.
 *
 * `tables.roots` still satisfies `RootRowSchema` — the placeholder is a
 * non-empty string — so a redacted document round-trips through the row schemas
 * unchanged.
 *
 * There is no `schemaVersion`. It carried a hand-bumped integer that no reader
 * ever branched on; see the note where that constant used to live, in
 * `schemas/projection-shared.ts`, for what replaces it if a projection is ever
 * *stored* rather than returned in-process.
 */
export interface ProjectionDocument {
  /** The twelve tables, each sorted by its primary key. */
  readonly tables: Projection;
}

/** A single component of a primary key. */
type KeyPart = string | number | boolean | null;

/**
 * Emit a projection as a deterministic, path-free document.
 *
 * @param projection - The projection to emit
 * @returns The document: twelve primary-key-sorted tables, roots redacted
 */
export function exportProjection(projection: Projection): ProjectionDocument {
  return {
    tables: {
      roots: sortRows(projection.roots, (row) => [row.id])
        .map((row) => ({ ...row, path: ROOT_PATH_PLACEHOLDER })),
      resources: sortRows(projection.resources, (row) => [row.resourceId]),
      resourceRealizations: sortRows(projection.resourceRealizations, (row) => [row.extentId, row.path]),
      resourceExtents: sortRows(projection.resourceExtents, (row) => [row.resourceId, row.extentId]),
      resourceTags: sortRows(projection.resourceTags, (row) => [row.resourceId, row.tag, row.value, row.source]),
      realizationConditions: sortRows(
        projection.realizationConditions,
        (row) => [row.extentId, row.path, row.code, row.resourceId],
      ),
      resolutionContexts: sortRows(projection.resolutionContexts, (row) => [row.contextId]),
      zoneProvenance: sortRows(projection.zoneProvenance, (row) => [row.contextId, row.contributorId]),
      blobs: sortRows(projection.blobs, (row) => [row.contentKey]),
      blobReferences: sortRows(projection.blobReferences, (row) => [row.blob, row.ordinal]),
      blobSections: sortRows(projection.blobSections, (row) => [row.blob, row.ordinal]),
      blobConditions: sortRows(projection.blobConditions, (row) => [row.blob, row.code, row.line, row.message]),
    },
  };
}

/**
 * Serialize a projection to JSON.
 *
 * Two calls over the same projection produce identical bytes, as do two
 * projections built from the same rows contributed in different orders — the
 * property that makes a golden of this output meaningful. `mtime` becomes an
 * ISO-8601 string, which is `Date`'s own JSON form.
 *
 * @param projection - The projection to serialize
 * @returns Pretty-printed JSON with a trailing newline
 */
export function serializeProjection(projection: Projection): string {
  return `${JSON.stringify(exportProjection(projection), undefined, 2)}\n`;
}

/**
 * Copy a table into primary-key order.
 *
 * Copies rather than sorting in place: a built projection's tables are frozen,
 * and a caller's live table must not be reordered by the act of exporting it.
 *
 * @param rows - The table
 * @param keyOf - Extracts this table's primary key, in column order
 * @returns A new array in key order
 */
function sortRows<T>(rows: readonly T[], keyOf: (row: T) => readonly KeyPart[]): T[] {
  return [...rows].sort((left, right) => compareKeys(keyOf(left), keyOf(right)));
}

/**
 * Compare two primary keys component by component.
 *
 * Both keys come from the same extractor, so they always have the same arity;
 * `?? null` covers the index type rather than a reachable case.
 *
 * @param left - First key
 * @param right - Second key
 * @returns Negative, zero or positive per the `Array.prototype.sort` contract
 */
function compareKeys(left: readonly KeyPart[], right: readonly KeyPart[]): number {
  for (const [index, part] of left.entries()) {
    const order = comparePart(part, right[index] ?? null);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

/**
 * Compare one key component, numerically when the column is numeric.
 *
 * A key column has one type across a table, so the numeric branch is taken for
 * every row of `blob_references.ordinal` or for none.
 *
 * @param left - First component
 * @param right - Second component
 * @returns Negative, zero or positive per the `Array.prototype.sort` contract
 */
function comparePart(left: KeyPart, right: KeyPart): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  return compareCodeUnits(stringifyPart(left), stringifyPart(right));
}

/**
 * Render a key component for code-unit comparison. A null column sorts first,
 * which is the same convention `blob_references.column` documents for a null
 * column position.
 *
 * @param part - The key component
 * @returns Its comparable string form
 */
function stringifyPart(part: KeyPart): string {
  return part === null ? '' : String(part);
}
