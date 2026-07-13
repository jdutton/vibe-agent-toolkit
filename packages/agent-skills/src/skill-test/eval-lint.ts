/**
 * Advisory (never-fatal) lint over an eval suite's `expectations` prose (issue #145
 * follow-up). An adopter reported that WEAK expectations — pure "mentions X" /
 * "includes Y" presence checks with no discriminating or negative counterpart —
 * pass even for a hallucinated or right-for-the-wrong-reason answer, giving false
 * confidence in a green run. This module flags that pattern so authors can
 * strengthen the eval; it never blocks a run or changes an exit code.
 *
 * Deliberately conservative: this is a heuristic over free-text prose, not a
 * grammar. When in doubt, do NOT warn — a false "your eval is weak" nag is worse
 * than a missed one, since the grader (an LLM judging the transcript) is the real
 * backstop for eval quality.
 */

import type { EvalEntry } from './eval-inputs.js';

/** One advisory finding: `evalId` names the offending eval, `message` is the full advisory text. */
export interface EvalLintWarning {
  evalId: string;
  message: string;
}

// An expectation "looks like" a pure presence/mention check when it uses one of
// these verbs — the vocabulary authors reach for when asserting "X shows up
// somewhere in the output" without saying what a WRONG output would look like.
const PRESENCE_ONLY_PATTERN = /\b(mentions?|includes?|contains?|references?|present|appears?|states?)\b/i;

// Any of these cues make an expectation discriminating, regardless of whether it
// also uses a presence verb above: negation ("not"/"never"/"without"/"must not"),
// an explicit alternative ("instead of"/"rather than"), a precision bound
// ("only"/"exactly"), or a named failure mode ("wrong"/"incorrect"/"fails"/
// "error"). ONE such cue on an expectation is enough to exempt it from the
// presence-only bucket — a single negative check already rules out a hallucinated
// or wrong-for-the-right-reason answer for that expectation.
const DISCRIMINATING_PATTERN =
  /\b(not|never|without|must not|should not|instead of|rather than|wrong|incorrect|only|exactly|fails?|error)\b/i;

/** True when a single expectation string is a presence-only check (matches the presence vocabulary and carries no discriminating cue). */
function isPresenceOnlyExpectation(expectation: string): boolean {
  return PRESENCE_ONLY_PATTERN.test(expectation) && !DISCRIMINATING_PATTERN.test(expectation);
}

/**
 * Lint a parsed eval suite's `expectations` for the weak-presence-only pattern.
 * Flags an eval only when ALL of these hold (conservative — minimize false
 * positives):
 *   (a) it has at least one expectation;
 *   (b) EVERY expectation string is presence-only (see {@link isPresenceOnlyExpectation});
 *   (c) the eval declares no `toolExpectations` — a `mustRun`/`mustNotRun`/`sequence`
 *       assertion is itself discriminating (it can fail a transcript that never
 *       invoked the right tool), so its presence already covers the concern this
 *       lint exists to catch.
 *
 * Pure and side-effect free — callers decide how/where to surface the warnings
 * (this never throws and never affects exit code).
 */
export function lintEvalExpectations(evals: EvalEntry[]): EvalLintWarning[] {
  const warnings: EvalLintWarning[] = [];
  for (const entry of evals) {
    if (entry.expectations.length === 0) continue;
    if (entry.toolExpectations !== undefined) continue;
    if (!entry.expectations.every(isPresenceOnlyExpectation)) continue;
    const evalId = String(entry.id);
    warnings.push({
      evalId,
      message:
        `eval "${evalId}": all expectations are presence-only ("mentions/includes …") with no discriminating ` +
        'or negative check — a hallucinated or wrong-for-the-right-reason answer may still pass. Add a negative ' +
        'expectation or a toolExpectations assertion.',
    });
  }
  return warnings;
}
