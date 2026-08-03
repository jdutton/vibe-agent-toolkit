/**
 * The ONE place a `validation.severity` override is applied to already-materialized
 * findings.
 *
 * Every lane that reports findings has to answer the same question — "the adopter
 * configured this code, so what severity does this issue actually carry?" — and the
 * lanes answered it differently for as long as each owned its own copy. Measured on
 * one PR, across a 3-lane × 7-cell matrix driven end to end:
 *
 *  - `vat verify`'s packaged-content phase resolved properly, both directions.
 *  - `vat audit` computed the merged override map correctly and then consulted it
 *    for exactly one value (`!== 'ignore'`), so `ignore` worked and `error` /
 *    `warning` / `info` were silent no-ops. An adopter promoting a code to `error`
 *    saw `severity: warning`, `errors: 0`, `status: warning`.
 *  - `vat verify`'s marketplace phase never met a resolver at all.
 *
 * That is not three bugs, it is one missing module. Anything that re-severities
 * findings imports this; nobody writes a fourth copy. Same rule as
 * `resolveAssetReference` and `resolveSkillReference` in CLAUDE.md.
 */

import { type IssueCode, resolveSeverity, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';

/** A `validation.severity` map as it appears in config, or nothing. */
export interface SeverityOverrides {
  severity?: Record<string, string> | undefined;
}

/**
 * Re-severity findings against a `validation.severity` map, dropping the codes
 * resolved to `ignore`.
 *
 * **Resolution, not just suppression.** Dropping `ignore` codes is the half that is
 * easy to write and the half that looks finished: the documented opt-out starts
 * working, so the escape hatch appears fixed. The promote direction is the half that
 * gets forgotten, and it is the one an adopter reaches for when they want a code to
 * fail their build. A filter that only knows how to delete answers "can I silence
 * this?" and silently ignores "can I enforce this?".
 *
 * Note what each consumer does with the result. Status is re-derived from the
 * returned severities by every caller, so a promotion moves the reported status.
 * Whether it also moves the process exit code is the CALLER's contract, not this
 * function's — `vat verify` derives its exit code from severity, while `vat audit`
 * is advisory and its exit code is tracked separately. Do not "fix" that here.
 *
 * An un-overridden code short-circuits rather than round-tripping through
 * {@link resolveSeverity}. Two reasons, and the second is load-bearing: the answer
 * would be the registry default, which is already the severity the issue carries
 * (`materializeIssue` built it from that same registry); and `resolveSeverity`
 * indexes `CODE_REGISTRY` unguarded, so handing it a non-registry code would throw
 * rather than pass the issue through.
 */
export function resolveIssueSeverity(
  issues: readonly ValidationIssue[],
  validation: SeverityOverrides | undefined,
): ValidationIssue[] {
  const overrides = validation?.severity;
  if (overrides === undefined) return [...issues];

  const resolved: ValidationIssue[] = [];
  for (const issue of issues) {
    if (!(issue.code in overrides)) {
      resolved.push(issue);
      continue;
    }
    const severity = resolveSeverity(issue.code as IssueCode, { severity: overrides });
    if (severity === 'ignore') continue;
    resolved.push(severity === issue.severity ? issue : { ...issue, severity });
  }
  return resolved;
}
