/**
 * The wire shape of a parse-cache entry — the one schema that decides whether
 * bytes on disk are allowed to become a `ParseResult`.
 *
 * ## Why this is a schema and not a predicate
 *
 * The parse cache is content-addressed and fail-soft, so the only thing
 * standing between a foreign, truncated or *outdated* payload and the rest of
 * the toolkit is whatever validates it on read. That check used to be a
 * hand-written predicate that asserted `Array.isArray(links)` and never looked
 * inside an element — which is exactly the hole that shipped a defect: a
 * `ResourceLink` field addition was served back from entries written before it
 * existed, every AST-derived reference was dropped for want of a span, and the
 * suite went green and then red on the next run with nothing to point at.
 *
 * A schema closes the *element-shape* half of that hole, and it is the half
 * that matters once anything other than this module can write an entry (an
 * externally registered parser is the case on the horizon). It composes the
 * same schemas the rest of the package validates against, so there is exactly
 * one definition of what a link or a heading is.
 *
 * ## ⚠️ What a schema does NOT catch, stated plainly
 *
 * | Change to a stored shape | Caught? | How |
 * |---|---|---|
 * | A field's type changes | ✅ | the field's own check fails |
 * | A **required** field is added | ✅ | absent in the old entry ⇒ reject |
 * | A field is removed from `ParseFacts` | ✅ | `.strict()` on the envelope |
 * | Truncation / foreign JSON | ✅ | structural failure anywhere |
 * | An **optional** field is added | ❌ | absent is indistinguishable from |
 * | | | legitimately-absent — see below |
 *
 * That last row is not a defect in this file; it is a property of optionality.
 * `ResourceLink.startOffset` is genuinely optional (remark reports no position
 * for a quoted, parenthesised GFM autolink), so "this entry predates the field"
 * and "this link never had one" are the same bytes. No validator can separate
 * them, and no amount of strictness changes that.
 *
 * It is closed one level up instead, by never letting the two kinds of entry
 * share a cache directory: {@link parseFactsShapeSource} feeds this schema's own
 * shape into the dev namespace, and an installed build's namespace is the VAT
 * version, which moves on every release. What remains outside both is a change
 * to what a parse *means* with its shape unchanged — swapping the token
 * estimator, say — and `vat cache clear` owns that, deliberately: a developer
 * who changes what a parse means knows they did. See `cache-namespace.ts`.
 *
 * ## Nested schemas are NOT strict, on purpose
 *
 * `.strict()` sits on {@link ParseFactsSchema} alone. Inside an element, an
 * unknown key means a field this build no longer reads, and Zod strips it —
 * which is the right outcome, because a removed field's lingering presence
 * harms nothing and rejecting it would turn every entry cold for a change that
 * cannot produce a wrong answer. At the envelope, by contrast, an unknown key
 * means the entry disagrees with this build about what an entry *contains*,
 * which is precisely the case worth a reparse.
 */

import { toJsonSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import { LEXICAL_FEATURE_COLUMNS } from './projection-blobs.js';
import {
  HeadingNodeSchema,
  HtmlParseErrorSchema,
  ResourceLinkSchema,
  UnresolvedReferenceSchema,
} from './resource-metadata.js';

/**
 * Code-unit and word accounting for one blob, split by code context.
 *
 * Both counts are **UTF-16 code units** of the decoded document — neither
 * characters nor bytes. A JS string is a sequence of UTF-16 code units, so
 * `'𝄞'.length === 2` for one character that occupies four bytes on disk. These
 * are the same units reference `startOffset`/`endOffset` use, because a
 * rewriter indexes the decoded JS string; `BlobRow.bytes` carries the on-disk
 * byte count separately.
 */
export const ContentMeasuresSchema = z.object({
  wordCount: z.number().int().nonnegative().describe('Whitespace-delimited words outside code blocks. Inline code spans are NOT excluded — `measureContent` is passed only the fence ranges'),
  proseCodeUnits: z.number().int().nonnegative().describe('UTF-16 code units outside code blocks — NOT characters and NOT bytes; an astral character counts as two. Inline code spans are NOT excluded — `measureContent` is passed only the fence ranges, so a `` `token` `` counts as prose'),
  codeBlockCodeUnits: z.number().int().nonnegative().describe('UTF-16 code units inside code blocks — NOT characters and NOT bytes; an astral character counts as two. Fenced AND indented blocks, since both are one `code` AST node. Excludes inline code spans'),
}).describe('Code-unit and word accounting for one blob, split by code context');

export type ContentMeasures = z.infer<typeof ContentMeasuresSchema>;

/**
 * The syntactic forms the raw-source lexer produces — a strict subset of
 * `ReferenceSyntacticFormSchema` (`projection-blobs.ts`), which also covers the
 * three markdown forms the AST supplies.
 *
 * Kept as its own enum rather than reusing the wider one: a lexical reference
 * can never be a `markdown-link`, and admitting a value the producer cannot
 * emit would make this schema unable to reject a payload that claims otherwise.
 */
export const LexicalSyntacticFormSchema = z.enum(['at-prefixed', 'env-anchored', 'bare-token'])
  .describe('Syntactic form of a reference candidate found by the raw-source lexer');

/** A reference candidate the markdown AST does not produce. */
export const LexicalReferenceSchema = z.object({
  raw: z.string().describe('The token as authored, with trailing sentence punctuation stripped'),
  line: z.number().int().positive().describe('1-based line'),
  column: z.number().int().positive().describe("1-based column of the token's first character"),
  startOffset: z.number().int().nonnegative()
    .describe("0-based UTF-16 code-unit offset of the token's first character — the same unit `ContentMeasures` counts in, so an astral character advances it by two"),
  endOffset: z.number().int().nonnegative()
    .describe("0-based UTF-16 code-unit offset one past the token's last character"),
  syntacticForm: LexicalSyntacticFormSchema,
  ...LEXICAL_FEATURE_COLUMNS,
}).describe('A reference candidate the markdown AST does not produce');

export type LexicalReference = z.infer<typeof LexicalReferenceSchema>;

/**
 * The subset of `ParseResult` that is a function of the parsed bytes alone —
 * i.e. everything a cache entry is entitled to persist.
 *
 * Note what is missing: `content`, `sizeBytes` and `frontmatter`. The first two
 * are re-attached from the caller's own fresh read and the third is re-derived
 * from {@link frontmatterSource}; see the table in `parse-cache.ts`.
 *
 * `.strict()` is load-bearing — see this module's docstring.
 */
export const ParseFactsSchema = z.object({
  links: z.array(ResourceLinkSchema),
  headings: z.array(HeadingNodeSchema),
  estimatedTokenCount: z.number().int().nonnegative(),
  anchors: z.array(z.string()).optional(),
  parseErrors: z.array(HtmlParseErrorSchema).optional(),
  unresolvedReferences: z.array(UnresolvedReferenceSchema).optional(),
  /** See `ParseResult.lexicalReferences`. Omitted when the document has none. */
  lexicalReferences: z.array(LexicalReferenceSchema).optional(),
  /**
   * See `ParseResult.contentMeasures`. A function of the bytes alone, so it is
   * storable by the same rule as `estimatedTokenCount` — and it must be stored,
   * because recomputing `codeBlockCodeUnits` needs the AST the cache exists to
   * avoid building.
   */
  contentMeasures: ContentMeasuresSchema.optional(),
  /** Raw YAML of the frontmatter block, without the `---` delimiters. */
  frontmatterSource: z.string().optional(),
  /**
   * Carried for producers that report a frontmatter error without a source.
   * When `frontmatterSource` IS present, `rehydrate` prefers the value
   * re-derived from it — the two agree by construction, since deriving is what
   * produced this field in the first place.
   */
  frontmatterError: z.string().optional(),
}).strict().describe('The parse facts one cache entry may hold');

export type ParseFacts = z.infer<typeof ParseFactsSchema>;

/**
 * Keys in the generated JSON Schema that carry prose rather than shape.
 *
 * Dropped before hashing so that rewording a `.describe()` — a comment, in
 * effect — cannot cool a developer's cache. Everything a validator would
 * actually *check* stays.
 */
const PROSE_ONLY_KEYS = new Set(['description']);

/** Recursively drop {@link PROSE_ONLY_KEYS} from a JSON value. */
function withoutProse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element) => withoutProse(element));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !PROSE_ONLY_KEYS.has(key))
        .map(([key, nested]) => [key, withoutProse(nested)])
    );
  }
  return value;
}

/**
 * A schema's structure, serialized so it can be hashed.
 *
 * `$refStrategy: 'root'` is load-bearing, not a preference. `toJsonSchema`'s
 * default of `'none'` cannot inline `HeadingNode`'s recursion: it logs a warning
 * to the console on every call and emits `{}` for `children`, which would make
 * the whole recursive branch invisible to whatever consumes this.
 *
 * @param schema - Any Zod schema
 * @returns Canonical JSON of its shape, prose stripped
 */
export function schemaShapeSource(schema: z.ZodTypeAny): string {
  return JSON.stringify(withoutProse(toJsonSchema(schema, { $refStrategy: 'root' })));
}

/**
 * {@link ParseFactsSchema}'s own shape — the one input the cache namespace takes
 * from this module.
 *
 * It exists because of the ❌ row in this file's docstring: an added *optional*
 * field is invisible to validation, so the entries that predate it must be kept
 * in a different directory instead of being rejected on read. Feeding this
 * string into `devNamespaceDigest` does exactly that, and it does it for every
 * other shape edit too — the reparse is then a consequence of the edit, not of
 * anyone remembering.
 *
 * Three properties make it usable as a namespace input:
 *
 * - **Derived** — generated from the schema itself, so it cannot fall behind the
 *   way a hand-bumped revision constant did (see `cache-namespace.ts`). Pinned
 *   by a test that adds an optional field and expects a different string.
 * - **Stable across a rebuild** — by construction, not by care: this reads no
 *   file, no mtime and no module state, so `tsc --build` cannot move it. That is
 *   what separates it from the emitted-module fingerprint this repo removed,
 *   which minted a namespace per build.
 * - **Deterministic across processes** — same build, same string, on any
 *   machine. Pinned by a test. "Same build" includes the lockfile: bumping
 *   `zod-to-json-schema` can change how a schema is emitted and so move this
 *   string once. That is the only input here that is not VAT's own code, it
 *   costs one rescan, and it is arguably the right answer anyway — a converter
 *   change is a change to what this digest can see.
 *
 * @returns Canonical JSON of the schema's shape, prose stripped
 */
export function parseFactsShapeSource(): string {
  return schemaShapeSource(ParseFactsSchema);
}
