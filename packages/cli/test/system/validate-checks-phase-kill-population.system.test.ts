/**
 * The checks child KILLED by the watchdog during its population (the population-kill row of
 * `vat validate`'s exit table), as the checks overlap's same-build differential: overlapped and
 * sequential on a warm store, the same bytes published. `child-only-stall-in-population.mjs`
 * stalls the child right after its `started` entry, so the kill lands there deterministically. A
 * check killed by its bound and a dead child are `validate-checks-phase-kill.system.test.ts`; the
 * scaled bound: `test-helpers/checks-overlap-kill.ts`.
 *
 * The same kill BEFORE the turn: `parent-only-hold-resources.mjs` holds the overlapped parent's
 * resources phase, on a free loop (so the watchdog's timer still runs), until its child has exited.
 * The kill is then recorded while the resources phase is still running and published at the turn,
 * byte for byte as the sequential run publishes the kill it meets at its own turn.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, safePath } from './test-common.js';
import { boundedPhase, errorsOf, expectKilledInBothModes } from './test-helpers/checks-overlap-kill.js';
import {
  createOverlapFixture,
  expectFacts,
  MARKER_BYTES,
  type OverlapFixture,
  overlappedFacts,
  runBothModes,
} from './test-helpers/checks-overlap.js';
import { TXT_ROWS } from './test-helpers/checks-phase.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
useScratchTmpdir('vat-scratch-validate-checks-kill-population-');

/** The fixture's one committed check, a clean pass: the child never reaches it. */
const CHECKS = [['quick', TXT_ROWS]] as const;

/** The member whose stat the overlapped resources phase is held at: after the home population settled. */
const HOLD_AT = 'docs/b.md';

/** The arm's population stall. */
const STALL = 'child-only-stall-in-population.mjs';

let fixture: OverlapFixture;

describe('vat validate — the checks phase, its child killed during population, same build, both modes', () => {
  beforeAll(async () => {
    fixture = await createOverlapFixture('vat-validate-checks-kill-population-', { checks: CHECKS });
  });

  afterAll(() => {
    cleanupTestTempDir(fixture.scratch);
  });

  it('a child killed during population is a phase error: RUN_INCOMPLETE, the population remedy, exit 2', async () => {
    const { arm, withinMs } = boundedPhase(fixture, CHECKS, STALL);

    const both = await runBothModes(fixture, [], arm);

    expectKilledInBothModes(both, withinMs);
    expect(both.overlapped.code).toBe(2);
    expect(both.overlapped.phases).toContain('checks:error');
    const errors = errorsOf(both.overlapped);
    expect(errors.run?.code).toBe('RUN_INCOMPLETE');
    expect(errors.phase?.message).toContain('Population is legitimately slow');
    expect(errors.phase?.message).toContain('`vat resources check --budget <seconds>`');
    expect(errors.phase?.message).not.toMatch(/(?<!vat resources check )`--budget/);
  });

  it('the same kill before the turn: recorded during the resources phase, published at the turn, the same bytes', async () => {
    const { arm, withinMs } = boundedPhase(fixture, CHECKS, STALL, 'parent-only-hold-resources.mjs');

    const both = await runBothModes(fixture, [], {
      ...arm,
      env: (files) => ({
        ...arm.env?.(files),
        VAT_TEST_PARENT_HOLD_STAT: HOLD_AT,
        VAT_TEST_PARENT_HELD_FILE: files.path('held'),
        VAT_TEST_PARENT_HOLD_UNTIL: 'child-exit',
      }),
    });

    // The overlapped run was held, and the hold ended at the child's exit (its 60 s ceiling is far
    // past the bound each run beats), so the kill came before the turn.
    expect(fs.existsSync(safePath.join(fixture.scratch, 'run-overlapped', 'held')), 'the overlapped run was held').toBe(true);
    expectKilledInBothModes(both, withinMs);
    // The held stderr at the turn was all the killed child had written: its marker.
    expectFacts(both, overlappedFacts(MARKER_BYTES));
    expect(both.overlapped.code).toBe(2);
    expect(errorsOf(both.overlapped).run?.code).toBe('RUN_INCOMPLETE');
  });
});
