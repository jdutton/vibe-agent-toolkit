/**
 * 🚨 A checks child that EXITS leaves nothing it started running.
 *
 * The child leads its own process group on POSIX. The guard kills that group when the supervisor
 * is interrupted — but a child that ran to completion and left a subprocess behind (a `git` it did
 * not wait for) ended the run with that subprocess still running, reparented, for good. The
 * supervisor now kills what is left of the group as the child exits. POSIX only: Windows has no
 * process groups, and the tree of a process that has exited can no longer be walked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, safePath } from './test-common.js';
import { preload, TXT_ROWS, writeConfig } from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';
import { alive, pidWrittenTo, startVat, within } from './test-helpers/live-vat.js';

const scratch = useScratchTmpdir('vat-scratch-checks-left-behind-');

/** How long the left-behind grandchild may outlive the run — headroom for a loaded runner. */
const KILL_BOUND_MS = 5000;

let dir: string;
let grandchild: number | undefined;

describe.skipIf(process.platform === 'win32')('a checks child that exits leaving a subprocess behind', () => {
  beforeAll(() => {
    dir = createMarkdownGitFixture('vat-check-left-behind-');
    writeConfig(dir, [['quick', TXT_ROWS]]);
  });

  afterEach(() => {
    if (grandchild !== undefined && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
    grandchild = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(dir);
  });

  it('vat resources check completes, and the subprocess its child left running is killed with the child\'s group', async () => {
    const grandchildPidFile = safePath.join(scratch(), 'grandchild.pid');
    const running = startVat(dir, ['resources', 'check', '--budget', '600'], {
      nodeOptions: [preload('child-only-leave-grandchild.mjs')],
      env: { TEST_GRANDCHILD_PID_FILE: grandchildPidFile },
    });

    const ending = await running.ended;
    grandchild = await pidWrittenTo(grandchildPidFile);
    const grandchildPid = grandchild;

    // The run itself completed: a document, not an interruption.
    expect({ code: ending.code, status: ending.document['status'] }, ending.stderr).toStrictEqual({ code: 0, status: 'ok' });
    expect(await within(KILL_BOUND_MS, () => !alive(grandchildPid)), ending.stderr).toBe(true);
  });
});
