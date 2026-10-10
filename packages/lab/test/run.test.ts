/**
 * The run harness's job is to say what happened, and the expensive way to get it
 * wrong is to say something plausible instead.
 *
 * These tests pin the distinctions a caller cannot recover once they are lost:
 * a command that NEVER RAN versus one that exited 0, a non-zero exit versus a
 * spawn failure, and an environment that was merged versus one that was
 * replaced. The last is the reason the env test reads back a variable it did NOT
 * set: a test that only checks its own variable passes just as happily against
 * an implementation that wiped `process.env`, so it cannot detect the bug it
 * exists to guard.
 *
 * No real vat binary is spawned — `node -e <script>` is a fast, hermetic stand-in
 * that exercises `leadingArgs` concatenation on the way through.
 */

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_ARM_ENVIRONMENT } from '../src/harness/arm-env.js';
import { runCommand } from '../src/harness/run.js';
import type { ResolvedInstrument, RunOptions, RunResult } from '../src/harness/types.js';

import { cleanupProbes, PROBE_ECHO_ENV, PROBE_VERSION, setupProbe } from './command-probe.js';

/** Axis C is irrelevant to these tests; every instrument below shares one. */
const VERSION = PROBE_VERSION;

/** A stand-in instrument: `node -e`, with the script arriving as the command's args. */
const NODE_EVAL: ResolvedInstrument = {
  command: process.execPath,
  leadingArgs: ['-e'],
  version: VERSION,
};

/**
 * Run an inline node script through the harness.
 *
 * @param script - JavaScript handed to `node -e`
 * @param extra - Env and timeout, when a test varies them
 * @returns The harness's result
 */
function runScript(
  script: string,
  extra: Omit<RunOptions, 'cwd'> = { env: EMPTY_ARM_ENVIRONMENT },
): RunResult {
  return runCommand(NODE_EVAL, [script], { cwd: process.cwd(), ...extra });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupProbes();
});

describe('runCommand', () => {
  it('reports a successful run: exit 0, its stdout, and a real duration', () => {
    const result = runScript("process.stdout.write('measured')");

    expect(result.exitCode).toBe(0);
    expect(result.spawnError).toBeNull();
    expect(result.stdout).toBe('measured');
    expect(Number.isFinite(result.wallMs)).toBe(true);
    expect(result.wallMs).toBeGreaterThan(0);
  });

  it('reports a non-zero exit as that exit code, not as a spawn error', () => {
    const result = runScript("process.stderr.write('boom'); process.exit(3);");

    expect(result.exitCode).toBe(3);
    expect(result.spawnError).toBeNull();
    expect(result.stderr).toBe('boom');
  });

  it('distinguishes a command that NEVER RAN from one that exited 0', () => {
    // ABSOLUTE path on purpose, and it must stay one. The harness resolves via
    // utils' `isPathLike(command) ? command : which.sync(command)`, so a path
    // bypasses `which` entirely and reaches `spawnSync`, which reports a real
    // ENOENT — identically on every platform. A BARE nonexistent name takes the
    // other branch (covered by the next test), and on Windows a bare name that
    // cmd.exe were left to resolve would come back as exit code 9009 rather than
    // a spawn failure, silently inverting this control.
    const missing = safePath.join(normalizedTmpdir(), 'vat-lab-no-such-binary-9f31c7');
    const neverRan = runCommand({ command: missing, leadingArgs: [], version: VERSION }, [], {
      cwd: process.cwd(),
      env: EMPTY_ARM_ENVIRONMENT,
    });

    expect(neverRan.exitCode).toBeNull();
    expect(neverRan.spawnError).not.toBeNull();
    expect(neverRan.spawnError).toContain('ENOENT');
    // Even a run that never happened reports a real, non-negative duration —
    // the perf facet's statistics assume that of every sample it is handed.
    expect(Number.isFinite(neverRan.wallMs)).toBe(true);
    expect(neverRan.wallMs).toBeGreaterThanOrEqual(0);

    // The control that makes the assertion above mean something: a run that DID
    // happen reports a number here, so `null` cannot be read as a clean exit.
    expect(runScript('process.exit(0)').exitCode).toBe(0);
  });

  it('reports a bare command that is not on PATH as a spawn failure', () => {
    const unresolvable = runCommand(
      { command: 'vat-lab-no-such-command-9f31c7', leadingArgs: [], version: VERSION },
      [],
      { cwd: process.cwd(), env: EMPTY_ARM_ENVIRONMENT },
    );

    expect(unresolvable.exitCode).toBeNull();
    expect(unresolvable.spawnError).toContain('could not resolve command');
  });

  it('MERGES env over process.env rather than replacing it', () => {
    // Guard first: if the parent had no PATH, the inherited-value assertion below
    // would compare undefined to undefined and pass against any implementation.
    expect(process.env.PATH).toBeTruthy();

    const result = runScript(
      'process.stdout.write(JSON.stringify({' +
        ' mine: process.env.LAB_ENV_PROBE ?? null,' +
        ' inherited: process.env.PATH ?? null }))',
      { env: { set: { LAB_ENV_PROBE: 'probe-value' }, unset: [] } },
    );

    expect(result.exitCode).toBe(0);
    const seen = JSON.parse(result.stdout) as { mine: string | null; inherited: string | null };
    expect(seen.mine).toBe('probe-value');
    // Not merely "present": the parent's own value, so a rebuilt PATH would fail.
    expect(seen.inherited).toBe(process.env.PATH);
  });

  it('passes the arm environment to the child and nothing arm-owned it did not set', () => {
    // The parent's shell exported a VAT_BIN — the leak this contract exists to
    // stop. It must not reach the child, while the arm's own variable must.
    vi.stubEnv('VAT_BIN', '/leak');
    const probe = setupProbe('lab-run-env-');

    const result = runCommand(probe.instrument, [], {
      cwd: probe.cwd,
      env: { set: { LAB_X: 'x', [PROBE_ECHO_ENV]: 'VAT_BIN,LAB_X' }, unset: [] },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toStrictEqual({ VAT_BIN: null, LAB_X: 'x' });
  });

  it('reports a timeout kill as a spawn error with no exit code', () => {
    const result = runScript('setTimeout(function () {}, 30000);', {
      env: EMPTY_ARM_ENVIRONMENT,
      timeoutMs: 200,
    });

    expect(result.exitCode).toBeNull();
    expect(result.spawnError).not.toBeNull();
  });
});
