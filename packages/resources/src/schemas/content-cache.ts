/**
 * The wire shape of a linkAuth content-cache entry — the one check that decides
 * whether a `<sha256>.json` sitting in a cache directory is allowed to become a
 * `ContentMetadata` and, with it, a successful authenticated fetch.
 *
 * (This is the schema for `src/content-cache.ts`, the on-disk cache behind the
 * `fetchAuthenticated` primitive. `src/projection/content-cache.ts` is an
 * unrelated per-run in-memory memo — it persists nothing and so has no wire
 * shape to validate.)
 *
 * ## Why a schema here, when the parse cache's namespace does the job elsewhere
 *
 * The parse cache closes its shape hole one level up, in `cache-namespace.ts`:
 * entries live under a directory named for something that moves (the VAT
 * version, or a digest of the entry schema's own shape), so two entry formats
 * never share a directory. **That option is not available to this cache, by
 * design.** `cache-namespace.ts` deliberately keeps authenticated link content
 * *outside* the namespace — it is a fact about the world, not about this build,
 * and re-fetching every URL on a VAT upgrade would be pure waste. Nothing in
 * this cache's address moves when VAT changes: the directory is whatever the
 * caller passed, and the filename is `sha256(rewrittenUrl)`, which says which
 * URL an entry is about and nothing whatsoever about what shape the JSON at
 * that path has. With no moving part to lean on, the check has to be at the
 * read boundary, and it has to look at the fields.
 *
 * ## What the removed `version: 1` actually bought, measured against this
 *
 * It bought one thing: an entry this build wrote under a *different number* was
 * a miss. It could not see a foreign, truncated or hand-edited file, because it
 * never looked at a field — and that gap was not theoretical. An entry carrying
 * `version: 1` but no `fetchedAt` was served as a **hit**: `Date.now() -
 * undefined` is `NaN`, `NaN > ttlMs` is `false`, so the TTL gate waved it
 * through and the caller received `status: undefined` as a successfully fetched
 * response. The number was in the file, correct, and irrelevant. Requiring
 * `fetchedAt` to be a finite integer closes that; so does requiring every other
 * field, which is what a schema is.
 *
 * ## `.strict()` on read, strip on write — the inverse of the repo's Postel rule
 *
 * `.claude/rules/schema-strictness.md` says be strict about what we produce and
 * liberal about what we read. This module is the other way round on purpose,
 * because "external" and "ours" are not what the two sides are separating here.
 *
 * On **write** ({@link ContentMetadataSchema}, default strip), an unknown key is
 * a field a caller smuggled through structural typing into metadata we are about
 * to persist. Dropping it is the security behaviour: the fetch primitive is the
 * authority on what may be persisted, and a token must not reach the disk if a
 * future regression ever hands one over. Refusing the whole write instead would
 * trade a real leak-prevention for nothing — the next run would arrive with the
 * same caller and the same extra key.
 *
 * On **read** ({@link StoredContentMetadataSchema}, `.strict()`), an unknown key
 * means the file was not written by this build. That is exactly the entry whose
 * other fields we have no standing to interpret, and one extra `open()` on a
 * refetch is cheaper than serving it.
 *
 * The immediate consequence, taken deliberately: **every entry on disk today
 * carries `version: 1` and is now a miss.** That is the invalidation the removed
 * constant existed to perform, done once, automatically, by the check that
 * replaced it — and pre-1.0 it needs no migration path, only a single refetch
 * inside a 30-minute TTL window.
 *
 * ## The limit, and why it is currently empty
 *
 * A schema cannot catch the addition of an *optional* field: "written before the
 * field existed" and "legitimately absent" are the same bytes, and no amount of
 * strictness separates them (see `schemas/parse-facts.ts`, which has that hole
 * and closes it with a namespace digest). **This envelope has no optional
 * fields, so today the schema is complete** — every shape change is visible.
 *
 * Keep it that way. Adding one optional field to {@link ContentMetadataSchema}
 * silently reopens the hole, and unlike the parse cache there is no namespace
 * here to close it behind: an entry predating the field would be read as a valid
 * entry that simply lacks it. If a field ever genuinely has to be optional, the
 * honest answers are to make it required-and-nullable instead (a `null` is a
 * value; its absence is not), or to accept that the change needs an explicit
 * one-time invalidation. Neither answer is a second version constant.
 */

import { z } from 'zod';

/** Lowest and highest integers an HTTP status code can be (RFC 9110 §15). */
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/**
 * What one cache entry's `.json` half holds — the response facts that survive
 * the fetch, with the bytes themselves living in the `.bin` sibling.
 *
 * Non-strict on purpose: this is the **write-side whitelist**, and stripping an
 * unknown key is the point. See this module's docstring.
 *
 * Every field is required. `contentType`/`etag`/`lastModified` are nullable
 * rather than optional because a header the server did not send is a fact we
 * know (`null`), not a fact we are missing — which is also what keeps the
 * optional-field hole above closed.
 */
export const ContentMetadataSchema = z
  .object({
    status: z
      .number()
      .int()
      .min(MIN_HTTP_STATUS)
      .max(MAX_HTTP_STATUS)
      .describe('HTTP status of the response the bytes came from'),
    contentType: z.string().nullable().describe('`content-type` header, or null if the server sent none'),
    etag: z.string().nullable().describe('`etag` header, or null if the server sent none'),
    lastModified: z.string().nullable().describe('`last-modified` header, or null if the server sent none'),
    fetchedAt: z
      .number()
      .int()
      .nonnegative()
      .describe('Epoch ms when the response was received — the TTL is evaluated against this'),
    rewrittenUrl: z
      .string()
      .min(1)
      .describe('The rewritten URL the bytes were fetched from (§6.3 cache-key discipline)'),
  })
  .describe('Response metadata for one cached authenticated fetch');

/**
 * The same shape at the read boundary, with `.strict()` — an entry carrying a
 * key this build has no field for is a miss rather than a plausible answer.
 *
 * Separate from {@link ContentMetadataSchema} only in unknown-key handling; the
 * field list has exactly one definition, above.
 */
export const StoredContentMetadataSchema = ContentMetadataSchema.strict().describe(
  'A stored cache entry, validated before it is allowed to become a ContentMetadata',
);

/**
 * Caller-facing metadata for a cached authenticated fetch.
 *
 * `Readonly<>` rather than a hand-written `interface`: the shape a cache
 * persists cannot have two definitions, or the validator falls behind the one it
 * does not own.
 */
export type ContentMetadata = Readonly<z.infer<typeof ContentMetadataSchema>>;
