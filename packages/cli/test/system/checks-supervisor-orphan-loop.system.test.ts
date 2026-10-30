/**
 * 🚨 A checks child orphaned IN THE MIDDLE OF ITS CHECK LOOP ends itself — unpublished.
 *
 * The child learns its supervisor is gone by reading end-of-file on the stdin pipe the supervisor
 * held (`endWhenSupervisorGone`), and it reads that only when its event loop turns. The checks run
 * one after another synchronously, and a check blocked inside SQLite reaches nothing until it
 * returns — so here the child is held INSIDE its first check (`child-only-slow-check.mjs`, an
 * `Atomics.wait` the way a slow statement blocks the thread) while the supervisor is SIGKILLed.
 *
 * What holds, and what `vat resources check --help` says: on POSIX, once that check returns, the
 * child ends — its one stderr line, exit 2 — and it publishes NOTHING: no document reaches stdout.
 * On Windows the supervisor's `TerminateProcess` closes libuv's kill-on-close job object, and the
 * OS terminates the child at once, mid-check: gone within the bound, no trace, nothing published
 * (`expectOrphanedChildEnding`).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, safePath } from './test-common.js';
import { preload, TXT_ROWS, writeConfig } from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';
import {
  alive,
  expectOrphanedChildEnding,
  killStillRunning,
  type LiveVat,
  pidWrittenTo,
  startVat,
  within,
} from './test-helpers/live-vat.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-checks-orphan-loop-');

/** How long the child is held inside its first check. */
const BLOCK_MS = 1500;

/**
 * How long the orphaned child may outlive its supervisor: the rest of the held check, then
 * end-of-file at the next turn — with headroom for a loaded runner.
 */
const ORPHAN_BOUND_MS = BLOCK_MS + 5000;

let dir: string;
let supervisor: LiveVat | undefined;
let child: number | undefined;

describe('a checks child orphaned inside a check', () => {
  beforeAll(() => {
    dir = createMarkdownGitFixture('vat-check-orphan-loop-');
    writeConfig(dir, [['quick', TXT_ROWS], ['second', TXT_ROWS]]);
  });

  afterEach(() => {
    killStillRunning(supervisor, child);
    supervisor = undefined;
    child = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(dir);
  });

  it('ends itself once the check returns: its one line, exit 2, and nothing published', async () => {
    const pidFile = safePath.join(scratch(), 'child.pid');
    const trace = safePath.join(scratch(), 'child.trace');
    const running = startVat(dir, ['resources', 'check', '--budget', '600'], {
      nodeOptions: [preload('child-only-slow-check.mjs')],
      env: { TEST_CHILD_PID_FILE: pidFile, TEST_CHILD_TRACE_FILE: trace, TEST_CHILD_BLOCK_MS: String(BLOCK_MS) },
    });
    supervisor = running;
    child = await pidWrittenTo(pidFile);
    const childPid = child;
    // The positive control: the child is held inside its check now.
    expect(alive(childPid)).toBe(true);

    running.process.kill('SIGKILL');

    await running.ended;
    // The bound FIRST, at the supervisor's own exit — before anything waits on the child.
    expect(await within(ORPHAN_BOUND_MS, () => !alive(childPid)), running.stderr()).toBe(true);
    // POSIX: its own ending, unpublished. Windows: terminated with its supervisor, untraced.
    await expectOrphanedChildEnding(running, trace);
  });
});
