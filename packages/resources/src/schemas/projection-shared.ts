import { z } from 'zod';

import { CONTENT_KEY_PATTERN } from '../content-key.js';

/**
 * Contract version for VAT's queryable resource projection (the blob-keyed
 * and path-dependent tables documented in
 * `docs/architecture/resource-projection.md`).
 *
 * Bump whenever a table gains, loses, or renames a column, or a column's
 * type narrows — the "late column-level change" the architecture doc names
 * as expected, not exceptional. Adding a new *row* to an open vocabulary (a
 * new `resource_tags.tag` value, a new `blob_conditions.code`) is NOT a
 * version bump — see the doc's "facts are rows, not columns" rule.
 */
export const PROJECTION_SCHEMA_VERSION = 1;

/**
 * Any value YAML's core schema (and therefore JSON) can represent. Recursive
 * on purpose: `sources: [a, b]` and `model: { status: modeled }` are both
 * real frontmatter shapes and both must round-trip.
 *
 * This is the schema-level analogue of the shipped design decision in
 * resource-projection.md §2: the projection stores frontmatter as JSON,
 * never DuckDB VARIANT, because VARIANT's accessor surface (no
 * `variant_keys()`, a constant-key-only extractor, inconsistent `len()`
 * behaviour) makes exactly this kind of nested, mixed-type value hard to
 * query.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
).describe('An arbitrary JSON value (frontmatter, condition payloads, etc.)');

/**
 * A content key as produced by `computeContentKey` in `content-key.ts` —
 * `<parserKind>.<sha256>`. This is the primary key of the `blobs` table and
 * the foreign key every blob-keyed and path-dependent table joins through.
 */
export const ContentKeySchema = z.string().regex(CONTENT_KEY_PATTERN)
  .describe('A parser-kind-qualified content key: "<markdown|html>.<sha256>"');
