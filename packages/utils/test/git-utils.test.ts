/**
 * Unit tests for git-utils: isGitIgnored ancestor walk.
 */

import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '../src/path-utils.js';

// Mock modules before importing the code under test
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('which', () => ({
  default: { sync: vi.fn().mockReturnValue('/usr/bin/git') },
}));

// Import after mocks are set up
const { isGitIgnored } = await import('../src/git-utils.js');

/** Helper to create a spawnSync return value. */
function makeSpawnResult(status: number, stdout = ''): SpawnSyncReturns<string> {
  return { status, stdout, stderr: '', pid: 0, output: [], signal: null };
}

/**
 * Create a spawnSync mock that returns exit codes based on a path → status map.
 * Handles both per-file mode (check-ignore -q <path>) and batch mode (check-ignore --stdin).
 * Unmapped paths return the fallback status (default: 1 = not ignored).
 */
function mockSpawnByPath(
  pathStatusMap: Record<string, number>,
  options?: { batchStdout?: string; fallbackStatus?: number },
): void {
  const fallback = options?.fallbackStatus ?? 1;
  vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
    const argsArray = args as string[];
    // Batch mode: check-ignore --stdin
    if (argsArray[1] === '--stdin' && options?.batchStdout !== undefined) {
      return makeSpawnResult(0, options.batchStdout);
    }
    // Per-file mode: check-ignore -q <path> — pathArg is args[2]
    const pathArg = argsArray[2];
    if (pathArg !== undefined && pathArg in pathStatusMap) {
      return makeSpawnResult(pathStatusMap[pathArg] as number);
    }
    return makeSpawnResult(fallback);
  });
}

/**
 * `isGitIgnored` now answers "is there a repository here?" from the filesystem
 * (via `gitFindRoot`) before it spawns anything, so these unit tests need cwds
 * whose *real* on-disk shape matches the case under test. `spawnSync` stays
 * mocked — no git binary runs — but `.git` has to actually exist for the
 * in-repository cases, and must not exist anywhere above the orphan case.
 */
function makeTempDir(prefix: string): string {
  return safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), prefix)));
}

/** A cwd that looks like a git repository to `gitFindRoot` (a `.git` entry exists). */
const CWD = makeTempDir('git-utils-repo-');
mkdirSyncReal(safePath.join(CWD, '.git'));

/** A cwd with no `.git` at any level — `mkdtemp` roots never have a git ancestor. */
const ORPHAN_CWD = makeTempDir('git-utils-orphan-');

afterAll(() => {
  for (const dir of [CWD, ORPHAN_CWD]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isGitIgnored', () => {
  it('returns true when git check-ignore exits 0 (file is ignored)', () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult(0));

    expect(isGitIgnored('node_modules/foo.js', CWD)).toBe(true);
  });

  it('returns false when git check-ignore exits 1 (file is not ignored)', () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult(1));

    expect(isGitIgnored('src/index.ts', CWD)).toBe(false);
  });

  it('returns true when exit 128 and ancestor walk finds a gitignored parent', () => {
    const filePath = 'data/symlink/deep/file.md';

    // Walk: file(128) -> data/symlink/deep(128) -> data/symlink(128) -> data(0=ignored)
    mockSpawnByPath({
      [filePath]: 128,
      [safePath.resolve(CWD, 'data/symlink/deep')]: 128,
      [safePath.resolve(CWD, 'data/symlink')]: 128,
      [safePath.resolve(CWD, 'data')]: 0,
    });

    expect(isGitIgnored(filePath, CWD)).toBe(true);
    // The walk is the whole point of this branch: file + three ancestors = 4 spawns.
    // Pinning the exact count means the `gitFindRoot` short-circuit cannot quietly
    // truncate the in-repository symlink recovery.
    expect(vi.mocked(spawnSync).mock.calls.length).toBe(4);
  });

  /**
   * The discriminating case for the `gitFindRoot` short-circuit.
   *
   * `git check-ignore` exits 128 for two unrelated conditions: "beyond a symbolic
   * link" and "not a git repository". The ancestor walk above is the recovery for
   * the first and a catastrophe for the second — outside a repository *every*
   * ancestor also exits 128, so the walk never breaks, climbs to the filesystem
   * root, and answers `false` after (1 + depth) subprocess spawns, per call.
   *
   * Both the old and the new implementation return `false` here, so the return
   * value cannot tell them apart — that is exactly why the bug survived. The spawn
   * COUNT can: (1 + depth) before, 0 after.
   */
  it('spawns nothing when cwd has no git repository above it', () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult(128));

    const filePath = safePath.join(ORPHAN_CWD, 'docs', 'guides', 'deep', 'file.md');

    expect(isGitIgnored(filePath, ORPHAN_CWD)).toBe(false);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it('still spawns for the ordinary in-repository check (short-circuit negative control)', () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult(1));

    expect(isGitIgnored('src/index.ts', CWD)).toBe(false);
    expect(vi.mocked(spawnSync).mock.calls.length).toBe(1);
  });

  it('returns false when exit 128 and ancestor walk is exhausted without finding ignored parent', () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult(128));

    expect(isGitIgnored('data/symlink/file.md', CWD)).toBe(false);
  });

  it('returns false when exit 128 and ancestor walk hits a tracked parent (exit 1)', () => {
    const filePath = 'src/symlink/deep/file.md';

    // Walk: file(128) -> src/symlink/deep(128) -> src/symlink(1=tracked, stop)
    // src should NOT be reached — exit 1 means parent is tracked, stop walking
    mockSpawnByPath({
      [filePath]: 128,
      [safePath.resolve(CWD, 'src/symlink/deep')]: 128,
      [safePath.resolve(CWD, 'src/symlink')]: 1,
      [safePath.resolve(CWD, 'src')]: 0, // should never reach this
    });

    expect(isGitIgnored(filePath, CWD)).toBe(false);

    // Verify we did NOT check 'src' (walk stopped at 'src/symlink')
    const checkedPaths = vi.mocked(spawnSync).mock.calls.map((c) => (c[1] as string[])[2]);
    expect(checkedPaths).not.toContain(safePath.resolve(CWD, 'src'));
  });

  it('returns false when git is not available (which.sync throws)', async () => {
    const whichModule = await import('which');
    vi.mocked(whichModule.default.sync).mockImplementation(() => {
      throw new Error('not found');
    });

    expect(isGitIgnored('file.md', CWD)).toBe(false);
  });
});
