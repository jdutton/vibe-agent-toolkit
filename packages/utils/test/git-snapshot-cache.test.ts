/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp dir this test owns */
/**
 * `withGitSnapshotCache` — the bracket that makes one command take one snapshot.
 *
 * A snapshot is not a read: it copies the index, runs `git add --all` and
 * `git write-tree` against the target repository. Two consumers wanted the same
 * snapshot of the same repository in the same command — the projection store
 * keeps `hash` as its key, the git crawl source keeps `entries` — and each was
 * paying for its own. What this file pins is that the bracket removes the
 * SECOND snapshot without turning `gitTreeSnapshot` into a memoized function.
 *
 * Three properties carry the weight, and each has a plausible "simplification"
 * that would break it silently:
 *
 * 1. **Outside a bracket nothing is cached.** A module-level memo would be the
 *    obvious implementation and would pass every dedupe assertion here — and
 *    would then serve a stale snapshot to the next test in the worker that
 *    mutated a repository and re-snapshotted it. `caches nothing outside a
 *    bracket` is the standing proof that did not happen; it is also what keeps
 *    the counter below honest, since a counter stuck at 1 fails it.
 * 2. **The key is the RESOLVED repository root, not the `cwd` asked about.**
 *    The two real call sites pass different directories — the corpus root and
 *    the project root — and a snapshot covers the whole repository regardless.
 *    Keyed on `cwd` the dedupe would silently do nothing in exactly the case it
 *    was written for.
 * 3. **Concurrent brackets do not share.** `AsyncLocalStorage` rather than a
 *    variable, because the bracket spans `await`s and one process may run two
 *    commands at once.
 *
 * ## The consequence this pins on purpose
 *
 * Inside a bracket a mid-bracket working-tree edit is NOT seen by the second
 * call. That is the point rather than a wart: it is the race the bracket
 * closes. Before it, the store could key an extent under a hash taken 195 ms
 * before the entries it filed under it, so a well-timed edit produced a cache
 * entry whose key did not describe its contents. `observes no mid-bracket
 * mutation` is that guarantee stated as a test.
 *
 * `getGitTreeSnapshot` is left REAL and merely counted. A stub returning a
 * canned snapshot would make every assertion here a statement about the stub —
 * and the counter sits at the seam that actually spawns git, so a count of one
 * is a spawn of one rather than an inference from a stopwatch.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type * as VibeValidateGit from '@vibe-validate/git';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '../src/path-utils.js';

import { createGitRepo } from './test-helpers.js';

const git = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@vibe-validate/git', async (importOriginal) => {
  const actual = await importOriginal<typeof VibeValidateGit>();
  return {
    ...actual,
    getGitTreeSnapshot: (options: { cwd: string }) => {
      git.calls += 1;
      return actual.getGitTreeSnapshot(options);
    },
  };
});

const { gitTreeSnapshot, withGitSnapshotCache } = await import('../src/git-snapshot.js');

const created: string[] = [];

/** Written INSIDE a bracket, so a snapshot that contains it is a snapshot taken too late. */
const LATE_ARRIVAL = 'appeared-mid-bracket.md';

/**
 * A fresh repository with one committed-shaped file and one nested directory.
 *
 * Every case needs the same thing — a real repository git will answer about,
 * plus a subdirectory to ask from — and writing it per case is how two of these
 * drift into testing different fixtures under the same name.
 *
 * @returns The repository root and a directory inside it, both realpath'd
 */
function makeRepo(): { root: string; nested: string } {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-snapshot-bracket-'));
  created.push(root);
  createGitRepo(root);
  writeFileSync(safePath.join(root, 'top.md'), '# top\n');
  const nested = safePath.join(root, 'packages', 'inner');
  mkdirSyncReal(nested, { recursive: true });
  writeFileSync(safePath.join(nested, 'inner.md'), '# inner\n');
  return { root, nested };
}

beforeEach(() => {
  git.calls = 0;
});

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('withGitSnapshotCache', () => {
  it('takes ONE snapshot for two calls on the same root inside a bracket', () => {
    const { root } = makeRepo();

    const [first, second] = withGitSnapshotCache(() => [
      gitTreeSnapshot({ cwd: root }),
      gitTreeSnapshot({ cwd: root }),
    ]);

    expect(git.calls).toBe(1);
    expect(second).toBe(first);
    expect(first?.entries.length).toBeGreaterThan(0);
  });

  it('caches nothing outside a bracket', () => {
    const { root } = makeRepo();

    const first = gitTreeSnapshot({ cwd: root });
    const second = gitTreeSnapshot({ cwd: root });

    expect(git.calls).toBe(2);
    expect(second).not.toBe(first);
    expect(second?.hash).toBe(first?.hash);
  });

  it('shares one entry across DIFFERENT cwds that resolve to the same repository root', () => {
    const { root, nested } = makeRepo();

    const [outer, inner] = withGitSnapshotCache(() => [
      gitTreeSnapshot({ cwd: root }),
      gitTreeSnapshot({ cwd: nested }),
    ]);

    expect(git.calls).toBe(1);
    expect(inner).toBe(outer);
    expect(inner?.repositoryRoot).toBe(outer?.repositoryRoot);
  });

  it('keeps separate roots separate inside one bracket', () => {
    const a = makeRepo();
    const b = makeRepo();

    const [first, second] = withGitSnapshotCache(() => [
      gitTreeSnapshot({ cwd: a.root }),
      gitTreeSnapshot({ cwd: b.root }),
    ]);

    expect(git.calls).toBe(2);
    expect(second?.repositoryRoot).not.toBe(first?.repositoryRoot);
  });

  it('does not let two concurrent brackets share entries', async () => {
    const { root } = makeRepo();

    /**
     * One bracket, yielding to the event loop between its two calls so the
     * other bracket is guaranteed to be open at the same time.
     *
     * @returns The two snapshots it took
     */
    const bracket = async (): Promise<ReturnType<typeof gitTreeSnapshot>[]> =>
      withGitSnapshotCache(async () => {
        const before = gitTreeSnapshot({ cwd: root });
        await new Promise((resolve) => setTimeout(resolve, 0));
        return [before, gitTreeSnapshot({ cwd: root })];
      });

    const [left, right] = await Promise.all([bracket(), bracket()]);

    // Two brackets, one snapshot each — NOT one between them. A module-level
    // memo would make this 1, which is precisely the implementation refused.
    expect(git.calls).toBe(2);
    expect(left[0]).toBe(left[1]);
    expect(right[0]).toBe(right[1]);
    expect(right[0]).not.toBe(left[0]);
  });

  it('observes no mid-bracket mutation, which is the race it closes', () => {
    const { root } = makeRepo();

    const [before, after] = withGitSnapshotCache(() => {
      const first = gitTreeSnapshot({ cwd: root });
      writeFileSync(safePath.join(root, LATE_ARRIVAL), '# late\n');
      return [first, gitTreeSnapshot({ cwd: root })];
    });

    expect(git.calls).toBe(1);
    expect(after).toBe(before);
    expect(after?.entries.some((e) => e.absolutePath.endsWith(LATE_ARRIVAL))).toBe(false);

    // ...and the same edit IS visible to the next call outside the bracket, so
    // the assertion above is about the bracket rather than about git.
    const reread = gitTreeSnapshot({ cwd: root });
    expect(reread?.entries.some((e) => e.absolutePath.endsWith(LATE_ARRIVAL))).toBe(true);
  });

  it('caches the "git could not answer" result too, so a failure is paid for once', () => {
    const { root } = makeRepo();
    // A `.git` that exists but is not a readable repository: `gitFindRoot` finds
    // a root (so the call is keyable) while `getGitTreeSnapshot` cannot answer.
    rmSync(safePath.join(root, '.git'), { recursive: true, force: true });
    writeFileSync(safePath.join(root, '.git'), 'gitdir: /nowhere/at/all\n');
    // Silenced, and counted: `getGitTreeSnapshot` warns on a failure it does not
    // recognize as "there is no repository here", and one warning for two calls
    // is a second, independent witness that the failing path ran once.
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const [first, second] = withGitSnapshotCache(() => [
      gitTreeSnapshot({ cwd: root }),
      gitTreeSnapshot({ cwd: root }),
    ]);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(git.calls).toBe(1);
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  });
});
