import { z } from 'zod';

import { FrictionItemSchema } from './friction-schema.js';
import { ToolVerdictBodySchema } from './tool-eval-schema.js';

/** One graded expectation inside a per-eval grader fragment. */
export const EvalFragmentExpectationSchema = z.object({
  text: z.string(),
  passed: z.boolean(),
  evidence: z.string().optional(),
}).strict();

export type EvalFragmentExpectation = z.infer<typeof EvalFragmentExpectationSchema>;

/**
 * Strict shape of a single grader subagent's output (issue #145 Task 4). One
 * GRADER spawn grades ONE eval's expectations from that eval's captured
 * transcript and writes exactly one fragment matching this schema; vat reads
 * every eval's fragment back and merges them into the run's aggregate grading
 * result (skill-creator's flat `grading.json` shape — see grading-adapter.ts).
 *
 * `.strict()`: this is vat's OWN output artifact contract, not external data
 * we're auditing (see CLAUDE.md Postel's Law) — an unrecognized field is a
 * grader bug we want surfaced immediately, not silently dropped.
 *
 * `arm` distinguishes a WITH/WITHOUT baseline run's fragment; absent means the
 * default 'with' (skill present) arm.
 *
 * `tool` (issue #145 Phase T) carries this eval's tool-expectation verdict —
 * a SEPARATE channel from `expectations[]` and from `friction` (see
 * tool-eval-schema.ts). It is {@link ToolVerdictBodySchema}, i.e. a
 * {@link import('./tool-eval-schema.js').ToolVerdict} WITHOUT `evalId`: the
 * fragment already carries `evalId` at its top level, so the merge step
 * (`mergeFragmentsToToolEval` in fragment-merge.ts) re-attaches it from the
 * fragment when assembling vat's `tool-eval.json`.
 */
export const EvalFragmentSchema = z.object({
  runNonce: z.string().min(1),
  evalId: z.string().min(1),
  arm: z.enum(['with', 'without']).optional(),
  expectations: z.array(EvalFragmentExpectationSchema).min(1),
  friction: z.array(FrictionItemSchema).optional(),
  tool: ToolVerdictBodySchema.optional(),
}).strict();

export type EvalFragment = z.infer<typeof EvalFragmentSchema>;

/**
 * Thrown when a single grader subagent's fragment output does not match
 * {@link EvalFragmentSchema}. Deliberately distinct from `GradingSkewError`
 * (grading-adapter.ts): that error's message is specific to the AGGREGATE
 * `grading.json` shape (skill-creator's flat report) and is wrong when the
 * thing that failed to parse is one grader's per-eval fragment — a fragment
 * shape bug is a GRADER bug, not an aggregate-assembly bug, and the message
 * should point at the offending eval, not at "Re-sync the vendored
 * skill-creator".
 */
export class EvalFragmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalFragmentError';
  }
}

/** Best-effort extraction of `evalId` from raw input for error messages, tolerating any shape. */
function extractRawEvalId(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null && 'evalId' in raw) {
    const value = (raw as Record<string, unknown>)['evalId'];
    if (typeof value === 'string' && value.length > 0) return `"${value}"`;
  }
  return '(unknown)';
}

/**
 * Sanitize ONLY the (non-verdict-bearing) `friction` field before the strict
 * fragment parse. Friction is auxiliary advisory data, not a verdict channel —
 * so a grader that wobbles on the friction shape (e.g. emits bare strings, the
 * common failure mode — PR #147) must NOT be allowed to discard the
 * verdict-bearing grading for the whole run. We drop friction items that don't
 * match {@link FrictionItemSchema} (and a `friction` that isn't an array at
 * all), then hand the rest to the STRICT fragment parse — so the verdict
 * channels (`runNonce`/`evalId`/`expectations`/`tool`) stay fully fail-closed
 * and an unknown field elsewhere still surfaces as a grader bug.
 *
 * Returns the possibly-rewritten raw value and how many friction items were
 * dropped (0 when friction is absent or already well-shaped — the input is then
 * returned untouched).
 */
function sanitizeFrictionField(raw: unknown): { value: unknown; dropped: number } {
  if (typeof raw !== 'object' || raw === null || !('friction' in raw)) {
    return { value: raw, dropped: 0 };
  }
  const obj = raw as Record<string, unknown>;
  const friction = obj['friction'];
  if (friction === undefined) return { value: raw, dropped: 0 };
  if (!Array.isArray(friction)) {
    // A non-array `friction` (e.g. a bare string) is unusable auxiliary noise —
    // drop the whole field rather than fail the run over it.
    const rest: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (key !== 'friction') rest[key] = val;
    }
    return { value: rest, dropped: 1 };
  }
  const kept = friction.filter((item) => FrictionItemSchema.safeParse(item).success);
  if (kept.length === friction.length) return { value: raw, dropped: 0 };
  return { value: { ...obj, friction: kept }, dropped: friction.length - kept.length };
}

/**
 * Parse + validate one grader's fragment output. Throws {@link EvalFragmentError}
 * — never {@link GradingSkewError} — because this is a per-eval fragment, not
 * the assembled aggregate `grading.json`.
 *
 * The verdict channels are strict. The auxiliary `friction` field is sanitized
 * leniently first (see {@link sanitizeFrictionField}); when items are dropped,
 * `onWarn` (if given) is called so the operator sees that friction was partial —
 * grading itself is never affected.
 */
export function parseEvalFragment(raw: unknown, onWarn?: (message: string) => void): EvalFragment {
  const { value, dropped } = sanitizeFrictionField(raw);
  if (dropped > 0) {
    onWarn?.(
      `grader fragment for eval ${extractRawEvalId(raw)} had ${dropped} malformed friction item(s) — ` +
        `dropped them (friction is advisory; grading is unaffected).`,
    );
  }
  const result = EvalFragmentSchema.safeParse(value);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join('.') ?? '(root)';
    const evalId = extractRawEvalId(raw);
    throw new EvalFragmentError(
      `grader fragment for eval ${evalId} has an invalid shape: invalid field at "${path}" (${firstIssue?.message ?? 'unknown'})`,
    );
  }
  return result.data;
}
