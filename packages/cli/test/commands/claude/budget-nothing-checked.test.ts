/**
 * `vat claude budget` must never answer `success` for a run that checked nothing.
 *
 * ## The defect
 *
 * `vat claude budget no/such/dir` reported `status: success` and exited 0. The
 * path matched no working location, so zero chains were measured — and zero
 * findings is byte-identical to "everything you asked about is within budget".
 * The command already KNEW: it warned on stderr that *"nothing was checked
 * there — this is NOT a report that those paths are within budget"* and then
 * published a document saying the opposite. The human channel and the machine
 * channel disagreed, and only the machine channel gates a build.
 *
 * ## Why the assertion is on `buildReport` and not only on the handler
 *
 * The invariant has to be UNREPRESENTABLE, not merely observed once. Deriving
 * the finding inside the report builder means there is no way to construct a
 * report that carries an unmatched path and a clean status — a later edit to the
 * handler's pipeline cannot reintroduce the gap, because the pipeline no longer
 * owns the decision.
 *
 * ## Why the whole-tree case is here too
 *
 * `scopeSweepToPaths` files the bare invocation's `''` scope as unmatched when
 * the sweep found no locations at all, so "the tree has nothing to measure" and
 * "you named a directory that does not exist" are ONE mechanism. Pinning both
 * from the composed pair is what stops a fix narrowed to the argument case.
 *
 * The precedent followed is `vat resources check`'s `emptyCorpusFinding`: a
 * non-overridable `RESOURCE_CHECK_BROKEN` at `error`, because "the gate did not
 * run" is not a severity an adopter may configure away.
 */

import type { BudgetSweep } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import {
  buildReport,
  createBudgetCommand,
  renderReportText,
  type BudgetReport,
} from '../../../src/commands/claude/budget.js';
import { scopeSweepToPaths } from '../../../src/utils/context-budget-issues.js';

/** A sweep that measured nothing — the shape a tree with no corpus produces. */
const EMPTY_SWEEP: BudgetSweep = {
  locations: [],
  evaluatedDirectories: 0,
  queriedDirectories: 0,
  skippedUnknownLocations: 0,
};

/** The measured defect's argument: `vat claude budget no/such/dir` answered success. */
const MISSING_PATH = 'no/such/dir';

/** The verdict a run that checked nothing must never reach. */
const SUCCESS = 'success';

/** The code the run-integrity refusal carries, shared with `vat resources check`. */
const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

/**
 * A report over the empty sweep, for the given unmatched scope.
 *
 * ONE builder for every case here — including the control — so a case cannot
 * differ from its neighbour in a field nobody meant to change.
 *
 * @param unmatchedScope - The requested paths that named no working location
 * @returns The report, carrying no budget findings of its own
 */
function reportWithUnmatched(unmatchedScope: readonly string[]): BudgetReport {
  return buildReport({
    root: '/repo',
    threshold: 12_000,
    scope: unmatchedScope.length === 0 ? [''] : unmatchedScope,
    sweep: EMPTY_SWEEP,
    scoped: { unmatchedScope },
    findings: [],
  });
}

describe('a budget run that checked nothing does not report success', () => {
  it('refuses the measured case: a path that named no working location', () => {
    const report = reportWithUnmatched([MISSING_PATH]);

    expect(report.status).not.toBe(SUCCESS);
    expect(report.status).toBe('error');
    // The exit code the handler computes from the report — `errors > 0 ? 1 : 0`.
    expect(report.issueCounts.errors).toBeGreaterThan(0);
  });

  it('names the unchecked paths in the finding, in every format', () => {
    const report = reportWithUnmatched([MISSING_PATH, 'also/missing']);
    const finding = report.findings.find((issue) => issue.code === RUN_INTEGRITY_CODE);

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('error');
    // A refusal that does not say WHICH path sends the operator hunting.
    expect(finding?.message).toContain(MISSING_PATH);
    expect(finding?.message).toContain('also/missing');
    // Both renderings, because this lane has already shipped a defect where the
    // text and the document disagreed while each looked right alone.
    expect(renderReportText(report)).toContain(MISSING_PATH);
  });

  it('refuses a bare run over a tree with nothing to measure', () => {
    // `vat claude budget` with no arguments scopes to `['']`, and
    // `scopeSweepToPaths` files that as unmatched when the sweep is empty — so
    // "this tree has no working locations" reaches the same mechanism as a
    // mistyped directory rather than needing a second one.
    const scoped = scopeSweepToPaths(EMPTY_SWEEP, ['']);
    expect(scoped.unmatchedScope).toEqual(['']);

    const report = reportWithUnmatched(scoped.unmatchedScope);

    expect(report.status).toBe('error');
    expect(report.issueCounts.errors).toBeGreaterThan(0);
  });

  it('carries the refusal ONCE however many paths went unmatched', () => {
    // One finding naming every unchecked path, not one per path: the claim is
    // about the RUN, and a copy per argument is the per-finding duplication this
    // command's report is built to make impossible.
    const report = reportWithUnmatched(['a', 'b', 'c']);

    expect(report.findings.filter((issue) => issue.code === RUN_INTEGRITY_CODE)).toHaveLength(1);
  });

  it('still reports success when every requested path WAS checked', () => {
    // The control. A guard asserted only from the refusing side is also
    // satisfied by one that refuses every run, which would break the command.
    const report = reportWithUnmatched([]);

    expect(report.status).toBe(SUCCESS);
    expect(report.issueCounts.errors).toBe(0);
    expect(report.findings).toEqual([]);
    expect(renderReportText(report)).toContain('Every instruction chain checked is within budget.');
  });

  it('documents the exit code the refusal produces', () => {
    // The docstring-truth half: `--help` said exit 1 meant "a finding resolved to
    // error severity via config", which is now not the only way to reach it.
    let captured = '';
    const command = createBudgetCommand();
    command.configureOutput({ writeOut: (chunk) => { captured += chunk; } });
    command.outputHelp();

    expect(captured).toContain('matched no working location');
  });
});
