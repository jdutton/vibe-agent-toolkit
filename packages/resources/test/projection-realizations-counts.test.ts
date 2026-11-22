/**
 * A realization's own look at a path is counted by syscall: its `lstat` is one `fs.lstat`; for a
 * link, the followed `stat` is one `fs.stat`, and that follow's chain walk counts its own `lstat`s
 * (one per component below the root plus one per hop).
 *
 * The link case needs a real symlink; a host that cannot create one skips it, visibly.
 */
import { writeFileSync } from 'node:fs';

import { createSymlink, readWorkCounters, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { __resetWorkCountersForTest, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { collectRealization } from '../src/projection/realizations.js';

let root: string;

/** Realize `relativePath` with no content read, so only the path's own look is counted. */
async function realize(relativePath: string): Promise<void> {
  await collectRealization(safePath.join(root, relativePath), 'res-0000', {
    root,
    extentId: 'ctx-filesystem',
    contentCache: null,
    contentDemand: 'deferred',
  });
}

describe('statObservation counts by syscall', () => {
  const suite = setupSyncTempDirSuite('realizations-counts');
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = suite.getTempDir();
    writeFileSync(safePath.join(root, 'target.md'), '# target\n');
    __resetWorkCountersForTest();
  });

  it('statObservation counts lstat as fs.lstat and the followed stat as fs.stat', async ({ skip }) => {
    await realize('target.md');
    expect(readWorkCounters()['fs.lstat'], 'a regular file: one lstat').toBe(1);
    expect(readWorkCounters()['fs.stat'], 'a regular file: nothing followed').toBe(0);

    // Skipped where this host cannot create a symlink (Windows without Developer Mode or the privilege).
    const cap = symlinkCapability() ?? skip();
    createSymlink(cap, 'target.md', safePath.join(root, 'link.md'), 'file');
    __resetWorkCountersForTest();

    await realize('link.md');
    // The realization's own lstat, then the follow's walk: link.md (a hop) and target.md.
    const followWalk = 2;
    expect(readWorkCounters()['fs.lstat'], 'a link: its lstat plus the follow\'s walk').toBe(1 + followWalk);
    expect(readWorkCounters()['fs.stat'], 'a link: one followed stat').toBe(1);
  });
});
