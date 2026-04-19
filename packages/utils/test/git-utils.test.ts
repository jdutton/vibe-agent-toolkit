/**
 * Unit tests for git-utils: isGitIgnored ancestor walk and gitCheckIgnoredBatch symlink fallback.
 */

import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { safePath } from '../src/path-utils.js';

// Mock modules before importing the code under test
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('which', () => ({
  default: { sync: vi.fn().mockReturnValue('/usr/bin/git') },
}));

// Import after mocks are set up
const { isGitIgnored, gitCheckIgnoredBatch } = await import('../src/git-utils.js');

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

const CWD = safePath.resolve('/project');
const DIST_OUT = 'dist/out.js';

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
    expect(vi.mocked(spawnSync).mock.calls.length).toBeGreaterThanOrEqual(2);
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

describe('gitCheckIgnoredBatch', () => {
  it('returns correct map for normal batch check', () => {
    mockSpawnByPath({}, { batchStdout: 'dist/bar.js\nnode_modules/baz.js\n' });

    const files = ['src/foo.ts', 'dist/bar.js', 'node_modules/baz.js'];
    const result = gitCheckIgnoredBatch(files, CWD);

    expect(result.get('src/foo.ts')).toBe(false);
    expect(result.get('dist/bar.js')).toBe(true);
    expect(result.get('node_modules/baz.js')).toBe(true);
  });

  it('uses isGitIgnored fallback when batch errors on symlink paths (exit 128)', () => {
    const symlinkFile = 'data/symlink/file.md';

    // When a batch input traverses a gitignored symlink, `git check-ignore
    // --stdin` exits 128 (fatal) with partial results. Under that code path,
    // the per-path fallback kicks in and resolves each path via
    // isGitIgnored()'s ancestor walk.
    const fallbackPaths: Record<string, number> = {
      // Top-level paths passed to isGitIgnored are the raw strings from
      // filePaths; ancestor walk resolves them and uses absolute paths.
      'src/ok.ts': 1,
      [DIST_OUT]: 0,
      [symlinkFile]: 128,
      [safePath.resolve(CWD, 'data/symlink')]: 128,
      [safePath.resolve(CWD, 'data')]: 0,
    };

    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const argsArray = args as string[];
      // Batch mode: simulate fatal error, no stdout
      if (argsArray[1] === '--stdin') {
        return makeSpawnResult(128, '');
      }
      // Per-path mode
      const pathArg = argsArray[2];
      if (pathArg !== undefined && pathArg in fallbackPaths) {
        return makeSpawnResult(fallbackPaths[pathArg] as number);
      }
      return makeSpawnResult(1);
    });

    const files = ['src/ok.ts', DIST_OUT, symlinkFile];
    const result = gitCheckIgnoredBatch(files, CWD);

    expect(result.get('src/ok.ts')).toBe(false);
    expect(result.get(DIST_OUT)).toBe(true);
    expect(result.get(symlinkFile)).toBe(true);
  });

  it('skips the per-path fallback when batch succeeds cleanly (exit 0 or 1)', () => {
    // When the batch call returns exit 0 (some ignored) or 1 (none ignored),
    // the results are authoritative per git's documented behavior. We must
    // NOT re-invoke git per non-ignored path — that's the hot path that
    // dominated `vat audit .` wall time before the fix.
    mockSpawnByPath({}, { batchStdout: `${DIST_OUT}\n` });

    const files = ['src/ok.ts', DIST_OUT];
    const result = gitCheckIgnoredBatch(files, CWD);

    expect(result.get('src/ok.ts')).toBe(false);
    expect(result.get(DIST_OUT)).toBe(true);

    // Exactly one spawn: the batch call. No per-path fallback.
    expect(vi.mocked(spawnSync).mock.calls).toHaveLength(1);
  });

  it('returns empty map for empty input', () => {
    const result = gitCheckIgnoredBatch([], CWD);
    expect(result.size).toBe(0);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });
});
