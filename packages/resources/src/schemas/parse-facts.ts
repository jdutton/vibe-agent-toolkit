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
 * The remedy for that class is `vat cache clear`, deliberately: a developer who
 * changes what a parse means knows they did. There is no second version number
 * here to bump — an installed build's cache namespace is the VAT version, which
 * already moves on every release, and a dev checkout's namespace is per
 * worktree. See `cache-namespace.ts`.
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

import { z } from 'zod';

import { LEXICAL_FEATURE_COLUMNS } from './projection-blobs.js';
import {
  HeadingNodeSchema,
  HtmlParseErrorSchema,
  ResourceLinkSchema,
  UnresolvedReferenceSchema,
} from './resource-metadata.js';

/**
 * Byte and word accounting for one blob, split by code context.
 *
 * Both byte counts are in UTF-16 code units of the *decoded* document, not
 * bytes on disk — decoding is many-to-one on malformed UTF-8, and `BlobRow.bytes`
 * carries the on-disk count separately for that reason.
 */
export const ContentMeasuresSchema = z.object({
  wordCount: z.number().int().nonnegative().describe('Whitespace-delimited words outside fenced code'),
  proseBytes: z.number().int().nonnegative().describe('Characters outside fenced code'),
  codeBlockBytes: z.number().int().nonnegative().describe('Characters inside fenced code'),
}).describe('Byte and word accounting for one blob, split by code context');

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
    .describe("0-based character offset of the token's first character"),
  endOffset: z.number().int().nonnegative()
    .describe("0-based character offset one past the token's last character"),
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
   * because recomputing `codeBlockBytes` needs the AST the cache exists to
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
