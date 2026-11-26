/**
 * The content-keyed skill-text tables — what the skill-text core
 * (`skill-text/core.ts`) matched in one markdown blob's text, keyed by blob.
 *
 * A markdown parse computes the record (`ParseResult.skillText`), so these are
 * markdown blob facts like `blob_sections`: written by the same write as the
 * blob's other rows, evicted with them, and read back by the one fact reader
 * (`blobFactsReader`). A markdown blob with a `blobs` row has exactly one
 * `skill_text_facts` row; any other blob has none. A markdown blob
 * without its facts row is uncovered (`uncoveredContentKeys`), so the next write replaces it. A record past its bound
 * (`skillTextHeld`) is not kept: its facts row says `held` false and it has no
 * match rows.
 *
 * ⛔ `blob` is the FIRST primary-key column of both tables: a store keys every
 * blob-tier select, delete and eviction on a blob-scoped table's first
 * primary-key column.
 */

import { z } from 'zod';

import { ContentKeySchema } from '../content-key.js';
import {
  type PatternId,
  SKILL_TEXT_FAMILIES,
  SKILL_TEXT_PATTERN_IDS,
  type SkillTextFamily,
} from '../skill-text/declaration.js';

import { FRONTMATTER_FENCES } from './skill-text-facts.js';

/**
 * A row of the `skill_text_facts` table — one per markdown blob: the record's
 * per-document facts and how many match rows it has.
 */
export const SkillTextFactsRowSchema = z.object({
  blob: ContentKeySchema.describe('Foreign key to blobs.contentKey; a markdown blob only'),
  lineCount: z.number().int().positive()
    .describe(String.raw`Lines in the decoded text, split on "\n" alone: a CRLF file counts its CRs into the lines, not as separators`),
  h1: z.string().nullable()
    .describe('The rest of the first line that starts with "#" and a space or tab, raw (untrimmed; a CRLF file keeps its CR), anywhere in the text — frontmatter and code blocks included — or null when there is none'),
  frontmatterFence: z.enum(FRONTMATTER_FENCES)
    .describe('Where the frontmatter fences are, by the skill frontmatter fence rule (a leading BOM dropped, CRLF, lone CR and LF each a line ending, the first line "---" then optional spaces or tabs, the block closed by the next such line): "none" with no opening fence, "unclosed" with no closing one, "closed" with both. Kept whether or not the record is held'),
  matchCount: z.number().int().nonnegative()
    .describe('How many matches the record has; when held, how many skill_text_matches rows the blob has, and the reader refuses a blob whose rows do not add up to it'),
  held: z.boolean()
    .describe('Whether the store keeps the record: false when it is past its bound (as many matches as the default outputRows, as many JSON bytes as the default outputBytes), and the blob then has no skill_text_matches rows and the skills lane scans the text itself'),
}).strict().describe('A row of the blob-keyed `skill_text_facts` table');

/**
 * A row of the `skill_text_matches` table — one thing a skills-phase detector
 * matched in a markdown blob's text, in the order the detectors emit.
 */
export const SkillTextMatchRowSchema = z.object({
  blob: ContentKeySchema.describe('Foreign key to blobs.contentKey'),
  ordinal: z.number().int().nonnegative()
    .describe('0-based emission order across every family: families in declaration order, each family\'s matches in the order its detector reports them'),
  family: z.enum(SKILL_TEXT_FAMILIES as [SkillTextFamily, ...SkillTextFamily[]])
    .describe('The detector family that matched; a "*Body" family scanned the frontmatter parser\'s body rather than the whole text'),
  patternId: z.enum(SKILL_TEXT_PATTERN_IDS as [PatternId, ...PatternId[]])
    .describe('Which of the family\'s declared patterns matched'),
  line: z.number().int().positive()
    .describe('1-based line in the string the family scans: the whole text, or the frontmatter parser\'s body for a "*Body" family'),
  matchText: z.string().describe('What matched, raw (the skills lane trims, truncates or formats it as its message does), well-formed: a lone surrogate the match held (a sample cut inside a surrogate pair) is U+FFFD here and recorded in loneSurrogates'),
  loneSurrogates: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().min(0xd8_00).max(0xdf_ff)])).nullable()
    .describe('The lone surrogates matchText held before it was made well-formed, as [code-unit index, code unit] pairs in index order, or null when it held none: the reader puts each back, so the record is the one the core computed'),
}).strict().describe('A row of the blob-keyed `skill_text_matches` table');

export type SkillTextFactsRow = z.infer<typeof SkillTextFactsRowSchema>;
export type SkillTextMatchRow = z.infer<typeof SkillTextMatchRowSchema>;
