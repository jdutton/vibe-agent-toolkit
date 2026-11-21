/**
 * 🚨 `vat validate`'s checks overlap, the lasting enforcer: on a warm store the same build run
 * overlapped (the checks child started during the resources phase, its stderr held in a file) and
 * sequential (started at its turn, its stderr inherited) is indistinguishable from outside: the
 * same normalized stdout and stderr, phase order and exit. How a run is made to take each mode, and
 * what is compared: `test-helpers/checks-overlap.ts`.
 *
 * This file holds the arms where the gate lets the overlap happen (warm, a stat-dirty index), the
 * replay of the held stderr (the child's marker lands after the checks banner and before the
 * findings, and the overlapped run had buffered it), its liveness from the turn (a line the child
 * writes after the turn reaches the terminal while the child still runs), and the cold store the
 * gate leaves sequential. The arms the gate declines are `validate-checks-overlap-declines`; the
 * phases that fail, `validate-checks-overlap-failures`.
 */

import { spawnSync } from 'node:child_process';
import { utimesSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs } from './test-common.js';
import {
  CHECKS_BANNER,
  CHILD_MARKER,
  createOverlapFixture,
  expectFacts,
  expectMarkerInItsTurn,
  expectSameOutput,
  type InFlight,
  killInFlight,
  MARKER_BYTES,
  type OverlapFixture,
  runBothModes,
  sequentialFacts,
} from './test-helpers/checks-overlap.js';
import { alive, pidWrittenTo, within } from './test-helpers/live-vat.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
useScratchTmpdir('vat-scratch-checks-overlap-warm-');

/** How long a case waits for the running process to show what it waits for. */
const LOOK_MS = 30_000;

let fixture: OverlapFixture;
// The run a case has in flight, so a red case cannot leave it (or its held child) running.
let inFlight: InFlight | undefined;

describe('vat validate — the checks overlap on a warm store, same build, both modes', () => {
  beforeAll(async () => {
    fixture = await createOverlapFixture('vat-checks-overlap-warm-');
  });

  afterEach(() => {
    killInFlight(inFlight);
    inFlight = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(fixture.scratch);
  });

  it('warm: overlapped, the held stderr replayed in full at its turn, writing nothing; output identical', async () => {
    // The overlapped parent waits, right after its spawn, for the child to have EXITED: what the
    // turn finds in `stderr.log` (a child that ended long before it) is then fixed, not a race.
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      preloads: ['parent-only-await-overlapped-child.mjs'],
      env: (files) => ({ VAT_TEST_PARENT_AWAIT_FILE: files.childExit, VAT_TEST_PARENT_TURN_TRACE: files.path('turn.trace') }),
    });

    // The exited child's progress directory still held its stderr.log at the turn (none exists yet
    // at a sequential turn: the child is spawned after it).
    //
    // The zero write counts below hold by construction here: the parent is blocked from its spawn
    // until the child exits, so no write of its own can fall in the window. The arms where the
    // parent runs beside the child, so that a zero is evidence: the liveness and stat-dirty arms
    // below, the killed-check arms (`validate-checks-phase-kill`), and the probe-refused decline
    // (`validate-checks-overlap-declines`), whose one parse-cache write the window counts.
    expect(fs.readFileSync(safePath.join(fixture.scratch, 'run-overlapped', 'turn.trace'), 'utf-8')).toBe('1\n');
    expect(fs.readFileSync(safePath.join(fixture.scratch, 'run-sequential', 'turn.trace'), 'utf-8')).toBe('0\n');

    expectFacts(both, {
      checksOverlapped: 1,
      gateDeclinedBy: null,
      childStderrBytesAtTurn: MARKER_BYTES,
      parentStoreWritesUntilChildExit: 0,
      parentParseCacheWritesUntilChildExit: 0,
    });
    expectMarkerInItsTurn(both.overlapped);
    expectMarkerInItsTurn(both.sequential);
    expectSameOutput(both.overlapped, both.sequential);
    expect(both.overlapped.code).toBe(1);
  });

  it('liveness: a line the child writes after the turn reaches stderr while the child still runs', async () => {
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      env: (files) => ({ VAT_TEST_CHILD_SPEAK_FILE: files.path('speak'), VAT_TEST_CHILD_RELEASE_FILE: files.path('release') }),
      during: async (running, files) => {
        inFlight = { running, files };
        const pid = await pidWrittenTo(files.childPid);
        expect(await within(LOOK_MS, () => running.stderr().includes(CHECKS_BANNER)), running.stderr()).toBe(true);
        fs.writeFileSync(files.path('speak'), '', 'utf-8');
        // The child is held until the release, so a line seen now was relayed while it ran.
        expect(await within(LOOK_MS, () => running.stderr().includes(CHILD_MARKER)), running.stderr()).toBe(true);
        expect(alive(pid), 'the child, still held').toBe(true);
        fs.writeFileSync(files.path('release'), '', 'utf-8');
      },
    });

    // Not the bytes at the turn: whether the turn's first copy came before the child spoke is a race.
    expect(both.overlapped.facts).toMatchObject({ checksOverlapped: 1, parentStoreWritesUntilChildExit: 0, parentParseCacheWritesUntilChildExit: 0 });
    expect(both.sequential.facts).toMatchObject({ checksOverlapped: 0, gateDeclinedBy: { condition: 'cores' } });
    expectMarkerInItsTurn(both.overlapped);
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('a stat-dirty git index: the throwaway index snapshot still hits, so it overlaps; output identical', async () => {
    const touched = safePath.join(fixture.project, 'docs', 'a.md');
    const later = new Date(Date.now() + 60_000);
    utimesSync(touched, later, later);
    const statDirty = (): string =>
      spawnSync(gitExecutable(), ['diff-files', '--name-only'], { cwd: fixture.project, encoding: 'utf-8' }).stdout.trim();
    expect(statDirty(), 'the index is stat-dirty for the touched file').toBe('docs/a.md');

    const both = await runBothModes(fixture, [], { store: 'warm' });

    expect(statDirty(), 'neither run refreshed the real index').toBe('docs/a.md');
    expectFacts(both, expect.objectContaining({ checksOverlapped: 1, parentStoreWritesUntilChildExit: 0, parentParseCacheWritesUntilChildExit: 0 }));
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('cold: the gate leaves it sequential (not-hit), and both modes populate alike', async () => {
    const both = await runBothModes(fixture, [], { store: 'cold' });

    expectFacts(both, sequentialFacts({ condition: 'not-hit' }));
    expectMarkerInItsTurn(both.overlapped);
    expectSameOutput(both.overlapped, both.sequential);
  });
});
