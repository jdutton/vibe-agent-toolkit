/**
 * `checkNoStrayGeneratedMarkers` (and, through it, `checkGeneratedBlocks`) must
 * survive a tracked `.md` file that is deleted in the working tree but not yet
 * staged — `git ls-files` still reports the path, but reading it throws ENOENT.
 * This is not a rare edge case: any in-flight commit that deletes a tracked doc
 * puts the gate in exactly this state for as long as the deletion is
 * uncommitted. Integration tier: it spawns real `git` against a temp repo,
 * which is what actually reproduces the ENOENT (a mocked listing cannot).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { checkNoStrayGeneratedMarkers } from '../../src/derived-artifact-rules.js';
import { cleanupTestTempDir, createTestTempDir } from '../test-helpers.js';

function git(cwd: string, args: string[]): void {
  spawnSync(gitExecutable(), args, { cwd, stdio: 'ignore' });
}

describe('checkNoStrayGeneratedMarkers: a tracked .md deleted in the working tree', () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = createTestTempDir({ prefix: 'derived-artifact-rules-deleted-doc-' });
    git(repoRoot, ['init', '-b', 'main', '--quiet']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test User']);
  });

  afterAll(() => {
    cleanupTestTempDir(repoRoot);
  });

  beforeEach(() => {
    const docPath = safePath.join(repoRoot, 'doc-to-delete.md');
    fs.writeFileSync(docPath, '# a tracked doc with no generated block\n');
    git(repoRoot, ['add', 'doc-to-delete.md']);
    git(repoRoot, ['commit', '--quiet', '-m', 'add doc']);
    // Deleted in the working tree, never staged: `git ls-files` still reports
    // it, but reading it from disk throws ENOENT.
    fs.rmSync(docPath);
  });

  it('does not crash, and does not report the deleted path as a finding', () => {
    expect(() => checkNoStrayGeneratedMarkers(repoRoot)).not.toThrow();
    expect(checkNoStrayGeneratedMarkers(repoRoot)).toEqual([]);
  });
});
