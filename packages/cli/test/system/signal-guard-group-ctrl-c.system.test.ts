/**
 * 🚨 A terminal's Ctrl-C under the `vat` wrapper reaches a command with an ASYNCHRONOUS cleanup
 * more than once — and the second must not cut the cleanup short.
 *
 * The terminal signals the whole foreground process GROUP: the wrapper and the CLI both receive
 * SIGINT, and the wrapper forwards its own; an operator pressing Ctrl-C twice sends the group a
 * second. `vat audit <git url>` disposes of its clone on the first. Its handler used to remove
 * itself on the first signal and start the (asynchronous) disposal, so the second met the default
 * disposition and killed the process half-way through: the clone was left behind. Every handler now
 * goes through `handleTerminatingSignals`, which swallows a repeat until the cleanup has settled.
 *
 * The Ctrl-C also reaches whatever subprocess runs in the group: one that lands during the clone
 * kills `git`, and the clone step FAILS of it. The failure path's disposal used to run after the
 * guard was released, so the still-pending SIGINT killed the process half-way through it. The guard
 * is now held until the one disposal has settled, whoever started it.
 *
 * `audit-stall-after-clone.mjs` holds the run at each point — inside the clone step's `git`, or in
 * the audit once the clone exists — and slows the removal of the clone, so the second SIGINT lands
 * while the removal runs. POSIX only: a process group is a POSIX notion, and Windows delivers
 * Ctrl-C as a console event.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { isProcessGoneError, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, getWrapperPath, safePath } from './test-common.js';
import { BIN_PATH, preload } from './test-helpers/checks-phase.js';
import { alive, type LiveVat, startVat, within } from './test-helpers/live-vat.js';

const scratch = useScratchTmpdir('vat-scratch-group-ctrl-c-');

/** How long the clone's removal is held up, so the second SIGINT lands inside it. */
const RM_DELAY_MS = 1000;

let bareRepo: string;
let running: LiveVat | undefined;

function git(args: string[], cwd: string): void {
  const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** Signal the group led by `pid`; a group already gone has nothing left to signal. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isProcessGoneError(error)) throw error;
  }
}

/** The clones `vat audit` minted in this case's TMPDIR and left behind. */
function clonesLeft(): string[] {
  return fs.readdirSync(scratch()).filter((name) => name.startsWith('vat-audit-'));
}

describe.skipIf(process.platform === 'win32')('a group Ctrl-C, twice, under the vat wrapper', () => {
  beforeAll(() => {
    bareRepo = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-group-bare-'));
    const work = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-group-work-'));
    git(['init', '--bare', '--initial-branch=main'], bareRepo);
    git(['init', '--initial-branch=main'], work);
    git(['config', 'user.email', 'test@example.com'], work);
    git(['config', 'user.name', 'Test'], work);
    fs.writeFileSync(safePath.join(work, 'README.md'), '# fixture\n', 'utf-8');
    git(['add', '.'], work);
    git(['commit', '-m', 'initial'], work);
    git(['push', bareRepo, 'main'], work);
    cleanupTestTempDir(work);
  });

  afterEach(() => {
    const pid = running?.process.pid;
    if (pid !== undefined && alive(pid)) signalGroup(pid, 'SIGKILL');
    running = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(bareRepo);
  });

  it.each([
    ['in the audit, once the clone exists', 'audit'],
    ['inside the clone step, killing its git', 'git'],
  ])('vat audit <git url>, Ctrl-C %s: the clone is removed in full, and the run dies of SIGINT', async (_where, stallAt) => {
    const ready = safePath.join(scratch(), 'ready');
    running = startVat(scratch(), ['audit', pathToFileURL(bareRepo).href], {
      entry: getWrapperPath(import.meta.url),
      nodeOptions: [preload('audit-stall-after-clone.mjs')],
      env: { VAT_BIN: BIN_PATH, TEST_READY_FILE: ready, TEST_STALL_AT: stallAt, TEST_RM_DELAY_MS: String(RM_DELAY_MS) },
      ownGroup: true,
    });
    const leader = running.process.pid ?? 0;
    expect(await within(20_000, () => fs.existsSync(ready)), running.stderr()).toBe(true);
    // The positive control: the clone the assertion below says is gone exists now.
    expect(clonesLeft()).toHaveLength(1);

    signalGroup(leader, 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, RM_DELAY_MS / 5));
    // The second Ctrl-C, while the removal is still held up.
    signalGroup(leader, 'SIGINT');

    const ending = await running.ended;
    expect({ code: ending.code, signal: ending.signal }, ending.stderr).toStrictEqual({ code: null, signal: 'SIGINT' });
    expect(clonesLeft(), ending.stderr).toStrictEqual([]);
  });
});
