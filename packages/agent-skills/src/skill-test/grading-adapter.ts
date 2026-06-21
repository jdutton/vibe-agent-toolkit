import { z } from 'zod';

/** Thrown when skill-creator's grading.json shape has drifted from what vat reads. */
export class GradingSkewError extends Error {
  constructor(message: string) {
    super(`grading.json shape skew: ${message}. Re-sync the vendored skill-creator / adopted shapes.`);
    this.name = 'GradingSkewError';
  }
}

/**
 * Liberal read of skill-creator's external grading.json. `.passthrough()` keeps
 * unknown fields (viewer urls, etc.) — we validate only what we understand
 * (Postel). Field names mirror skill-creator's grader output.
 */
const ExternalGradingSchema = z.object({
  summary: z.object({
    passed: z.number(),
    total: z.number(),
  }).passthrough(),
  expectations: z.array(
    z.object({
      text: z.string(),
      passed: z.boolean(),
      evidence: z.string().optional(),
    }).passthrough(),
  ),
}).passthrough();

export interface NormalizedGrading {
  summary: { passed: number; total: number };
  expectations: { text: string; passed: boolean; evidence?: string }[];
}

export function parseGradingJson(raw: unknown): NormalizedGrading {
  const result = ExternalGradingSchema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join('.') ?? '(root)';
    throw new GradingSkewError(`missing/invalid field at "${path}" (${firstIssue?.message ?? 'unknown'})`);
  }
  const { summary, expectations } = result.data;
  return {
    summary: { passed: summary.passed, total: summary.total },
    expectations: expectations.map(e => ({
      text: e.text,
      passed: e.passed,
      ...(e.evidence === undefined ? {} : { evidence: e.evidence }),
    })),
  };
}
