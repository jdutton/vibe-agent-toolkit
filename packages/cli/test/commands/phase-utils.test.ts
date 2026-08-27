/**
 * Unit tests for phase orchestration outcomes (`vat build`/`verify`/`validate`).
 *
 * The defect these pin: `runPhase` used to answer `result.status === 0 ?
 * 'passed' : 'failed'`, which collapsed distinguishable outcomes into one
 * reassuring value. A phase that reported its own system error was recorded as
 * an ordinary validation failure — making the exit code 2 that every
 * orchestrator's help text documents unreachable, and a CI script unable to tell
 * "the config is broken" from "a link is broken".
 *
 * Phases used to be child processes and these tests used to spawn a stub "bin"
 * per case. They no longer are, so a phase is now just a function returning
 * `{ document, exitCode }` — which is both what the orchestrator reads and what
 * a test can state directly, with no process, no serialization and no stub.
 */

import { describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';

import {
  aggregatePhaseIssueCounts,
  aggregatePhaseStatus,
  applyPhaseSelection,
  exitCodeForPhases,
  phaseResultFromOutcome,
  runPhase,
  type PhaseOutcome,
  type PhaseResult,
} from '../../src/commands/phase-utils.js';
import { createLogger } from '../../src/utils/logger.js';

/** The outcome value for "the phase could not tell us what it found". */
const SYSTEM_ERROR = 'system-error';

/** A phase result with just the fields the aggregate/exit-code helpers read. */
function phase(name: string, status: PhaseResult['status']): PhaseResult {
  return { name, status };
}

/** A phase whose run resolves to the given outcome. */
const phaseReturning = (name: string, outcome: PhaseOutcome) => ({
  name,
  run: () => Promise.resolve(outcome),
});

describe('phaseResultFromOutcome', () => {
  it('maps exit 0 to success', () => {
    expect(phaseResultFromOutcome('resources', { document: undefined, exitCode: 0 })).toEqual({
      name: 'resources',
      status: 'success',
      exitCode: 0,
    });
  });

  it('maps exit 1 to a validation error', () => {
    const result = phaseResultFromOutcome('resources', { document: undefined, exitCode: 1 });

    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(1);
  });

  it('maps exit 2 to system-error, not to a validation error', () => {
    const result = phaseResultFromOutcome('resources', { document: undefined, exitCode: 2 });

    expect(result.status).toBe(SYSTEM_ERROR);
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain('system-error code 2');
  });

  it('maps any other non-zero exit code to system-error', () => {
    expect(
      phaseResultFromOutcome('skills', { document: undefined, exitCode: 7 }).status,
    ).toBe(SYSTEM_ERROR);
  });
});

describe('aggregatePhaseStatus', () => {
  it('is success for no phases and for all-success phases', () => {
    expect(aggregatePhaseStatus([])).toBe('success');
    expect(aggregatePhaseStatus([phase('a', 'success'), phase('b', 'success')])).toBe('success');
  });

  it('reports warning when a phase warned but none failed', () => {
    expect(aggregatePhaseStatus([phase('a', 'success'), phase('b', 'warning')])).toBe('warning');
  });

  it('ranks system-error above error — could-not-determine is not a verdict', () => {
    expect(aggregatePhaseStatus([phase('a', 'error'), phase('b', SYSTEM_ERROR)])).toBe(SYSTEM_ERROR);
    expect(aggregatePhaseStatus([phase('a', SYSTEM_ERROR), phase('b', 'error')])).toBe(SYSTEM_ERROR);
  });
});

describe('aggregatePhaseIssueCounts', () => {
  /** A subprocess phase: its findings live in the child's document, not on the row. */
  const child = (name: string, counts: unknown): PhaseResult => ({
    name,
    status: 'warning',
    exitCode: 0,
    report: { issueCounts: counts },
  });

  it('reads a SUBPROCESS phase’s counts out of the child report', () => {
    // The defect, measured on a real adopter: `vat build --only claude` published
    // a top-level `issueCounts: {0, 0, 0}` over a nested phase reporting 12
    // warnings, because the parent read only `PhaseResult.issueCounts` — which a
    // subprocess phase deliberately never sets.
    expect(aggregatePhaseIssueCounts([child('claude', { errors: 0, warnings: 12, info: 3 })]))
      .toEqual({ errors: 0, warnings: 12, info: 3 });
  });

  it('sums across phases and across both storage shapes', () => {
    const inProcess: PhaseResult = {
      name: 'consistency',
      status: 'error',
      issueCounts: { errors: 2, warnings: 0, info: 0 },
    };
    expect(aggregatePhaseIssueCounts([child('skills', { errors: 1, warnings: 5, info: 0 }), inProcess]))
      .toEqual({ errors: 3, warnings: 5, info: 0 });
  });

  it('prefers the row’s own counts when a phase carries both', () => {
    const both: PhaseResult = {
      name: 'skills',
      status: 'warning',
      issueCounts: { errors: 0, warnings: 1, info: 0 },
      report: { issueCounts: { errors: 99, warnings: 99, info: 99 } },
    };
    expect(aggregatePhaseIssueCounts([both])).toEqual({ errors: 0, warnings: 1, info: 0 });
  });

  it('treats absent, malformed and non-numeric counts as zero rather than throwing', () => {
    // A phase that published no distribution must contribute nothing — the same
    // answer as before this aggregation existed. Throwing here would turn a
    // report-shape surprise into a failed build.
    expect(aggregatePhaseIssueCounts([])).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect(
      aggregatePhaseIssueCounts([
        { name: 'a', status: 'success' },
        child('b', undefined),
        child('c', 'not-an-object'),
        child('d', { errors: '4', warnings: null, info: 2 }),
      ]),
    ).toEqual({ errors: 0, warnings: 0, info: 2 });
  });
});

describe('exitCodeForPhases', () => {
  it('exits 0 for success and for warnings (a warning does not fail a run)', () => {
    expect(exitCodeForPhases([phase('a', 'success')])).toBe(0);
    expect(exitCodeForPhases([phase('a', 'warning')])).toBe(0);
  });

  it('exits 1 for a validation error', () => {
    expect(exitCodeForPhases([phase('a', 'success'), phase('b', 'error')])).toBe(1);
  });

  it('exits 2 when any phase could not run, even alongside a validation error', () => {
    expect(exitCodeForPhases([phase('a', 'error'), phase('b', SYSTEM_ERROR)])).toBe(2);
  });
});

describe('runPhase', () => {
  it('turns a phase that reports exit 2 into process exit 2', async () => {
    const result = await runPhase(
      phaseReturning('resources', { document: undefined, exitCode: 2 }),
    );

    expect(result.status).toBe(SYSTEM_ERROR);
    expect(result.exitCode).toBe(2);
    // The whole point: the documented exit code 2 is reachable from an
    // orchestrator. Before the fix this was 1, indistinguishable from a
    // broken link.
    expect(exitCodeForPhases([result])).toBe(2);
  });

  it('turns a phase that reports exit 1 into process exit 1', async () => {
    const result = await runPhase(
      phaseReturning('resources', { document: undefined, exitCode: 1 }),
    );

    expect(result.status).toBe('error');
    expect(exitCodeForPhases([result])).toBe(1);
  });

  it('observes a clean exit 0 as success', async () => {
    const result = await runPhase(phaseReturning('skills', { document: undefined, exitCode: 0 }));

    expect(result.status).toBe('success');
    expect(exitCodeForPhases([result])).toBe(0);
  });

  /**
   * The backstop, and the reason this whole conversion needed one.
   *
   * A phase reports its own failures through `reportCommandError` and returns
   * them. A throw that escapes THAT is a bug — and in a child process it was a
   * survivable one, because the blast radius was the child. In this process an
   * uncaught throw would abort the orchestrator's loop, silently skipping every
   * later phase and every aggregation, and the run would end having done half
   * the work with nothing in the document to say so.
   */
  it('contains a phase that throws past its own error handling, rather than aborting the run', async () => {
    const exploding = {
      name: 'skills',
      run: () => Promise.reject(new Error('registry blew up')),
    };

    const result = await runPhase(exploding);

    expect(result.status).toBe(SYSTEM_ERROR);
    expect(result.error).toContain('registry blew up');
    expect(exitCodeForPhases([result])).toBe(2);
  });

  it('keeps running later phases after one throws', async () => {
    const phases = [
      { name: 'a', run: () => Promise.reject(new Error('boom')) },
      phaseReturning('b', { document: { status: 'success' }, exitCode: 0 }),
    ];

    const results: PhaseResult[] = [];
    for (const p of phases) results.push(await runPhase(p));

    expect(results.map((r) => r.name)).toEqual(['a', 'b']);
    expect(results[1]?.status).toBe('success');
    expect(aggregatePhaseStatus(results)).toBe(SYSTEM_ERROR);
  });
});

/**
 * A phase's report is DATA the orchestrator owns, not a stream it forwards.
 *
 * Two defects live here, and one change fixed both:
 *
 *  1. `vat verify` was structurally blind to warnings. `vat skills validate`
 *     exits 0 while reporting `status: warning`, and the phase status was
 *     derived from the exit code — so the orchestrator answered `success` on
 *     the very tree where the phase said `warning`. VAT's own CI dogfoods
 *     `vat verify`, so this blinded the project to its own warnings.
 *
 *  2. `vat validate`'s stdout was malformed YAML. With `stdio: 'inherit'` each
 *     child wrote its own document straight onto the parent's stdout with no
 *     `---` separator, so two phases produced one map with `status:` and
 *     `durationSecs:` twice over and `YAML.parse()` threw "Map keys must be
 *     unique". `vat validate | jq` had never worked.
 *
 * Folding each phase's document into its own result keeps the orchestrator's
 * stdout a single document AND gives the phase status a source of truth richer
 * than an exit code. The document now arrives as a VALUE rather than as parsed
 * stdout, which is why the truncation and unparseable-output cases below are
 * gone: there is no serialization step left in which to lose one.
 */
describe('runPhase (report folding)', () => {
  it('derives warning from the phase\'s reported status, not from its exit code', async () => {
    // Exactly what `vat skills validate` does: warnings are non-blocking, so it
    // reports exit 0 — the exit code cannot express "warning" and never could.
    const document = { status: 'warning', issueCounts: { errors: 0, warnings: 3, info: 0 } };

    const result = await runPhase(phaseReturning('skills', { document, exitCode: 0 }));

    expect(result.status).toBe('warning');
    expect(result.report).toEqual(document);
    // A warning still does not fail the run — it is published, not fatal.
    expect(exitCodeForPhases([result])).toBe(0);
  });

  it('takes the worse of the exit code and the reported status, in both directions', async () => {
    // A phase that says `success` but reports exit 1 has contradicted itself;
    // the orchestrator must not believe the reassuring half.
    const optimistic = await runPhase(
      phaseReturning('skills', { document: { status: 'success' }, exitCode: 1 }),
    );
    expect(optimistic.status).toBe('error');

    // And the other way round: a phase reporting `system-error` while exiting 1
    // could not determine the answer, which must not be filed as "we determined
    // it is bad" — the exit code alone cannot make that distinction.
    const pessimistic = await runPhase(
      phaseReturning('skills', { document: { status: 'system-error' }, exitCode: 1 }),
    );
    expect(pessimistic.status).toBe(SYSTEM_ERROR);
  });

  it('composes into ONE parseable document that keeps each phase report separate', async () => {
    // The concatenation defect in miniature: both phases emit a `status` and a
    // `durationSecs`. Streamed onto one stdout with no separator they collapse
    // into a single map with duplicate keys and YAML.parse() throws. Folded into
    // `phases[].report` they coexist, and both values remain readable.
    const phases = [
      await runPhase(
        phaseReturning('resources', {
          document: { status: 'success', durationSecs: 1.5 },
          exitCode: 0,
        }),
      ),
      await runPhase(
        phaseReturning('skills', {
          document: { status: 'warning', durationSecs: 2.5 },
          exitCode: 0,
        }),
      ),
    ];

    const stdout = `---\n${YAML.stringify({
      status: aggregatePhaseStatus(phases),
      phases,
      duration: '10ms',
    })}`;

    const parsed = YAML.parse(stdout) as {
      status: string;
      phases: Array<{ name: string; report?: { status: string; durationSecs: number } }>;
    };

    expect(parsed.status).toBe('warning');
    expect(parsed.phases[0]?.report).toEqual({ status: 'success', durationSecs: 1.5 });
    expect(parsed.phases[1]?.report).toEqual({ status: 'warning', durationSecs: 2.5 });
  });

  it('falls back to the exit code when the phase publishes no document at all', async () => {
    // `vat skills validate` returns no document when there is no skills: block.
    // Silence is not a crash — do not invent a system error.
    const result = await runPhase(phaseReturning('skills', { document: undefined, exitCode: 0 }));

    expect(result.status).toBe('success');
    expect(result.report).toBeUndefined();
  });
});

/**
 * An unroutable `--only` used to be an uncaught `throw` from OUTSIDE the
 * command's try block. The user got a raw Node stack trace, **zero bytes of
 * stdout**, and an exit 1 that looked exactly like "validation errors" — so the
 * one output a scripted caller parses was never written at all.
 */
/** Run `applyPhaseSelection`, capturing stdout and intercepting the exit. */
function captureSelectionOutput(selection: Parameters<typeof applyPhaseSelection>[0]): {
  stdout: string;
  exitCode: number | undefined;
} {
  const chunks: string[] = [];
  let exitCode: number | undefined;
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('process.exit');
  }) as never);

  try {
    applyPhaseSelection(selection, createLogger({}), Date.now());
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  } finally {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stdout: chunks.join(''), exitCode };
}

describe('applyPhaseSelection', () => {
  it('writes the normal structured document — not a stack trace — for an unroutable --only', () => {
    const { stdout, exitCode } = captureSelectionOutput({ kind: 'fail', message: "Phase 'claude' is not configured" });

    expect(exitCode).toBe(1);
    expect(YAML.parse(stdout)).toMatchObject({
      status: 'error',
      phases: [],
      error: "Phase 'claude' is not configured",
    });
  });

  it('writes a warned no-op document at exit 0 when nothing is configured', () => {
    const { stdout, exitCode } = captureSelectionOutput({ kind: 'noop', warning: 'check your config', note: 'nothing configured' });

    expect(exitCode).toBe(0);
    expect(YAML.parse(stdout)).toMatchObject({ status: 'success', note: 'nothing configured' });
  });

  it('returns the phases untouched and writes nothing when there is work to do', () => {
    const phases = [phaseReturning('skills', { document: undefined, exitCode: 0 })];

    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    const returned = applyPhaseSelection({ kind: 'run', phases }, createLogger({}), Date.now());
    stdoutSpy.mockRestore();

    expect(returned).toBe(phases);
    expect(chunks).toEqual([]);
  });
});
