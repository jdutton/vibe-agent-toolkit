/**
 * Running a real child process through `runOutcome`.
 *
 * Integration-tier because it spawns: `document-shape.test.ts` and
 * `verdict-extract.test.ts` cover the pure reading logic against canned
 * strings, while this file is the one place that proves a vat exit code
 * survives an ACTUAL `spawnSync` round trip without being reinterpreted as a
 * pass/fail verdict, and that a genuinely unresolvable command comes back
 * `not-run` rather than throwing.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { runOutcome } from '../../src/harness/outcome.js';
import { cleanupProbes, PROBE_EXIT_CODE_ENV, PROBE_FAIL_TOKEN, setupProbe } from '../command-probe.js';

afterAll(() => {
  cleanupProbes();
});

describe('runOutcome', () => {
  it('records exit 2 as data, not as a failure', () => {
    const probe = setupProbe('lab-outcome-exit2-');

    const outcome = runOutcome(probe.instrument, ['audit', PROBE_FAIL_TOKEN], {
      cwd: probe.cwd,
      env: { set: { [PROBE_EXIT_CODE_ENV]: '2' }, unset: [] },
    });

    // `RunOutcome` has no notion of "did this count as a failure" — that is
    // the whole point. Exit 2 is exactly as much data as exit 0.
    expect(outcome).toEqual({
      kind: 'exited',
      exitCode: 2,
      stdout: '',
      stderr: expect.any(String),
    });
  });

  it('reports not-run with the spawn error for a missing executable', () => {
    const outcome = runOutcome(
      { command: 'definitely-not-a-real-vat-binary-xyz', leadingArgs: [], version: { version: '0.0.0-test', commit: null, dirty: null } },
      ['audit'],
      { cwd: process.cwd(), env: { set: {}, unset: [] } },
    );

    expect(outcome.kind).toBe('not-run');
    if (outcome.kind !== 'not-run') return;
    expect(outcome.spawnError).toContain('definitely-not-a-real-vat-binary-xyz');
  });
});
