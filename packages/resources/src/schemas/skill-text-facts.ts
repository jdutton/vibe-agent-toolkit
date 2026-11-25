/**
 * The one schema of a skill-text record, and the record's types, inferred from
 * it: what the core returns and what a stored value must be before a lane
 * reads it back are one shape.
 */

import { z } from 'zod';

import {
  type PatternId,
  SKILL_TEXT_FAMILIES,
  SKILL_TEXT_FAMILY_PATTERNS,
  SKILL_TEXT_DECLARATION,
  SKILL_TEXT_PATTERN_IDS,
  type SkillTextFamily,
} from '../skill-text/declaration.js';

/** The record's `frontmatterFence` values, as the declaration spells them. */
const { none, unclosed, closed } = SKILL_TEXT_DECLARATION.body.fenceStates;
export const FRONTMATTER_FENCES = [none, unclosed, closed] as const;

/** Where a document's frontmatter fences are: the record's `frontmatterFence`. */
export type FrontmatterFence = (typeof FRONTMATTER_FENCES)[number];

const SkillTextMatchSchema = z
  .object({
    /** The record's position in `matches`: the order the detectors emit in. */
    ordinal: z.number().int().nonnegative(),
    family: z.enum(SKILL_TEXT_FAMILIES as [SkillTextFamily, ...SkillTextFamily[]]),
    patternId: z.enum(SKILL_TEXT_PATTERN_IDS as [PatternId, ...PatternId[]]),
    /** 1-based, in the string the family scans (the parser body for the `*Body` families). */
    line: z.number().int().positive(),
    /** What matched, raw: a constructor trims, truncates or formats it as today's message does. */
    matchText: z.string(),
  })
  .strict()
  .superRefine((match, context) => {
    const allowed: readonly PatternId[] = SKILL_TEXT_FAMILY_PATTERNS[match.family];
    if (!allowed.includes(match.patternId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `pattern ${match.patternId} is not one of family ${match.family}'s`,
        path: ['patternId'],
      });
    }
  });

/** Each family's position in {@link SKILL_TEXT_FAMILIES}, the order the core emits families in. */
const FAMILY_RANK = new Map(SKILL_TEXT_FAMILIES.map((family, rank) => [family, rank]));

/**
 * A stored skill-text record. Each match's `ordinal` is its index, and the
 * matches' families never go back in {@link SKILL_TEXT_FAMILIES} order.
 */
export const SkillTextFactsSchema = z
  .object({
    /** The text's line count, split on the line separator. */
    lineCount: z.number().int().positive(),
    /** The first H1's raw capture (untrimmed; a CRLF file keeps its CR), or `null`. */
    h1: z.string().nullable(),
    /**
     * Where the frontmatter fences are, by the one fence rule (`frontmatterFencesOf`):
     * no opening fence line, an opening fence with no closing one, or both. With the
     * parse's frontmatter verdict it says why a document has no frontmatter without
     * reading it again.
     */
    frontmatterFence: z.enum(FRONTMATTER_FENCES),
    matches: z.array(SkillTextMatchSchema),
  })
  .strict()
  .superRefine((facts, context) => {
    let rank = 0;
    for (const [index, match] of facts.matches.entries()) {
      if (match.ordinal !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `match ${index} carries ordinal ${match.ordinal}`,
          path: ['matches', index, 'ordinal'],
        });
      }
      const matchRank = FAMILY_RANK.get(match.family) ?? rank;
      if (matchRank < rank) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `match ${index} of family ${match.family} comes after a later family`,
          path: ['matches', index, 'family'],
        });
      }
      rank = Math.max(rank, matchRank);
    }
  });

/** One thing a detector computed from the text. */
export type SkillTextMatch = z.infer<typeof SkillTextMatchSchema>;

/** The skill-text facts of one document. */
export type SkillTextFacts = z.infer<typeof SkillTextFactsSchema>;
