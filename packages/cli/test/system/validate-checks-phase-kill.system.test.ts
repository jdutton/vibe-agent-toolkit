/**
 * The checks child KILLED by the watchdog while a check runs (the budget row of `vat validate`'s
 * exit table), and DEAD before it published anything. A child killed during its population is
 * `validate-checks-phase-kill-population.system.test.ts`; a supervisor ended from outside is
 * `checks-supervisor-orphan.system.test.ts` and, overlapped, `validate-checks-overlap-ended.system.test.ts`.
 *
 * 🚨 Every case is the checks overlap's same-build differential (`test-helpers/checks-overlap.ts`):
 * one build run on a warm store overlapped (the child spawned during the resources phase, its
 * stderr held in a file until its turn) and sequential, and the two must publish the same bytes.
 * A kill or death that lands before the turn is recorded and published at it, as if it had
 * happened there. How the default bound is scaled to this machine, and why the headroom is
 * empirical: `test-helpers/checks-overlap-kill.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir } from './test-common.js';
import {
  boundedPhase,
  errorsOf,
  expectKilledInBothModes,
  expectReplayedAtTurn,
  findingsOf,
  SEED_UNDER_FAST_CLOCK,
} from './test-helpers/checks-overlap-kill.js';
import {
  createOverlapFixture,
  expectFacts,
  MARKER_BYTES,
  type OverlapFixture,
  overlappedFacts,
  runBothModes,
} from './test-helpers/checks-overlap.js';
import { RUN_INTEGRITY, RUNAWAY_SQL } from './test-helpers/checks-phase.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
useScratchTmpdir('vat-scratch-validate-checks-kill-');

/**
 * The fixture's one committed check, which never finishes. Committed, so the store seeded from the
 * tree answers every run: a config edited per case would be a tree the store has not seen. A child
 * dead before it reaches the check never runs it.
 */
const CHECKS = [['runaway', RUNAWAY_SQL]] as const;

let fixture: OverlapFixture;

describe('vat validate — the checks phase, a check killed by its bound or a dead child, same build, both modes', () => {
  beforeAll(async () => {
    fixture = await createOverlapFixture('vat-validate-checks-kill-', { checks: CHECKS, seed: SEED_UNDER_FAST_CLOCK });
  });

  afterAll(() => {
    cleanupTestTempDir(fixture.scratch);
  });

  it('kills a check that never finishes: RESOURCE_CHECK_BROKEN naming it, the statement remedy, exit 1', async () => {
    const { arm, withinMs } = boundedPhase(fixture, CHECKS);

    const both = await runBothModes(fixture, [], arm);

    expectKilledInBothModes(both, withinMs);
    expect(both.overlapped.code).toBe(1);
    const broken = findingsOf(both.overlapped).find((f) => f.code === RUN_INTEGRITY && f.message.includes('runaway'));
    // The statement branch's own sentence — not the population's, startup's or reporting's.
    expect(broken?.message).toContain('A statement that will not finish');
    expect(broken?.message).toContain('`vat resources check --budget <seconds>`');
    expect(broken?.message).not.toMatch(/(?<!vat resources check )`--budget/);
  });

  it('a child dead before it published anything is a phase error: RUN_INCOMPLETE, exit 2', async () => {
    // The overlapped parent waits, right after its spawn, for the child to have exited: its
    // abnormal ending is recorded long before the turn publishes it.
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      preloads: ['child-only-exit-at-start.mjs', 'parent-only-await-overlapped-child.mjs'],
      env: (files) => ({ VAT_TEST_PARENT_AWAIT_FILE: files.childExit, VAT_TEST_PARENT_TURN_TRACE: files.path('turn.trace') }),
    });

    expectReplayedAtTurn(both);
    // Every byte the dead child wrote was in its held stderr when the turn began.
    expectFacts(both, overlappedFacts(MARKER_BYTES));
    expect(both.overlapped.code).toBe(2);
    const errors = errorsOf(both.overlapped);
    expect(errors.run?.code).toBe('RUN_INCOMPLETE');
    // ITS ending: a child that exited 0 having written nothing, before it had reported starting.
    expect(errors.phase?.message).toContain('the child process exited 0 and published no report at all');
    expect(errors.phase?.message).toContain('before the child process had finished starting');
  });
});
