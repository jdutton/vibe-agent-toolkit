/**
 * 🚨 `vat validate`'s checks overlap, the lasting enforcer, where something fails: the same build
 * run overlapped and sequential on a warm store is indistinguishable from outside when the
 * resources phase throws (not a run refusal), when the checks child's spawn fails at the OS, and
 * when the supervision itself throws (its watchdog's poll). How each mode is taken and what is
 * compared: `test-helpers/checks-overlap.ts`. The kill, dead-child and budget arms are
 * `validate-checks-phase-kill` and `validate-checks-phase-kill-population`; a run ended from outside
 * (Ctrl-C, SIGTERM, an uncaught throw, SIGKILL) is `validate-checks-overlap-ended`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir } from './test-common.js';
import {
  CHILD_MARKER,
  createOverlapFixture,
  expectFacts,
  expectMarkerInItsTurn,
  expectSameOutput,
  overlappedFacts,
  type OverlapFixture,
  runBothModes,
} from './test-helpers/checks-overlap.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
useScratchTmpdir('vat-scratch-checks-overlap-failures-');

/** A document whose one link names nothing, so the resources phase prints a finding of its own. */
const BROKEN_LINK_DOC = 'docs/c.md';
const MISSING_TARGET = 'gone-vat-test.md';

let fixture: OverlapFixture;

describe('vat validate — the checks overlap when something fails, same build, both modes', () => {
  beforeAll(async () => {
    fixture = await createOverlapFixture('vat-checks-overlap-failures-', { files: { [BROKEN_LINK_DOC]: `# Charlie\n\n[gone](./${MISSING_TARGET})\n` } });
  });

  afterAll(() => {
    cleanupTestTempDir(fixture.scratch);
  });

  it('a resources-phase throw that is not a run refusal: that phase errors, the child\'s output is used; output identical', async () => {
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      preloads: ['parent-only-stderr-write-throws.mjs'],
      env: () => ({ VAT_TEST_PARENT_THROW_ON_STDERR: MISSING_TARGET }),
    });

    expect(both.overlapped.phases).toEqual(['resources:error', 'checks:findings']);
    expect(both.overlapped.stderr).toContain('test-only: a stderr write in the supervising process threw');
    expectFacts(both, overlappedFacts(expect.any(Number)));
    expectMarkerInItsTurn(both.overlapped);
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('the child\'s spawn fails at the OS: the same recorded ending in both modes; output identical', async () => {
    const both = await runBothModes(fixture, [], { store: 'warm', preloads: ['parent-only-spawn-fails.mjs'] });

    expect(both.overlapped.childStarted, 'no checks child ran').toBe(false);
    expect(both.overlapped.stderr).not.toContain(CHILD_MARKER);
    expect(both.overlapped.stderr).toContain('ENOENT');
    expectFacts(both, overlappedFacts(0));
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('the supervision throws (its watchdog poll): the child killed, the throw met at the turn; output identical', async () => {
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      preloads: ['parent-only-stat-throws.mjs', 'child-only-stall-in-population.mjs'],
      env: (files) => ({ TEST_CHILD_PID_FILE: files.path('stalled.pid'), TEST_CHILD_MAX_STALL_MS: '60000' }),
    });

    expect(both.overlapped.phases).toEqual(['resources:findings', 'checks:error']);
    expectFacts(both, overlappedFacts(expect.any(Number)));
    expectSameOutput(both.overlapped, both.sequential);
  });
});
