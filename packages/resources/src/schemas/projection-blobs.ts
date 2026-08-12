import { z } from 'zod';

import { ContentKeySchema, JsonValueSchema } from './projection-shared.js';
import { LinkNodeTypeSchema } from './resource-metadata.js';

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
 * A row of the `blob_links` table — every link found in a blob, in document
 * order.
 *
 * `inCodeSpan`/`inFence` are tracked as data rather than excluded at parse
 * time, deliberately: the kb-graph prototype's fence-handling defect (three
 * wrong numbers from a wikilink scanner that silently dropped links sitting
 * inside code spans) came from doing the exclusion in the scanner instead of
 * the schema. A row that carries the fact lets a query choose to exclude it;
 * a scanner that never emits the row cannot be second-guessed.
 */
export const BlobLinkRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_FK_DESC),
  ordinal: z.number().int().nonnegative().describe("0-based position among this blob's links"),
  rawHref: z.string().describe('The href exactly as authored — unresolved'),
  text: z.string().nullable().describe('Link text, or null for a bare autolink'),
  line: z.number().int().positive(),
  column: z.number().int().positive().nullable(),
  nodeType: LinkNodeTypeSchema,
  inCodeSpan: z.boolean().describe('True when the link sits inside an inline code span'),
  inFence: z.boolean().describe('True when the link sits inside a fenced code block'),
}).strict().describe('A row of the blob-keyed `blob_links` table');

export type BlobLinkRow = z.infer<typeof BlobLinkRowSchema>;

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
 * Severity for a `blob_conditions` row. A fresh, local definition, not a
 * reuse of `schema`'s `SeverityLevelSchema` (`'error' | 'warning' |
 * 'info' | 'ignore'`): that schema's fourth member, `'ignore'`, is a
 * config-resolution state and doesn't apply to a parse-time condition —
 * something that already happened during parsing can't retroactively be
 * "ignored" the way a resolved config value can. Hence the narrower,
 * purpose-built enum here.
 */
export const BlobConditionSeveritySchema = z.enum(['error', 'warning', 'info']);

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
  severity: BlobConditionSeveritySchema,
  message: z.string(),
  line: z.number().int().positive().nullable(),
}).strict().describe('A row of the blob-keyed `blob_conditions` table');

export type BlobConditionRow = z.infer<typeof BlobConditionRowSchema>;
