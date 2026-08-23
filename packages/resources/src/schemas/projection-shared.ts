import { z } from 'zod';

import { CONTENT_KEY_PATTERN } from '../content-key.js';

/*
 * There is deliberately no `PROJECTION_SCHEMA_VERSION` here.
 *
 * It was a hand-bumped integer that reached 4, and it is gone for the same
 * reason `PARSER_BEHAVIOR_REVISION` is gone from `cache-namespace.ts`: a number
 * a person has to remember to bump is not a contract, it is a hope. Nothing
 * consumed it — the exported document carried it and no reader ever branched on
 * it — so every bump was cost without a beneficiary.
 *
 * ⚠️ It becomes a real question again the moment a projection is *stored* rather
 * than returned in-process, because then a file can outlive the build that
 * wrote it. The answer at that point is a **derived** digest of the row schemas'
 * own shape, exactly as the parse cache does with `parseFactsShapeSource()` —
 * not this constant reinstated. Do not add it back.
 */

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
