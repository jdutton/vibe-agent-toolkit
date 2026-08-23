/**
 * Which enumerator a root gets, now that git is the DEFAULT rather than a
 * requested option.
 *
 * ## Why the non-git case is a gate and not an edge case
 *
 * `GitCrawlSource` throws when git cannot answer — deliberately, because an
 * empty population is indistinguishable from an empty repository. So the moment
 * git became the default, every tree with no `.git` above it became a candidate
 * hard failure: a corpus synced from SharePoint, an extracted tarball, a plain
 * documentation folder handed to `vat resources scan`. These tests pin the
 * fallback that stops that, in both directions — the git repository still gets
 * git, and the tree without one still scans.
 *
 * `vitest.setup.js` deletes every `VAT_*` variable before any test module loads,
 * so the un-stubbed cases here are genuinely exercising the DEFAULT.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  crawlSourceFor,
  EXTENT_SOURCE_ENV,
  EXTENT_SOURCE_FILESYSTEM,
  EXTENT_SOURCE_GIT,
  gitExtentSelected,
} from '../src/projection/crawl-source.js';

/* eslint-disable security/detect-non-literal-fs-filename -- every path is built from a controlled mkdtemp directory */

let plainDirectory: string;
let repository: string;
let emptyMarker: string;
let danglingPointer: string;

beforeEach(() => {
  // `mkdtemp` under the OS temp dir, which is not inside any repository — the
  // whole point. A fixture created inside this project would resolve UPWARD to
  // this project's own `.git` and silently test the git path instead.
  plainDirectory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-extent-plain-'));
  writeFileSync(`${plainDirectory}/readme.md`, '# plain\n');

  repository = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-extent-repo-'));
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
  spawnSync('git', ['init', '-q'], { cwd: repository });
  writeFileSync(`${repository}/readme.md`, '# repo\n');

  // A `.git` that EXISTS and is not a repository. This is what an aborted clone
  // leaves behind, and what `mkdir .git` produces.
  emptyMarker = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-extent-empty-'));
  mkdirSyncReal(`${emptyMarker}/.git`, { recursive: true });
  writeFileSync(`${emptyMarker}/readme.md`, '# empty marker\n');

  // A `.git` FILE naming a gitdir that is not there — a linked worktree whose
  // parent checkout was deleted, or a submodule pointing at a pruned path.
  danglingPointer = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-extent-pointer-'));
  writeFileSync(`${danglingPointer}/.git`, `gitdir: ${danglingPointer}/nowhere\n`);
  writeFileSync(`${danglingPointer}/readme.md`, '# dangling pointer\n');
});

afterEach(() => {
  rmSync(plainDirectory, { recursive: true, force: true });
  rmSync(repository, { recursive: true, force: true });
  rmSync(emptyMarker, { recursive: true, force: true });
  rmSync(danglingPointer, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('extent source selection', () => {
  it('falls back to the filesystem enumerator on a tree with no git repository', () => {
    // No env stubbing: this IS the default, and the default must not throw here.
    expect(gitExtentSelected(plainDirectory)).toBe(false);
    expect(crawlSourceFor(plainDirectory).kind).toBe('filesystem');
  });

  it('selects the git enumerator inside a git working tree by default', () => {
    // The mirror. Without this the test above would also pass against a build
    // where the flip never happened, or where git selection was broken outright.
    expect(gitExtentSelected(repository)).toBe(true);
    expect(crawlSourceFor(repository).kind).toBe('git');
  });

  it('falls back when a .git marker exists but is not a repository git can read', () => {
    // `gitFindRoot` answers "is there a `.git` entry", which is NOT "will git
    // answer". Before this was separated, an empty `.git/` selected the git
    // enumerator, which then threw — turning a directory that used to scan
    // fine into `status: error`. Both broken shapes must fall back, not fail.
    expect(gitExtentSelected(emptyMarker)).toBe(false);
    expect(crawlSourceFor(emptyMarker).kind).toBe('filesystem');

    expect(gitExtentSelected(danglingPointer)).toBe(false);
    expect(crawlSourceFor(danglingPointer).kind).toBe('filesystem');
  });

  it('opts back to the filesystem enumerator inside a repository when asked', () => {
    vi.stubEnv(EXTENT_SOURCE_ENV, EXTENT_SOURCE_FILESYSTEM);

    expect(gitExtentSelected(repository)).toBe(false);
    expect(crawlSourceFor(repository).kind).toBe('filesystem');
  });

  it('still honours an explicit git request, and still cannot grant it without a repository', () => {
    // Naming the git arm explicitly is what the lab does. It must keep meaning
    // what it meant — and must NOT override the fallback, or the lab's own git
    // arm would crash on any non-git subject.
    vi.stubEnv(EXTENT_SOURCE_ENV, EXTENT_SOURCE_GIT);

    expect(gitExtentSelected(repository)).toBe(true);
    expect(gitExtentSelected(plainDirectory)).toBe(false);
    expect(crawlSourceFor(plainDirectory).kind).toBe('filesystem');
  });
});
