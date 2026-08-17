import { z } from 'zod';

import { CONTENT_KEY_PATTERN } from '../content-key.js';

/**
 * Contract version for VAT's queryable resource projection (the blob-keyed
 * and path-dependent tables documented in
 * `docs/architecture/resource-projection.md`, read through the zone model in
 * `docs/architecture/zones.md`).
 *
 * Version 2 is the zones revision: identity split from realization, zones
 * factored into resolution contexts and entry points, edges split from their
 * candidate resolutions, four vocabularies opened.
 *
 * Version 3 is the demand-driven keying revision: `resource_realizations`
 * gains `contentState`, so a null `contentKey` says which of "no bytes here",
 * "nobody asked for these bytes yet" and "the read threw" it means, and an
 * extent may decline to hash bytes no consumer has demanded.
 *
 * Version 4 is the condition-provenance revision: `realization_conditions`
 * gains the six columns that say which reference provoked a condition
 * (`sourcePath`, `sourceLine`, `sourceRef`, `targetExists`, `matchedPattern`,
 * `matchedPayload`), so a refusal carries the same provenance
 * `walk-link-graph.ts`'s `LinkResolution` does and a consumer can raise the
 * issue the shipped walker raises.
 *
 * Bump whenever a table gains, loses, or renames a column, or a column's
 * type narrows — the "late column-level change" the architecture doc names
 * as expected, not exceptional. Adding a new *row* to an open vocabulary (a
 * new `resource_tags.tag` value, a new `blob_conditions.code`) is NOT a
 * version bump — see the doc's "facts are rows, not columns" rule.
 */
export const PROJECTION_SCHEMA_VERSION = 4;

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

/**
 * Built on first use and kept — `ZodLazy` calls its getter on every parse, so
 * an inline getter would re-construct a six-member union per value validated,
 * and again per element of every nested array and object. See the same note on
 * `HeadingNodeSchema` in `resource-metadata.ts`.
 */
let memoizedJsonValueSchema: z.ZodType<JsonValue> | undefined;

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  (memoizedJsonValueSchema ??= z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]))
).describe('An arbitrary JSON value (frontmatter, condition payloads, etc.)');

/**
 * A content key as produced by `computeContentKey` in `content-key.ts` —
 * `<parserKind>.<sha256>`. This is the primary key of the `blobs` table and
 * the foreign key every blob-keyed and path-dependent table joins through.
 */
export const ContentKeySchema = z.string().regex(CONTENT_KEY_PATTERN)
  .describe('A parser-kind-qualified content key: "<markdown|html>.<sha256>"');

/**
 * Severity for a projection condition row — `blob_conditions` (parse-time)
 * and `realization_conditions` (population-time) share it.
 *
 * A fresh, local definition, not a reuse of `schema`'s `SeverityLevelSchema`
 * (`'error' | 'warning' | 'info' | 'ignore'`): that schema's fourth member,
 * `'ignore'`, is a config-resolution state and doesn't apply to something
 * that already happened. A parse that already produced an oddity, or a
 * contributor that already refused to write a colliding realization, cannot
 * retroactively be "ignored" the way a resolved config value can.
 */
export const ProjectionConditionSeveritySchema = z.enum(['error', 'warning', 'info'])
  .describe('Severity of a projection condition row');

export type ProjectionConditionSeverity = z.infer<typeof ProjectionConditionSeveritySchema>;
