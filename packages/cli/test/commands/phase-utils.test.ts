/**
 * Unit tests for phase orchestration outcomes (`vat build`/`verify`/`validate`).
 *
 * The defect these pin: `runPhase` used to answer `result.status === 0 ?
 * 'passed' : 'failed'`, which collapsed FOUR distinguishable outcomes into one
 * reassuring value. A child that exited 2 (its own system error), a child killed
 * by a signal, and a spawn that never happened were all reported as an ordinary
 * validation failure — making the exit code 2 that every orchestrator's help
 * text documents unreachable, and a CI script unable to tell "the config is
 * broken" from "a link is broken".
 *
 * `runPhase` takes `binPath` as a parameter, so these tests spawn a stub "bin"
 * with a known exit disposition: a real process, a real exit code, observed.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';

import {
  aggregatePhaseStatus,
  applyPhaseSelection,
  exitCodeForPhases,
  phaseResultFromSpawn,
  runPhase,
  type PhaseResult,
} from '../../src/commands/phase-utils.js';
import { createLogger } from '../../src/utils/logger.js';
import { createTempDirTracker, writeTestFile } from '../system/test-common.js';

/** The outcome value for "the phase could not tell us what it found". */
const SYSTEM_ERROR = 'system-error';

/** A phase result with just the fields the aggregate/exit-code helpers read. */
function phase(name: string, status: PhaseResult['status']): PhaseResult {
  return { name, status };
}

describe('phaseResultFromSpawn', () => {
  it('maps exit 0 to success', () => {
    expect(phaseResultFromSpawn('resources', { status: 0, signal: null })).toEqual({
      name: 'resources',
      status: 'success',
      exitCode: 0,
    });
  });

  it('maps exit 1 to a validation error', () => {
    const result = phaseResultFromSpawn('resources', { status: 1, signal: null });

    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(1);
  });

  it('maps exit 2 to system-error, not to a validation error', () => {
    const result = phaseResultFromSpawn('resources', { status: 2, signal: null });

    expect(result.status).toBe(SYSTEM_ERROR);
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain('system-error code 2');
  });

  it('maps any other non-zero exit code to system-error', () => {
    expect(phaseResultFromSpawn('skills', { status: 7, signal: null }).status).toBe(SYSTEM_ERROR);
  });

  it('maps a signal-killed child to system-error and names the signal', () => {
    const result = phaseResultFromSpawn('skills', { status: null, signal: 'SIGKILL' });

    expect(result.status).toBe(SYSTEM_ERROR);
    expect(result.signal).toBe('SIGKILL');
    expect(result.exitCode).toBeUndefined();
  });

  it('maps a spawn that never ran to system-error', () => {
    const result = phaseResultFromSpawn('skills', {
      status: null,
      signal: null,
      error: new Error('spawn ENOENT'),
    });

    expect(result.status).toBe(SYSTEM_ERROR);
    expect(result.error).toContain('Failed to spawn phase');
  });

  it('maps no-exit-code-and-no-signal to system-error rather than success', () => {
    expect(phaseResultFromSpawn('skills', { status: null, signal: null }).status).toBe(SYSTEM_ERROR);
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

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-phase-utils-');

afterEach(() => cleanupTempDirs());

/** Write a stub "vat bin" with the given body, and return its path. */
function stubBin(body: string): string {
  const binPath = safePath.join(createTempDir(), 'stub-bin.js');
  writeTestFile(binPath, body);
  return binPath;
}

describe('runPhase (real subprocess)', () => {
  it('observes a real exit code 2 as a system error, and turns it into process exit 2', () => {
    const binPath = stubBin('process.exit(2);\n');

    const result = runPhase(binPath, { name: 'resources', args: ['resources', 'validate'] });

    expect(result.status).toBe(SYSTEM_ERROR);
    expect(result.exitCode).toBe(2);
    // The whole point: the documented exit code 2 is now reachable from an
    // orchestrator. Before the fix this was 1, indistinguishable from a
    // broken link.
    expect(exitCodeForPhases([result])).toBe(2);
  });

  it('observes a real exit code 1 as a validation error, and turns it into process exit 1', () => {
    const binPath = stubBin('process.exit(1);\n');

    const result = runPhase(binPath, { name: 'resources', args: ['resources', 'validate'] });

    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(exitCodeForPhases([result])).toBe(1);
  });

  // POSIX-only by nature, not by convenience. Windows has no signal delivery:
  // `process.kill(pid, 'SIGKILL')` there calls TerminateProcess, so the child
  // reports an ordinary exit code and `spawnSync().signal` is null. The
  // killed-by-a-signal branch this test exercises is therefore unreachable on
  // Windows — the classifier is right, the scenario cannot be produced.
  it.skipIf(process.platform === 'win32')('observes a real signal kill as a system error', () => {
    const binPath = stubBin('process.kill(process.pid, "SIGKILL");\nsetTimeout(() => {}, 5000);\n');

    const result = runPhase(binPath, { name: 'skills', args: ['skills', 'validate'] });

    expect(result.status).toBe(SYSTEM_ERROR);
    expect(result.signal).toBe('SIGKILL');
    expect(exitCodeForPhases([result])).toBe(2);
  });

  it('observes a clean exit 0 as success', () => {
    const binPath = stubBin('process.exit(0);\n');

    const result = runPhase(binPath, { name: 'skills', args: ['skills', 'validate'] });

    expect(result.status).toBe('success');
    expect(exitCodeForPhases([result])).toBe(0);
  });
});

/**
 * The child's report is DATA the parent owns, not a stream the parent forwards.
 *
 * Two defects live here, and one change fixes both:
 *
 *  1. `vat verify` was structurally blind to warnings. `vat skills validate`
 *     exits 0 while reporting `status: warning`, and the phase status was
 *     derived from the exit code — so the orchestrator answered `success` on
 *     the very tree where the child said `warning`. VAT's own CI dogfoods
 *     `vat verify`, so this blinded the project to its own warnings.
 *
 *  2. `vat validate`'s stdout was malformed YAML. With `stdio: 'inherit'` each
 *     child wrote its own document straight onto the parent's stdout with no
 *     `---` separator, so two phases produced one map with `status:` and
 *     `durationSecs:` twice over and `YAML.parse()` threw "Map keys must be
 *     unique". `vat validate | jq` had never worked.
 *
 * Capturing the child's stdout and folding the parsed document into the phase
 * result makes the parent's stdout a single document again AND gives the phase
 * status a source of truth richer than an exit code.
 */
describe('runPhase (child report capture)', () => {
  const run = (binPath: string, name = 'skills'): PhaseResult =>
    runPhase(binPath, { name, args: [name, 'validate'] });

  it('derives warning from the child\'s reported status, not from its exit code', () => {
    // Exactly what `vat skills validate` does: warnings are non-blocking, so it
    // exits 0 — the exit code cannot express "warning" and never could.
    const binPath = stubBin(
      'process.stdout.write("status: warning\\nissueCounts:\\n  errors: 0\\n  warnings: 3\\n  info: 0\\n");\nprocess.exit(0);\n',
    );

    const result = run(binPath);

    expect(result.status).toBe('warning');
    expect(result.report).toEqual({
      status: 'warning',
      issueCounts: { errors: 0, warnings: 3, info: 0 },
    });
    // A warning still does not fail the run — it is published, not fatal.
    expect(exitCodeForPhases([result])).toBe(0);
  });

  it('keeps success for a child that reports success at exit 0', () => {
    const binPath = stubBin('process.stdout.write("status: success\\n");\nprocess.exit(0);\n');

    const result = run(binPath);

    expect(result.status).toBe('success');
    expect(result.report).toEqual({ status: 'success' });
  });

  it('takes the worse of the exit code and the reported status, in both directions', () => {
    // A child that says `success` on stdout but exits 1 has contradicted
    // itself; the orchestrator must not believe the reassuring half.
    const optimistic = stubBin('process.stdout.write("status: success\\n");\nprocess.exit(1);\n');
    expect(run(optimistic).status).toBe('error');

    // And the other way round: a child reporting `system-error` while exiting 1
    // could not determine the answer, which must not be filed as "we determined
    // it is bad" — the exit code alone cannot make that distinction.
    const pessimistic = stubBin('process.stdout.write("status: system-error\\n");\nprocess.exit(1);\n');
    expect(run(pessimistic).status).toBe(SYSTEM_ERROR);
  });

  it('composes into ONE parseable parent document that keeps each child report separate', () => {
    // The concatenation defect in miniature: both children emit a `status` and a
    // `durationSecs`. Streamed onto one stdout with no separator they collapse
    // into a single map with duplicate keys and YAML.parse() throws. Folded into
    // `phases[].report` they coexist, and both values remain readable.
    const resources = stubBin('process.stdout.write("status: success\\ndurationSecs: 1.5\\n");\n');
    const skills = stubBin('process.stdout.write("status: warning\\ndurationSecs: 2.5\\n");\n');

    const phases = [run(resources, 'resources'), run(skills, 'skills')];
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

  it('captures a multi-megabyte child document without truncating it', () => {
    // The crucible's `vat skills validate` report is ~2.3 MB — well past
    // spawnSync's 1 MB default maxBuffer, which would set ENOBUFS and silently
    // hand back a truncated (and therefore unparseable) document.
    const payloadSize = 2_500_000;
    const binPath = stubBin(
      `process.stdout.write("status: success\\nblob: " + "x".repeat(${payloadSize}) + "\\n");\n`,
    );

    const result = run(binPath);

    expect(result.status).toBe('success');
    expect((result.report as { blob: string } | undefined)?.blob).toHaveLength(payloadSize);
  });

  it('degrades a child whose stdout is not YAML to a system error instead of throwing', () => {
    const binPath = stubBin('process.stdout.write("[unclosed\\n");\nprocess.exit(0);\n');

    const result = run(binPath);

    expect(result.status).toBe(SYSTEM_ERROR);
    expect(result.error).toContain('unparseable');
    expect(exitCodeForPhases([result])).toBe(2);
  });

  it('falls back to the exit code when the child prints no document at all', () => {
    // `vat skills validate` exits 0 with an empty stdout when there is no
    // skills: block. Silence is not a crash — do not invent a system error.
    const binPath = stubBin('process.exit(0);\n');

    const result = run(binPath);

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
    const phases = [{ name: 'skills', args: ['skills', 'validate'] }];

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
