/**
 * 🚨 `vat validate` with a FAULTY checks child, as the checks overlap's same-build differential
 * (`test-helpers/checks-overlap.ts`): one build run on a warm store overlapped (the child spawned
 * during the resources phase, its stderr held until its turn) and sequential, and the two must
 * publish the same bytes. The child garbles its stdout, or exits against its own clean report; each
 * fault is a test-only preload acting in the child alone. Their check is committed: a config edited
 * per case is a tree the store has not seen. The other faulty-child cases, standalone and under
 * `vat validate`, and the nested-project cases: `validate-checks-phase-faults.system.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir } from './test-common.js';
import { expectReplayedAtTurn, findingsOf } from './test-helpers/checks-overlap-kill.js';
import { createOverlapFixture, type ModeRun, type OverlapFixture, runBothModes } from './test-helpers/checks-overlap.js';
import { RUN_INTEGRITY, TXT_ROWS } from './test-helpers/checks-phase.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
useScratchTmpdir('vat-scratch-checks-overlap-faults-');

/** The one RESOURCE_CHECK_BROKEN finding the phase published, for a run whose phase has findings. */
function brokenFinding(run: ModeRun): string | undefined {
  expect(run.code, run.stderr).toBe(1);
  expect(run.phases, run.mode).toContain('checks:findings');
  const broken = findingsOf(run).filter((finding) => finding.code === RUN_INTEGRITY);
  expect(broken, run.mode).toHaveLength(1);
  return broken[0]?.message;
}

describe('vat validate — the checks phase, a faulty child, same build, both modes', () => {
  /** The committed check every run of this fixture runs. */
  const CHECKS = [['quick', TXT_ROWS]] as const;
  let fixture: OverlapFixture;

  beforeAll(async () => {
    fixture = await createOverlapFixture('vat-validate-checks-faults-overlap-', { checks: CHECKS });
  });

  afterAll(() => {
    cleanupTestTempDir(fixture.scratch);
  });

  it('garbled stdout after population is RESOURCE_CHECK_BROKEN naming the unreadable report (exit 1)', async () => {
    const both = await runBothModes(fixture, [], { store: 'warm', preloads: ['child-only-garbled-stdout.mjs'] });

    expectReplayedAtTurn(both);
    expect(brokenFinding(both.overlapped)).toContain('is not this command\'s document');
  });

  it('a child whose exit contradicts its clean report fails the phase (RESOURCE_CHECK_BROKEN, exit 1)', async () => {
    const both = await runBothModes(fixture, [], { store: 'warm', preloads: ['child-only-exit-disagrees.mjs'] });

    expectReplayedAtTurn(both);
    expect(brokenFinding(both.overlapped)).toContain('verdict is exit 0, and then exited 3');
  });
});
