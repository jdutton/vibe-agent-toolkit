/**
 * Plain-text rendering of verdict captures and comparisons.
 *
 * The comparison's order is the reader's order of need: refusals (nothing
 * below them can be trusted), then what FAILS the compare — undeclared and
 * unused deltas — then what was accepted, with unmeasured rows named as
 * UNMEASURED and never folded into "no change".
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { coordinateLines, instrumentLabel } from '../../harness/render.js';

import type { VerdictComparison } from './compare.js';
import type { DeclaredDelta, DeltaChange, ObservedDelta } from './deltas.js';
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
  ].join('\n');
}

/**
 * @param row - One invocation's result
 * @returns A one-line summary
 */
function rowLine(row: VerdictRow): string {
  if (row.outcome === 'not-run') return `  ${row.name}: NOT RUN — ${row.spawnError ?? ''}`;
  const verdict = row.verdict;
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
    ...section('UNDECLARED — observed, and no entry declares it', comparison.undeclared.flatMap(observedLines)),
    ...section('UNUSED — declared, and it did not occur', comparison.unused.map(declaredLine)),
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
      const { code, severity, location } = change.finding;
      const sign = change.kind === 'finding-added' ? '+' : '-';
      return `${sign} ${severity} ${code} @ ${location ?? '<run>'}`;
    }
    case 'document': {
      return 'document reshaped';
    }
    case 'unmeasured': {
      return 'UNMEASURED';
    }
  }
}

/**
 * @param comparison - A completed comparison
 * @returns The closing verdict line
 */
function verdictLine(comparison: VerdictComparison): string {
  const tally =
    `${String(comparison.undeclared.length)} undeclared, ${String(comparison.unused.length)} unused, ` +
    `${String(comparison.accepted.length)} accepted`;
  if (comparison.refusals.length > 0) return `\nREFUSED (${tally})`;
  const failed = comparison.undeclared.length > 0 || comparison.unused.length > 0;
  return `\n${failed ? 'FAILED' : 'PASSED'} (${tally})`;
}
