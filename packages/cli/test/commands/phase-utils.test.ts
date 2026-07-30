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
import { afterEach, describe, expect, it } from 'vitest';

import {
  aggregatePhaseStatus,
  exitCodeForPhases,
  phaseResultFromSpawn,
  runPhase,
  type PhaseResult,
} from '../../src/commands/phase-utils.js';
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

describe('runPhase (real subprocess)', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-phase-utils-');

  afterEach(() => cleanupTempDirs());

  /** Write a stub "vat bin" that exits with the given disposition. */
  const stubBin = (body: string): string => {
    const dir = createTempDir();
    const binPath = safePath.join(dir, 'stub-bin.js');
    writeTestFile(binPath, body);
    return binPath;
  };

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
