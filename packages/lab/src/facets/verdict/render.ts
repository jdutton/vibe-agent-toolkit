/**
 * Plain-text rendering of verdict captures and comparisons.
 *
 * The comparison's order is the reader's order of need: refusals (nothing
 * below them can be trusted), then what FAILS the compare — stale exclusions,
 * undeclared and unused deltas — then what measured nothing (excluded rows,
 * declared-unmeasured rows — named, never folded into "no change"), then what
 * was accepted.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { coordinateLines, instrumentLabel } from '../../harness/render.js';

import type { VerdictComparison, VerdictExcludedRow } from './compare.js';
import type { DeclaredDelta, DeclaredFinding, DeltaChange, ObservedDelta } from './deltas.js';
import { locationDigest, rowVerdict } from './extract.js';
import type { VerdictBody, VerdictRow } from './types.js';

/**
 * @param envelope - One subject's capture
 * @returns Its rows, one line each
 */
export function renderVerdictReport(envelope: ReportEnvelope<VerdictBody>): string {
  return [
    `verdict — ${envelope.coordinate.subject.id}`,
    ...coordinateLines(envelope.coordinate),
    ...envelope.body.rows.map(rowLine),
    ...envelope.body.excluded.map(
      (exclusion) => `  ${exclusion.name}: EXCLUDED (it still ran — see its row) — ${exclusion.reason}`,
    ),
  ].join('\n');
}

/**
 * @param row - One invocation's result
 * @returns A one-line summary
 */
function rowLine(row: VerdictRow): string {
  if (row.outcome === 'not-run') return `  ${row.name}: NOT RUN — ${row.spawnError ?? ''}`;
  const verdict = rowVerdict(row);
  const findings = verdict === null ? '' : `, ${String(verdict.findings.length)} finding(s), ${verdict.shape}`;
  return `  ${row.name}: exit ${String(row.exitCode)}${findings}`;
}

/**
 * @param comparison - A completed comparison
 * @returns The rendered text
 */
export function renderVerdictComparison(comparison: VerdictComparison): string {
  const unmeasured = comparison.accepted.filter((delta) => delta.change.kind === 'unmeasured');
  const accepted = comparison.accepted.filter((delta) => delta.change.kind !== 'unmeasured');
  return [
    `verdict compare${comparison.control ? ' (--control)' : ''}`,
    `Baseline:  ${instrumentLabel(comparison.baseline)}`,
    `Candidate: ${instrumentLabel(comparison.candidate)}`,
    `Rows compared: ${String(comparison.rows.length)}`,
    ...section('REFUSED — the deltas file cannot be judged against this run', comparison.refusals),
    ...section(
      'STALE EXCLUSION — the subjects file says the verb cannot be completed, and both arms measured it; remove the exclusion',
      comparison.staleExclusions.flatMap(excludedLines),
    ),
    ...section('UNDECLARED — observed, and no entry declares it', comparison.undeclared.flatMap(observedLines)),
    ...section('UNUSED — declared, and it did not occur', comparison.unused.map(declaredLine)),
    ...section(
      'EXCLUDED by the subjects file — refused at exit 2 in both arms, so measured nothing; never read these as a pass',
      comparison.excluded.flatMap(excludedLines),
    ),
    ...section('UNMEASURED (declared) — never read these as "no change"', unmeasured.flatMap(observedLines)),
    ...section('Accepted — observed and declared', accepted.flatMap(observedLines)),
    verdictLine(comparison),
  ].join('\n');
}

/**
 * @param heading - The section heading
 * @param lines - Its lines
 * @returns The section, or nothing when it is empty
 */
function section(heading: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : ['', `${heading}:`, ...lines.map((line) => `  ${line}`)];
}

/**
 * @param delta - An observed delta
 * @returns Its line plus its evidence, indented
 */
function observedLines(delta: ObservedDelta): string[] {
  return [`${delta.subject} / ${delta.verb}: ${changeText(delta.change)}`, ...delta.detail.map((line) => `    ${line}`)];
}

/**
 * @param row - An excluded verb, as both arms found it
 * @returns Its line with the subjects file's reason, then what each arm did
 */
function excludedLines(row: VerdictExcludedRow): string[] {
  return [`${row.subject} / ${row.verb}: ${row.reason}`, ...row.detail.map((line) => `    ${line}`)];
}

/**
 * @param delta - A declared delta
 * @returns Its line, with the changelog entry that claimed it
 */
function declaredLine(delta: DeclaredDelta): string {
  return `${delta.subject} / ${delta.verb}: ${changeText(delta.change)} (${delta.changelog})`;
}

/**
 * @param change - One change
 * @returns It, in words
 */
function changeText(change: DeltaChange): string {
  switch (change.kind) {
    case 'exit': {
      return `exit ${String(change.from)} → ${String(change.to)}`;
    }
    case 'finding-added':
    case 'finding-removed': {
      const { code, severity } = change.finding;
      const sign = change.kind === 'finding-added' ? '+' : '-';
      return `${sign} ${severity} ${code} @ ${locationText(change.finding)}`;
    }
    case 'refusal': {
      return `refusal ${refusalText(change.from)} → ${refusalText(change.to)}`;
    }
    case 'document': {
      return 'document reshaped';
    }
    case 'unmeasured': {
      return 'UNMEASURED';
    }
    case 'findings-itemized': {
      return 'findings itemized (exactly the findings the baseline only tallied)';
    }
  }
}

/**
 * Where a finding is, as a reader can act on it: an OBSERVED finding's path
 * with the digest a deltas file may declare it by, or a DECLARED digest alone.
 *
 * @param finding - A finding, by location or by location digest
 * @returns Its location text
 */
function locationText(finding: DeclaredFinding): string {
  if ('locationDigest' in finding) return `sha256:${finding.locationDigest}`;
  return finding.location === null ? '<run>' : `${finding.location} [locationDigest ${locationDigest(finding.location)}]`;
}

/**
 * @param codes - One arm's refusal codes
 * @returns Them, or that none was published
 */
function refusalText(codes: readonly string[]): string {
  return codes.length === 0 ? '(no refusal published)' : codes.join(', ');
}

/**
 * @param comparison - A completed comparison
 * @returns The closing verdict line
 */
function verdictLine(comparison: VerdictComparison): string {
  const stale = comparison.staleExclusions.length;
  const tally =
    `${String(comparison.undeclared.length)} undeclared, ${String(comparison.unused.length)} unused, ` +
    `${String(comparison.accepted.length)} accepted` +
    (comparison.excluded.length === 0 ? '' : `; ${String(comparison.excluded.length)} excluded`) +
    (stale === 0 ? '' : `; ${String(stale)} stale exclusion(s)`);
  if (comparison.refusals.length > 0) return `\nREFUSED (${tally})`;
  const failed = comparison.undeclared.length > 0 || comparison.unused.length > 0 || stale > 0;
  return `\n${failed ? 'FAILED' : 'PASSED'} (${tally})`;
}
