/**
 * The document `vat skill review --yaml` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

/** One checklist section: which automated findings landed in it, and what a reviewer walks through by hand. */
const ReviewSectionSchema = z.object({
  section: z.string(),
  /** Codes of the envelope's findings that belong to this section, in finding order. */
  codes: z.array(z.string()),
  /** The judgment-call items a reviewer completes for this section. */
  manual: z.array(z.string()),
}).strict();

/** What the review reports beyond its findings. */
const SkillReviewDataSchema = z.object({
  skill: z.string(),
  /** The path the caller named. */
  source: z.string(),
  metadata: z.object({
    skillLines: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    directFileCount: z.number().int().nonnegative(),
    maxLinkDepth: z.number().int().nonnegative(),
    excludedReferenceCount: z.number().int().nonnegative(),
    excludedReferences: z.array(z.object({
      path: z.string(),
      reason: z.string(),
      matchedPattern: z.string().optional(),
    }).strict()),
  }).strict(),
  /**
   * Every checklist section, in rubric order — including the ones no finding
   * landed in, because the manual items are the point of a review and a
   * section with nothing automated still has to be walked through.
   */
  sections: z.array(ReviewSectionSchema),
}).strict();

export type SkillReviewData = z.infer<typeof SkillReviewDataSchema>;

/** The document `--yaml` publishes. */
export const SKILL_REVIEW_REPORT_SCHEMA = reportSchema(SkillReviewDataSchema, FindingSchema);

export type SkillReviewReport = Report<SkillReviewData>;
