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

  it('uses isGitIgnored fallback for symlink paths missed by batch', () => {
    const symlinkFile = 'data/symlink/file.md';
    const distOut = 'dist/out.js';

    // Batch reports only dist/out.js; symlink path silently skipped.
    // Per-file fallback: symlink file → 128, ancestor data/ → 0 (ignored)
    mockSpawnByPath(
      {
        [symlinkFile]: 128,
        [safePath.resolve(CWD, 'data')]: 0,
      },
      { batchStdout: `${distOut}\n`, fallbackStatus: 128 },
    );

    const files = ['src/ok.ts', distOut, symlinkFile];
    const result = gitCheckIgnoredBatch(files, CWD);

    expect(result.get('src/ok.ts')).toBe(false);
    expect(result.get(distOut)).toBe(true);
    expect(result.get(symlinkFile)).toBe(true);
  });

  it('returns empty map for empty input', () => {
    const result = gitCheckIgnoredBatch([], CWD);
    expect(result.size).toBe(0);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });
});
