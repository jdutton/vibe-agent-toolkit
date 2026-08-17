import { z } from 'zod';

import { ContentKeySchema, JsonValueSchema, ProjectionConditionSeveritySchema } from './projection-shared.js';

const BLOB_FK_DESC = 'Foreign key to blobs.contentKey';

/**
 * A row of the `blobs` table — proposed projection schema,
 * resource-projection.md §2.
 *
 * Path-INDEPENDENT: every field is a pure function of the blob's bytes (plus
 * which parser it was routed to, folded into {@link ContentKeySchema}
 * itself). Two files with identical content anywhere in the corpus, at any
 * point in history, produce exactly one row.
 */
export const BlobRowSchema = z.object({
  contentKey: ContentKeySchema.describe('Primary key — see content-key.ts'),
  bytes: z.number().int().nonnegative().describe('Raw byte length of the blob'),
  tokenEstimate: z.number().int().nonnegative().describe('Estimated token count for LLM context'),
  frontmatter: z.record(z.string(), JsonValueSchema).nullable()
    .describe('Parsed frontmatter as JSON, or null when the blob has no frontmatter block'),
  frontmatterError: z.string().nullable()
    .describe('Why frontmatter did not parse to an object, or null when it did (including "no block at all")'),
  wordCount: z.number().int().nonnegative(),
  proseBytes: z.number().int().nonnegative().describe('Bytes outside fenced/inline code'),
  codeBlockBytes: z.number().int().nonnegative().describe('Bytes inside fenced code blocks'),
  linkCount: z.number().int().nonnegative(),
  headingCount: z.number().int().nonnegative(),
  sectionCount: z.number().int().nonnegative(),
}).strict().describe('A row of the blob-keyed `blobs` table');

export type BlobRow = z.infer<typeof BlobRowSchema>;

/**
 * The syntactic form of a reference candidate, as a **lexer** sees it —
 * before any lens decides what it means.
 *
 * The first three come from the markdown AST. The last three come from the
 * raw-source lexer, because they are not markdown constructs at all:
 *
 * - `at-prefixed` — a whitespace-delimited token beginning `@`. This is where
 *   the `@` collision lives and is *not* resolved here:
 *   `@packages/foo/bar.md` is a Claude Code import and
 *   `@vibe-agent-toolkit/utils` is an npm package specifier. Both are
 *   `at-prefixed` at the blob layer; only a lens decides.
 * - `env-anchored` — a token containing a variable expansion
 *   (`${CLAUDE_PLUGIN_ROOT}/scripts/x.js`). Certain syntax,
 *   lens-conditional resolution: the plugin extent can resolve it, the
 *   standalone-skill extent cannot — which is exactly what the shipped
 *   `NON_PORTABLE_ASSET_REFERENCE` code flags by hand today.
 * - `bare-token` — a path-shaped token with no markup at all.
 */
export const ReferenceSyntacticFormSchema = z.enum([
  'markdown-link',
  'markdown-link-reference',
  'markdown-definition',
  'at-prefixed',
  'env-anchored',
  'bare-token',
]).describe('Syntactic form of a reference candidate, as a lexer sees it');

export type ReferenceSyntacticForm = z.infer<typeof ReferenceSyntacticFormSchema>;

/**
 * Which variable-expansion syntax a token uses. Lexical, not semantic: the
 * blob layer records that `${FOO}` is a brace expansion, never what `FOO`
 * expands to — that is a binding environment, which is a lens's property.
 *
 * - `brace` — `${VAR}` (POSIX shell, and VAT's own asset references)
 * - `bare` — `$VAR` (POSIX shell)
 * - `percent` — `%VAR%` (cmd.exe)
 * - `powershell` — `$env:VAR`
 */
export const VariableExpansionSyntaxSchema = z.enum(['brace', 'bare', 'percent', 'powershell'])
  .describe('Variable-expansion syntax present in a reference token');

export type VariableExpansionSyntax = z.infer<typeof VariableExpansionSyntaxSchema>;

/**
 * A row of the `blob_references` table — every reference **candidate** found
 * in a blob.
 *
 * Renamed from `blob_links` because the name was a claim the data cannot
 * make: a markdown link is certainly a link, and an `@`-prefixed token is
 * not. What this table holds is candidates with their shape recorded.
 *
 * ## Only what a lexer can determine without leaving the file
 *
 * The parse cache is content-addressed, so **the same bytes share one entry
 * across every corpus that contains them**. A cached fact like
 * "`@vibe-agent-toolkit/utils` is an npm package" would be true in one
 * repository and false in another and served confidently to both — the same
 * defect class as a shared `ParseResult` letting one skill inherit another's
 * id: *a cache entry carrying a fact that is not a function of its key*. The
 * namespace directory protects against shape changes and offers nothing
 * against this.
 *
 * So: position, syntactic form, lexical features, code context. Nothing
 * else. `xxx/yyy` is simultaneously path-, package- and plugin/skill-shaped;
 * only an extent can say which, and the answer may legitimately differ per
 * lens. Even *"is this an import"* is path-dependent, because an `@` token
 * means import only in a file named `CLAUDE.md`, `CLAUDE.local.md`, or under
 * `.claude/rules/` — and a filename is not a blob fact.
 *
 * ## `inCodeSpan` / `inFence` are load-bearing
 *
 * Anthropic documents that import parsing **skips code spans and fenced
 * blocks** (with a documented backtick workaround). So these two columns
 * decide whether an `@` token is an import *at all*. They are tracked as data
 * rather than excluded at lex time, deliberately: the kb-graph prototype's
 * fence-handling defect — three wrong numbers from a wikilink scanner that
 * silently dropped links inside code spans — came from doing the exclusion in
 * the scanner instead of the schema. A row that carries the fact lets a query
 * choose to exclude it; a scanner that never emits the row cannot be
 * second-guessed.
 *
 * ## `startOffset`/`endOffset` — the span, not just the position
 *
 * `line` says where a reference is for a human; the half-open span says where it
 * is for a **rewriter**. The two are not interchangeable: `column` is null for
 * every AST-derived markdown link (`ResourceLink` carries none), so line alone
 * cannot locate the second link on a line — and AST-derived links are exactly
 * the population a link rewriter would edit.
 *
 * Both columns are **required**, which is what makes the table's rows uniformly
 * actionable: a candidate whose AST node carries no position is skipped and
 * counted (`referencesSkippedForMissingLine`), never admitted with a null span.
 * Line and offsets come from one `position` object, so they are present or
 * absent together and no new skip class exists.
 *
 * They are offsets into the **decoded** content — UTF-16 code units, the same
 * units `ContentMeasures` and `estimateTokens` count — not bytes on disk. A
 * rewriter operates on the decoded string, which is what it has.
 *
 * ⚠️ The span is what it would REPLACE, and nothing more. Whether a reference
 * *should* be rewritten — whether `/docs/x.md` resolves as well as `../../docs/x.md`
 * does — depends on the corpus root and on which surface reads the file, so it
 * is a lens's judgement over this table and can never be a column in it. See
 * this schema's "Only what a lexer can determine without leaving the file".
 *
 * ## Ordinal ordering
 *
 * **One ordinal space, ordered by `(line, column)`** — the AST-derived and
 * lexer-derived sequences are interleaved, not concatenated. `ordinal` is
 * documented above as "0-based position among this blob's references", and two
 * producer-scoped sequences would make that false: an ordinal would identify a
 * row only in company with the producer that emitted it, which is not a column
 * here. Edges keying on `(blob, ordinal)` need the pair to be sufficient.
 *
 * An AST-derived row carries **no** column — `ResourceLink` has none, which is
 * why `column` is nullable — and a null column sorts before a real one on the
 * same line, since "somewhere on this line" cannot be placed among known
 * columns. `blob-references.ts` holds the full ordering rule and its tie-break.
 *
 * > This paragraph previously described the opposite (markdown first, lexer
 * > appended) and justified it as preserving shipped golden ordinals. No golden
 * > pins `blob_references` ordinals — the table is new — so that rationale was
 * > false as well as contradicting the implementation.
 */
export const BlobReferenceRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_FK_DESC),
  ordinal: z.number().int().nonnegative().describe("0-based position among this blob's references"),
  rawRef: z.string().describe('The reference exactly as authored — unresolved'),
  text: z.string().nullable().describe('Link text for a markdown form, or null for a bare autolink or any lexer-derived form'),
  line: z.number().int().positive(),
  column: z.number().int().positive().nullable()
    .describe('1-based column. Null for a markdown form derived from an AST node that carries no column.'),
  startOffset: z.number().int().nonnegative()
    .describe('0-based character offset of the reference token in the decoded content'),
  endOffset: z.number().int().nonnegative()
    .describe('0-based character offset one past the reference token — the half-open span [startOffset, endOffset)'),
  syntacticForm: ReferenceSyntacticFormSchema,
  hasExtension: z.boolean().describe('The token ends in a dot followed by a short alphanumeric run'),
  leadingAt: z.boolean().describe('The token begins with "@"'),
  slashCount: z.number().int().nonnegative().describe('Number of "/" characters in the token'),
  variableExpansion: VariableExpansionSyntaxSchema.nullable()
    .describe('Which expansion syntax the token uses, or null when it contains none'),
  inCodeSpan: z.boolean().describe('True when the reference sits inside an inline code span'),
  inFence: z.boolean().describe('True when the reference sits inside a fenced code block'),
}).strict().describe('A row of the blob-keyed `blob_references` table');

export type BlobReferenceRow = z.infer<typeof BlobReferenceRowSchema>;

/**
 * A row of the `blob_sections` table — one row per heading, forming a flat
 * (`ordinal` + `parentOrdinal`) encoding of the heading tree.
 *
 * `slugOccurrence` exists because a raw GitHub slug collides: the kb-graph
 * prototype measured 67 `(path, slug)` groups with 257 duplicate rows before
 * adding GitHub's own `-1`/`-2` duplicate-occurrence suffix, which took
 * collisions to zero. This column carries that occurrence number as data
 * instead of baking it into `slug` itself, so a query can still group by the
 * bare heading text.
 */
export const BlobSectionRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_FK_DESC),
  ordinal: z.number().int().nonnegative().describe('0-based document order — NOT the heading tree order'),
  depth: z.number().int().min(1).max(6).describe('Heading level, 1 for #'),
  title: z.string(),
  slug: z.string().describe('GitHub-slugger slug, WITHOUT the -N occurrence suffix — see slugOccurrence'),
  slugOccurrence: z.number().int().nonnegative()
    .describe('0 for the first heading with this slug in the blob, 1 for the second, etc.'),
  parentOrdinal: z.number().int().nonnegative().nullable()
    .describe('ordinal of the enclosing heading, or null at the top of the tree'),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  bytes: z.number().int().nonnegative().describe('Bytes spanned by this section, including nested subsections'),
  tokens: z.number().int().nonnegative(),
}).strict().describe('A row of the blob-keyed `blob_sections` table');

export type BlobSectionRow = z.infer<typeof BlobSectionRowSchema>;

/**
 * A row of the `blob_conditions` table — parse-time oddities.
 *
 * `code = 'PARSE_ODDITY'` is the documented escape hatch
 * (resource-projection.md §2) for a condition with no enum yet: free text in
 * `message`, promoted to a real code once its base rate justifies it.
 * Today's shipped `ParseFacts` carries the same information as
 * `parseErrors`/`frontmatterError`/`unresolvedReferences` fields on the
 * cache entry rather than as rows; this table is the row-shaped
 * generalization proposed for the projection.
 */
export const BlobConditionRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_FK_DESC),
  code: z.string().min(1).describe('An enum member, or "PARSE_ODDITY" for an unclassified oddity'),
  severity: ProjectionConditionSeveritySchema,
  message: z.string(),
  line: z.number().int().positive().nullable(),
}).strict().describe('A row of the blob-keyed `blob_conditions` table');

export type BlobConditionRow = z.infer<typeof BlobConditionRowSchema>;
