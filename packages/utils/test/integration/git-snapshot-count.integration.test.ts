/**
 * `git.snapshots` - one count per snapshot taken, never per call asked.
 *
 * The lab's warm-after-edit work facet reads the parent's snapshot count off a dump, so the
 * counter has to sit where the snapshot is TAKEN (a memo miss), not where one is asked for.
 * Counted at the lookup it would report two for two calls inside one bracket, and the bar the
 * lab gates on would see a snapshot that never ran.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { withGitSnapshotCache } from '../../src/git-snapshot.js';
import { freshGitTreeKey, gitTreeKey } from '../../src/git-tree-key.js';
import { normalizedTmpdir, safePath } from '../../src/path-utils.js';
import { __resetWorkCountersForTest, readWorkCounters } from '../../src/work-counters.js';
import { createGitRepo } from '../test-helpers.js';

const created: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-snapshot-count-'));
  created.push(root);
  createGitRepo(root);
  writeFileSync(safePath.join(root, 'top.md'), '# top\n');
  return root;
}

beforeEach(() => {
  __resetWorkCountersForTest();
});

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('git.snapshots', () => {
  it('counts one snapshot for two gitTreeKey calls on one repository inside a bracket', () => {
    const root = makeRepo();

    withGitSnapshotCache(() => {
      gitTreeKey({ cwd: root });
      gitTreeKey({ cwd: root });
    });

    expect(readWorkCounters()['git.snapshots']).toBe(1);
  });

  it('counts a second snapshot for a freshGitTreeKey after them', () => {
    const root = makeRepo();

    withGitSnapshotCache(() => {
      gitTreeKey({ cwd: root });
      gitTreeKey({ cwd: root });
      freshGitTreeKey({ cwd: root });
    });

    expect(readWorkCounters()['git.snapshots']).toBe(2);
  });
});
