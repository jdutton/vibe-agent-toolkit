/**
 * `capturePerf` is where a failed run is kept away from a statistic, and that is
 * the only reason this suite exists.
 *
 * The rule is counter-intuitive enough to be worth restating: **failures are
 * fast**. A command that cannot resolve its config returns in a fraction of a
 * millisecond, so admitting a failed repeat into a median does not make the
 * report noisy — it makes it *optimistic*. A regression that broke a command
 * outright would read as the largest speed-up the tool has ever measured. Every
 * assertion below is downstream of that.
 *
 * Three properties, each with a fixture that can tell the two answers apart:
 *
 * 1. **A failed run contributes no timing**, and **any** failure poisons the
 *    whole row — a set of repeats where some worked and some did not is not
 *    timing one behaviour. The row then carries `failed: true`, no samples, and
 *    a `null` exit code, because there is no single code to report.
 * 2. **The count in the failure string is real.** The load-bearing case fails
 *    exactly ONE of three repeats, so `1 of 3` and `3 of 3` are different
 *    strings; a fixture that failed every repeat would let a mutant which
 *    dropped the arithmetic entirely still look right. `runRepeats` is driven
 *    directly once, as a control, to prove the fixture does what it claims.
 * 3. **Rows are independent.** A failing command sits BETWEEN two passing ones,
 *    so a failure leaking either forward or backward is visible.
 * 4. **"Failed" means did not COMPLETE, not "exited non-zero".** A vat validator
 *    exits 1 whenever the project has findings — which is every real project —
 *    having done all of its work, and a command may declare that code completed.
 *    The pair of cases below runs byte-identical repeats under two specs that
 *    differ only in what they accept, so the fixture can tell the two answers
 *    apart. Exit 2 stays unacceptable to any spec, and repeats that completed
 *    with DIFFERENT accepted codes are a failed row: both ran, neither ran the
 *    same amount of work.
 *
 * No vat binary is spawned and no git is consulted: the instrument is the shared
 * probe from `command-probe.ts`, and the subject is a literal pointing at the
 * probe's own temp directory.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { REPORT_FORMAT_VERSION, type ReportEnvelope } from '../src/envelope/envelope.js';
import { capturePerf, type CapturePerfOptions } from '../src/facets/perf/capture.js';
import {
  PERF_FACET,
  PERF_FACET_VERSION,
  type PerfBody,
  type PerfCommandStats,
  PerfBodySchema,
} from '../src/facets/perf/types.js';
import type { MeasuredCommandSpec } from '../src/harness/commands.js';
import { runRepeats } from '../src/harness/repeat.js';
import type { ResolvedSubject } from '../src/harness/types.js';

import { cleanupProbes, PROBE_DEFAULT_STDERR, PROBE_EXIT_CODE_ENV, PROBE_FAIL_AT_ENV, PROBE_FAIL_EXIT, PROBE_FAIL_TOKEN, PROBE_STDERR_ENV, PROBE_VERSION, probeSpec, setupProbe, type Probe } from './command-probe.js';

afterAll(cleanupProbes);

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-perf-capture-';

/** The caller owns the clock, so this exact string must come back in the report. */
const CAPTURED_AT = '2026-08-09T12:34:56.000Z';

/** A command that always succeeds. */
const PASSES: MeasuredCommandSpec = { name: 'audit', args: ['audit'] };

/** A command that always fails, on every repeat, by argv. */
const FAILS: MeasuredCommandSpec = { name: 'broken', args: [PROBE_FAIL_TOKEN] };

/**
 * The same always-non-zero command, declared to COMPLETE at 1 as well as 0.
 *
 * The one deliberate difference from {@link FAILS}: same name, same arguments,
 * same probe behaviour. Pairing them is what makes the exit-code acceptance
 * falsifiable — with one spec the row is a measurement and with the other it is
 * a poisoned row, over byte-identical repeats.
 */
const FINDINGS: MeasuredCommandSpec = {
  name: 'broken',
  args: [PROBE_FAIL_TOKEN],
  completedExitCodes: [0, 1],
};

/**
 * A command that succeeds by argv but accepts a findings exit.
 *
 * Paired with {@link PROBE_FAIL_AT_ENV}, this is the only way to fixture repeats
 * that ALL completed and still disagreed: the token-driven failure applies to
 * every repeat of a command, which is uniform by construction.
 */
const PASSES_WITH_FINDINGS: MeasuredCommandSpec = {
  name: 'audit',
  args: ['audit'],
  completedExitCodes: [0, 1],
};

/** Makes the probe's non-zero exit vat's findings code rather than a crash code. */
const EXITS_ONE = { [PROBE_EXIT_CODE_ENV]: '1' };

/** The whole failure suffix a `boom` command produces, at the default stderr. */
const FAIL_REASON = `exited ${String(PROBE_FAIL_EXIT)}: ${PROBE_DEFAULT_STDERR}`;

/**
 * A subject literal pointing at the probe's directory.
 *
 * Constructed rather than resolved: `resolveSubject` runs git, and this suite is
 * about arithmetic over repeats, not about how axis B is discovered.
 *
 * @param path - The probe's working directory
 * @returns A snapshot-kind subject at that path
 */
function subjectAt(path: string): ResolvedSubject {
  return {
    path,
    ref: { id: 'probe-subject', source: path },
    version: { kind: 'snapshot', fingerprint: 'f'.repeat(16), fileCount: 1 },
  };
}

/**
 * Capture against a probe, defaulting everything a case does not vary.
 *
 * @param probe - Supplies the instrument and the subject path
 * @param overrides - What the case varies
 * @returns The complete report envelope
 */
function capture(
  probe: Probe,
  overrides: Partial<CapturePerfOptions> = {},
): ReportEnvelope<PerfBody> {
  return capturePerf({
    instrument: probe.instrument,
    subject: subjectAt(probe.cwd),
    commands: [PASSES],
    runs: 3,
    cache: 'warm',
    capturedAt: CAPTURED_AT,
    ...overrides,
  });
}

/**
 * The single row of a one-command capture.
 *
 * @param report - A report captured with exactly one command
 * @returns That command's row
 * @throws When the capture produced no row at all, which is never the contract
 */
function onlyRow(report: ReportEnvelope<PerfBody>): PerfCommandStats {
  const row = report.body.commands[0];
  if (row === undefined) throw new Error('capture produced no command rows');
  return row;
}

describe('capturePerf — a clean measurement', () => {
  it('keeps every repeat and reports statistics consistent with the samples', () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(capture(probe, { runs: 3 }));

    expect(row.failed).toBe(false);
    expect(row.failure).toBeNull();
    expect(row.exitCode).toBe(0);
    expect(row.runs).toBe(3);
    expect(row.samplesMs).toHaveLength(3);
    expect(probe.entries()).toHaveLength(3);

    // Checked against the samples the row itself published, not against a second
    // call to `summarize` — that would only prove the function agrees with
    // itself. For three samples the median IS the middle order statistic.
    const ascending = [...row.samplesMs].sort((a, b) => a - b);
    expect([row.minMs, row.medianMs, row.maxMs]).toEqual(ascending);
    expect(row.iqrMs).toBeGreaterThanOrEqual(0);
    expect(row.iqrMs).toBeLessThanOrEqual(row.maxMs - row.minMs);
  });

  it('echoes the requested name, arguments and cache mode into the row', () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(capture(probe, { runs: 1, cache: 'cold' }));

    expect(row.name).toBe(PASSES.name);
    expect(row.args).toEqual(PASSES.args);
    expect(row.cache).toBe('cold');
  });
});

describe('capturePerf — a failed repeat is never timed', () => {
  it('CONTROL: the fixture fails exactly the chosen repeat and no other', () => {
    // Without this, "1 of 3 repeats failed" could be produced by a fixture that
    // failed all three and a mutant that lost count — the two would be
    // indistinguishable. Driving `runRepeats` directly reads the exit codes the
    // facet is about to be handed.
    const probe = setupProbe(PREFIX);

    const results = runRepeats(
      probeSpec(probe, { runs: 3, env: { [PROBE_FAIL_AT_ENV]: '1' } }),
    );

    expect(results.map((run) => run.exitCode)).toEqual([0, PROBE_FAIL_EXIT, 0]);
  });

  it('poisons the WHOLE row when one repeat of three failed', () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(capture(probe, { runs: 3, env: { [PROBE_FAIL_AT_ENV]: '1' } }));

    // Two repeats produced perfectly good timings. Reporting their median would
    // answer a different question than the one asked — and, because the failure
    // was the fast one, would answer it optimistically.
    expect(row.failed).toBe(true);
    expect(row.samplesMs).toEqual([]);
    expect(row.exitCode).toBeNull();
    expect(row.runs).toBe(3);
    expect(row.failure).toBe(`1 of 3 repeats failed — ${FAIL_REASON}`);

    // Zeros, not absent: an empty measurement must never look like a fast one,
    // which is why `failed` and `samplesMs` above carry the meaning instead.
    expect([row.medianMs, row.minMs, row.maxMs, row.iqrMs]).toEqual([0, 0, 0, 0]);
    expect(probe.entries()).toHaveLength(3);
  });

  it('counts every failure when they all failed', () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(capture(probe, { runs: 2, commands: [FAILS] }));

    expect(row.failed).toBe(true);
    expect(row.runs).toBe(2);
    expect(row.failure).toBe(`2 of 2 repeats failed — ${FAIL_REASON}`);
  });

  it('caps the stderr excerpt so one loud failure cannot swamp the report', () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(
      capture(probe, {
        runs: 1,
        commands: [FAILS],
        env: { [PROBE_STDERR_ENV]: 'x'.repeat(500) },
      }),
    );

    expect(row.failure).toBe(
      `1 of 1 repeats failed — exited ${String(PROBE_FAIL_EXIT)}: ${'x'.repeat(200)}`,
    );
  });
});

describe('capturePerf — a findings exit is a completed run', () => {
  it('CONTROL: the fixture really does exit 1 on every repeat, not 0 and not 3', () => {
    // Without this the measurable row below could be produced by a probe that
    // quietly exited 0, and "the spec accepted 1" would be untested.
    const probe = setupProbe(PREFIX);

    const results = runRepeats(
      probeSpec(probe, { args: [PROBE_FAIL_TOKEN], runs: 3, env: EXITS_ONE }),
    );

    expect(results.map((run) => run.exitCode)).toEqual([1, 1, 1]);
  });

  it('measures a command whose every repeat exited 1, when 1 means completed', () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(capture(probe, { runs: 3, commands: [FINDINGS], env: EXITS_ONE }));

    expect(row.failed).toBe(false);
    expect(row.failure).toBeNull();
    expect(row.samplesMs).toHaveLength(3);
    // The observed code, not a hard-coded 0: two rows with the same median but
    // different codes are not the same measurement.
    expect(row.exitCode).toBe(1);
  });

  it('poisons the identical repeats when the command did NOT declare 1 completed', () => {
    // Same probe, same argv, same exit code — only the spec differs. This is the
    // shipped behaviour, pinned so the change cannot widen past what it declared.
    const probe = setupProbe(PREFIX);

    const row = onlyRow(capture(probe, { runs: 3, commands: [FAILS], env: EXITS_ONE }));

    expect(row.failed).toBe(true);
    expect(row.exitCode).toBeNull();
    expect(row.samplesMs).toEqual([]);
    expect(row.failure).toBe(`3 of 3 repeats failed — exited 1: ${PROBE_DEFAULT_STDERR}`);
  });

  it('refuses exit 2 even for a command that accepts a findings exit', () => {
    // vat's 2 is "system error" — a run that did not complete, whose duration is
    // the duration of giving up. No spec may opt into timing that.
    const probe = setupProbe(PREFIX);

    const row = onlyRow(
      capture(probe, {
        runs: 2,
        commands: [FINDINGS],
        env: { [PROBE_EXIT_CODE_ENV]: '2' },
      }),
    );

    expect(row.failed).toBe(true);
    expect(row.exitCode).toBeNull();
    expect(row.failure).toBe(`2 of 2 repeats failed — exited 2: ${PROBE_DEFAULT_STDERR}`);
  });
});

describe('capturePerf — repeats that completed differently', () => {
  it('CONTROL: the fixture makes repeat 1 exit 1 while the others exit 0', () => {
    const probe = setupProbe(PREFIX);

    const results = runRepeats(
      probeSpec(probe, { runs: 3, env: { ...EXITS_ONE, [PROBE_FAIL_AT_ENV]: '1' } }),
    );

    // The repeats genuinely differ. A fixture where all three exited alike could
    // not tell "uniformity is checked" from "uniformity is ignored".
    expect(results.map((run) => run.exitCode)).toEqual([0, 1, 0]);
  });

  it('fails the row when accepted codes disagree, naming both codes', () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(
      capture(probe, {
        runs: 3,
        commands: [PASSES_WITH_FINDINGS],
        env: { ...EXITS_ONE, [PROBE_FAIL_AT_ENV]: '1' },
      }),
    );

    expect(row.failed).toBe(true);
    expect(row.exitCode).toBeNull();
    expect(row.samplesMs).toEqual([]);
    expect(row.failure).toContain('exited 0 and 1');
    expect(row.failure).toContain('not with the same amount of work done');
  });
});

describe('capturePerf — no repeats at all', () => {
  it('marks the row failed rather than reporting a zero-millisecond command', () => {
    const probe = setupProbe(PREFIX);

    // Cold on purpose: a cache clear hoisted out of the repeat loop would still
    // spawn a child here, where nothing at all should run.
    const row = onlyRow(capture(probe, { runs: 0, cache: 'cold' }));

    expect(row.runs).toBe(0);
    expect(row.failed).toBe(true);
    expect(row.failure).toBe('no repeats were requested');
    expect(row.exitCode).toBeNull();
    expect(row.samplesMs).toEqual([]);
    expect(row.medianMs).toBe(0);
    expect(probe.entries()).toEqual([]);
  });
});

describe('capturePerf — rows are independent', () => {
  it('keeps a failing command from poisoning the commands either side of it', () => {
    const probe = setupProbe(PREFIX);
    const before: MeasuredCommandSpec = { name: 'before', args: ['audit'] };
    const after: MeasuredCommandSpec = { name: 'after', args: ['audit', '--json'] };

    const report = capture(probe, { runs: 2, commands: [before, FAILS, after] });

    // The failing command sits in the middle, so an accumulator that leaked
    // failures forward and one that leaked them backward both show up here.
    expect(report.body.commands.map((row) => [row.name, row.failed])).toEqual([
      ['before', false],
      ['broken', true],
      ['after', false],
    ]);
    expect(report.body.commands.map((row) => row.samplesMs.length)).toEqual([2, 0, 2]);
    expect(report.body.commands.map((row) => row.exitCode)).toEqual([0, null, 0]);
  });
});

describe('capturePerf — the envelope', () => {
  it('names the facet and stamps all three coordinate axes', () => {
    const probe = setupProbe(PREFIX);
    const subject = subjectAt(probe.cwd);

    const report = capture(probe, { runs: 1 });

    expect(report.formatVersion).toBe(REPORT_FORMAT_VERSION);
    expect(report.facet).toBe(PERF_FACET);
    expect(report.facetVersion).toBe(PERF_FACET_VERSION);
    expect(report.coordinate).toEqual({
      subject: subject.ref,
      subjectVersion: subject.version,
      instrument: PROBE_VERSION,
    });
  });

  it('echoes the caller-supplied capture time rather than reading a clock', () => {
    const probe = setupProbe(PREFIX);

    expect(capture(probe, { runs: 1 }).capturedAt).toBe(CAPTURED_AT);
  });

  it('produces a body that validates against the facet schema, failures included', () => {
    const probe = setupProbe(PREFIX);

    const report = capture(probe, { runs: 2, commands: [PASSES, FAILS] });

    // Reported through the assertion rather than as a bare boolean: a strict
    // schema rejecting one field should say which one.
    const parsed = PerfBodySchema.safeParse(report.body);
    expect(parsed.success ? null : parsed.error.message).toBeNull();
    expect(report.body.load.cpus).toBeGreaterThanOrEqual(1);
  });
});
