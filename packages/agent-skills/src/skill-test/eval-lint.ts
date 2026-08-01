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

import { isSingleEditAway, type EvalEntry } from './eval-inputs.js';

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

// ---------------------------------------------------------------------------
// Undeclared-executable lint (issue #145 adopter follow-up)
// ---------------------------------------------------------------------------

// A trailing script/binary extension we strip before comparing an executable
// name to a declared one, so `csvsum.py`/`./csvsum`/`csvsum` all normalize to `csvsum` (the
// grader already recognizes those launch forms — see deriveDeclaredExecutableNames,
// which strips the extension from a declared name too). Matches only well-known
// script suffixes so a name that legitimately ENDS in one of these words is left
// alone.
const SCRIPT_EXTENSION = /\.(?:py|js|mjs|cjs|ts|sh|rb|go|pl|php)$/i;

/** Normalize an executable name for comparison: trim, drop a leading `./` and a trailing script extension, lowercase. */
function normalizeExecutableName(name: string): string {
  return name.trim().replace(/^\.\//, '').replace(SCRIPT_EXTENSION, '').toLowerCase();
}

/** Every executable named across an eval's `toolExpectations` arrays (mustRun/mustNotRun/mustSucceed/sequence). */
function collectToolExpectationExecutables(entry: EvalEntry): string[] {
  const te = entry.toolExpectations;
  if (te === undefined) return [];
  return [...(te.mustRun ?? []), ...(te.mustNotRun ?? []), ...(te.mustSucceed ?? []), ...(te.sequence ?? [])];
}

/**
 * True when `decorated` is `stem` plus a SEPARATOR-delimited suffix — i.e. `stem`
 * is a ≥3-char prefix of `decorated` and the next char is a non-alphanumeric
 * separator (`-`, `_`, `.`, space). Catches a declared `csvsum` typo'd as `csvsum-py`
 * (a `-py` decoration) while NOT firing on a genuinely different word that merely
 * shares a prefix (`git` vs `github` — the boundary char `h` is alphanumeric).
 */
function isDecoratedStem(decorated: string, stem: string): boolean {
  if (stem.length < 3 || decorated.length <= stem.length || !decorated.startsWith(stem)) return false;
  return /[^a-z0-9]/.test(decorated.charAt(stem.length));
}

/**
 * The declared executable a referenced `name` is PROBABLY a typo of, or undefined
 * when it matches a declared name exactly (recognized — no warning) or is not
 * close to any declared name (a legit reference to a built-in/system tool like
 * `Bash`/`git` — also no warning, staying conservative like {@link lintEvalExpectations}).
 * "Close" = a single-edit typo of, or a separator-decorated form of, a declared name.
 */
function probableDeclaredTypoTarget(
  name: string,
  declared: { original: string; normalized: string }[],
): string | undefined {
  const normalized = normalizeExecutableName(name);
  if (declared.some((d) => d.normalized === normalized)) return undefined; // exact / recognized launch form
  for (const d of declared) {
    if (isSingleEditAway(normalized, d.normalized)) return d.original;
    if (isDecoratedStem(normalized, d.normalized) || isDecoratedStem(d.normalized, normalized)) return d.original;
  }
  return undefined;
}

/**
 * Advisory (never-fatal) lint: flag a `toolExpectations` entry that names an
 * executable which looks like a TYPO of one of the skill's `declaredExecutables`
 * (issue #145 adopter follow-up). A name that never matches a real tool is a quiet
 * footgun — `mustRun`/`mustSucceed`/`sequence` then fail for the wrong reason, and
 * `mustNotRun` passes vacuously (the tool "never ran" only because the name is
 * wrong). This is zero-token static plumbing, run before any spend.
 *
 * Conservative, like {@link lintEvalExpectations}: it only fires when there is a
 * SPECIFIC declared name the reference is probably a typo of (so it can suggest
 * "did you mean X?"). A reference that matches a declared name exactly, or that is
 * not close to any declared name (a deliberate built-in/system tool reference), is
 * never flagged. When the skill declares no executables there is nothing to compare
 * against, so it returns no warnings. Pure + side-effect free.
 */
export function lintToolExpectationExecutables(
  evals: EvalEntry[],
  declaredExecutableNames: string[],
): EvalLintWarning[] {
  const warnings: EvalLintWarning[] = [];
  const declared = declaredExecutableNames.map((original) => ({ original, normalized: normalizeExecutableName(original) }));
  if (declared.length === 0) return warnings;
  const declaredList = declared.map((d) => d.original).join(', ');
  for (const entry of evals) {
    const evalId = String(entry.id);
    const seen = new Set<string>();
    for (const name of collectToolExpectationExecutables(entry)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const target = probableDeclaredTypoTarget(name, declared);
      if (target === undefined) continue;
      warnings.push({
        evalId,
        message:
          `eval "${evalId}": toolExpectation references executable "${name}", which no declared executable matches — ` +
          `did you mean "${target}"? A name that never matches a real tool makes mustRun/mustSucceed/sequence fail ` +
          `for the wrong reason (or mustNotRun pass vacuously). Declared executables: ${declaredList}.`,
      });
    }
  }
  return warnings;
}
