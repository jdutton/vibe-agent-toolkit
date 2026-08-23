import { createHash } from 'node:crypto';

import type { EvalFragment } from './eval-fragment.js';
import { FrictionReportSchema, type FrictionReport } from './friction-schema.js';
import { GradingArmError, GradingNonceError, type NormalizedGrading } from './grading-adapter.js';
import { ToolEvalReportSchema, type ToolEvalReport } from './tool-eval-schema.js';

/**
 * Assemble the run's aggregate grading result (skill-creator's flat
 * `grading.json` shape) from every eval's per-eval grader fragment (issue #145
 * Task 4/5). vat is the SOLE writer of the aggregate; this is that assembly
 * step — the result feeds {@link import('./grading-adapter.js').reconcileGrading}
 * unchanged.
 *
 * Every fragment must carry the SAME `runNonce` the harness stamped for this
 * run — a mismatch means a fragment was not produced for this run (forged,
 * stale, or left behind by untrusted skill code in the shared sandbox) and is
 * rejected via {@link GradingNonceError}, never silently dropped.
 *
 * Every fragment must ALSO belong to the `arm` being assembled (a fragment with
 * no `arm` of its own is a default-'with' fragment — see
 * {@link import('./eval-fragment.js').EvalFragmentSchema}); a fragment from the
 * other arm is rejected via {@link GradingArmError} for the same reason a stale
 * nonce is: the merged count would no longer be a measurement of one arm, and
 * that is exactly the number `--baseline` subtracts. `arm` is REQUIRED, not
 * defaulted, because a default is precisely how a caller would silently
 * mislabel the control artifact as the treatment one.
 *
 * The returned report carries that `arm`, and every merged expectation carries
 * its source fragment's `evalId` — together these are what let a reader holding
 * ONE of the two `--baseline` artifacts say which arm it is, and line the two up
 * per eval to compute a delta at all.
 *
 * Zero fragments in → zero expectations out. This is deliberate: the existing
 * "graded nothing" guard in `reconcileGrading` already throws
 * `GradingSkewError` on an empty `expectations[]`, so that case is NOT
 * special-cased here.
 */
/** How much of the nonce digest to print — enough to tell two runs apart by eye. */
const NONCE_FINGERPRINT_LENGTH = 12;

/**
 * A nonce rendered for an ERROR MESSAGE: never the value, always a digest of it.
 *
 * `runNonce` is the ONE field {@link import('./grader-text.js').sanitizeGraderTextDeep}
 * is told to skip, because it must survive byte-exact to be compared — so it is
 * also the one grader-supplied string in the fragment that reaches an operator
 * with no neutralization at all. The CLI prints an error's `message` raw, so
 * interpolating it here would print attacker bytes BY CONSTRUCTION: a fragment
 * whose `runNonce` is `ESC[2K CR ESC[32m vat: verified` wipes vat's line and
 * continues in vat's colour, from inside the very check that exists to catch a
 * forged fragment.
 *
 * That path is currently unreachable — `runGraderForEval` compares the nonce one
 * call earlier and throws a message quoting nothing — so this is defense in depth,
 * and defense in depth that prints raw untrusted text is not defense. A digest
 * keeps every diagnostic the value had (are the two the same? is the fragment from
 * an older run?) and carries no bytes the fragment chose. Length is reported too,
 * since a truncated or padded nonce is the likeliest honest mistake and the digest
 * hides it.
 */
function nonceFingerprint(nonce: string): string {
  const digest = createHash('sha256').update(nonce, 'utf8').digest('hex').slice(0, NONCE_FINGERPRINT_LENGTH);
  return `sha256:${digest} (${nonce.length} chars)`;
}

export function mergeFragmentsToGrading(
  fragments: EvalFragment[],
  runNonce: string,
  arm: 'with' | 'without',
): NormalizedGrading {
  const expectations: NormalizedGrading['expectations'] = [];

  for (const fragment of fragments) {
    if (fragment.runNonce !== runNonce) {
      throw new GradingNonceError(
        `fragment for eval "${fragment.evalId}" carries runNonce ${nonceFingerprint(fragment.runNonce)}, ` +
          `expected ${nonceFingerprint(runNonce)}`,
      );
    }
    const fragmentArm = fragment.arm ?? 'with';
    if (fragmentArm !== arm) {
      throw new GradingArmError(
        `fragment for eval "${fragment.evalId}" is from the "${fragmentArm}" arm, expected "${arm}"`,
      );
    }
    for (const expectation of fragment.expectations) {
      expectations.push({
        text: expectation.text,
        passed: expectation.passed,
        ...(expectation.evidence === undefined ? {} : { evidence: expectation.evidence }),
        evalId: fragment.evalId,
      });
    }
  }

  const passed = expectations.filter(e => e.passed).length;
  return { summary: { passed, total: expectations.length }, expectations, runNonce, arm };
}

/**
 * Assemble the run's aggregate friction report from every eval's fragment
 * (vat-owned; see friction-schema.ts). Concatenates each fragment's
 * `friction` items (fragments without any are treated as empty), de-dups
 * byte-identical items, then validates the result against
 * {@link FrictionReportSchema} — vat's own output contract, strict, no
 * passthrough.
 */
export function mergeFragmentsToFriction(fragments: EvalFragment[]): FrictionReport {
  const allItems = fragments.flatMap(fragment => fragment.friction ?? []);

  const seen = new Set<string>();
  const deduped = allItems.filter(item => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return FrictionReportSchema.parse({ items: deduped });
}

/**
 * Assemble vat's `tool-eval.json` from every eval's fragment (issue #145
 * Phase T; see tool-eval-schema.ts). A SEPARATE channel from `grading.json`
 * and from friction (C2) — tool verdicts judge declared `toolExpectations`
 * against the transcript, not prose expectations or packaging friction.
 *
 * Fragments carry only the `tool` BODY (no `evalId` — see
 * {@link import('./tool-eval-schema.js').ToolVerdictBodySchema}); this merge
 * re-attaches each fragment's own `evalId` to produce a full
 * {@link import('./tool-eval-schema.js').ToolVerdict}. Fragments with no
 * `tool` body are OMITTED — not every eval declares `toolExpectations`, so
 * "no tool block" is a legitimate, non-error case, not a zero-filled verdict.
 */
export function mergeFragmentsToToolEval(fragments: EvalFragment[]): ToolEvalReport {
  const evals = fragments
    .filter((fragment): fragment is EvalFragment & { tool: NonNullable<EvalFragment['tool']> } => fragment.tool !== undefined)
    .map(fragment => ({ evalId: fragment.evalId, ...fragment.tool }));

  return ToolEvalReportSchema.parse({ evals });
}
