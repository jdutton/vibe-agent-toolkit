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
  return {
    status,
    stdout,
    stderr: '',
    pid: 0,
    output: [],
    signal: null,
  };
}

const CWD = safePath.resolve('/project');
const CHECK_IGNORE = 'check-ignore';
const STDIN_FLAG = '--stdin';
const QUIET_FLAG = '-q';
const SYMLINK_FILE = 'data/symlink/file.md';
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

    // Walk: file -> data/symlink/deep -> data/symlink -> data
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const pathArg = (args as string[])[2];
      if (pathArg === filePath) {
        // Initial check on the file itself → exit 128 (beyond symlink)
        return makeSpawnResult(128);
      }
      // Ancestor: data/symlink/deep
      const deepDir = safePath.resolve(CWD, 'data/symlink/deep');
      if (pathArg === deepDir) {
        return makeSpawnResult(128);
      }
      // Ancestor: data/symlink
      const symlinkDir = safePath.resolve(CWD, 'data/symlink');
      if (pathArg === symlinkDir) {
        return makeSpawnResult(128);
      }
      // Ancestor: data → gitignored
      const dataDir = safePath.resolve(CWD, 'data');
      if (pathArg === dataDir) {
        return makeSpawnResult(0);
      }
      // Fallback
      return makeSpawnResult(1);
    });

    expect(isGitIgnored(filePath, CWD)).toBe(true);

    // Verify we checked the file + ancestors (at least 2 calls)
    expect(vi.mocked(spawnSync).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns false when exit 128 and ancestor walk is exhausted without finding ignored parent', () => {
    // All calls return 128 until we hit cwd
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult(128));

    expect(isGitIgnored(SYMLINK_FILE, CWD)).toBe(false);
  });

  it('returns false when exit 128 and ancestor walk hits a tracked parent (exit 1)', () => {
    const filePath = 'src/symlink/deep/file.md';

    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const pathArg = (args as string[])[2];
      if (pathArg === filePath) {
        return makeSpawnResult(128); // File beyond symlink
      }
      // deep dir → also behind symlink
      const deepDir = safePath.resolve(CWD, 'src/symlink/deep');
      if (pathArg === deepDir) {
        return makeSpawnResult(128);
      }
      // symlink dir → tracked (exit 1), stop walking
      const symlinkDir = safePath.resolve(CWD, 'src/symlink');
      if (pathArg === symlinkDir) {
        return makeSpawnResult(1);
      }
      // src dir — should NOT be reached
      return makeSpawnResult(0);
    });

    const result = isGitIgnored(filePath, CWD);
    expect(result).toBe(false);

    // Verify we did NOT check 'src' (the walk should have stopped at 'src/symlink')
    const checkedPaths = vi.mocked(spawnSync).mock.calls.map((c) => (c[1] as string[])[2]);
    const srcDir = safePath.resolve(CWD, 'src');
    expect(checkedPaths).not.toContain(srcDir);
  });

  it('returns false when git is not available (which.sync throws)', async () => {
    // Re-mock which to throw
    const whichModule = await import('which');
    vi.mocked(whichModule.default.sync).mockImplementation(() => {
      throw new Error('not found');
    });

    expect(isGitIgnored('file.md', CWD)).toBe(false);
  });
});

describe('gitCheckIgnoredBatch', () => {
  it('returns correct map for normal batch check', () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const argsArray = args as string[];
      if (argsArray[0] === CHECK_IGNORE && argsArray[1] === STDIN_FLAG) {
        // Batch mode: return only ignored files in stdout
        return makeSpawnResult(0, 'dist/bar.js\nnode_modules/baz.js\n');
      }
      // Per-file fallback (isGitIgnored) — not ignored
      return makeSpawnResult(1);
    });

    const files = ['src/foo.ts', 'dist/bar.js', 'node_modules/baz.js'];
    const result = gitCheckIgnoredBatch(files, CWD);

    expect(result.get('src/foo.ts')).toBe(false);
    expect(result.get('dist/bar.js')).toBe(true);
    expect(result.get('node_modules/baz.js')).toBe(true);
  });

  it('uses isGitIgnored fallback for symlink paths missed by batch', () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const argsArray = args as string[];
      if (argsArray[0] === CHECK_IGNORE && argsArray[1] === STDIN_FLAG) {
        // Batch mode: symlink path silently skipped, only dist/ reported
        return makeSpawnResult(0, `${DIST_OUT}\n`);
      }
      // Per-file isGitIgnored fallback calls use ['check-ignore', '-q', path]
      if (argsArray[0] === CHECK_IGNORE && argsArray[1] === QUIET_FLAG) {
        const pathArg = argsArray[2];
        if (pathArg === SYMLINK_FILE) {
          // Initial check → exit 128 (beyond symlink)
          return makeSpawnResult(128);
        }
        // Ancestor: data → gitignored
        const dataDir = safePath.resolve(CWD, 'data');
        if (pathArg === dataDir) {
          return makeSpawnResult(0);
        }
        // Any other ancestor → also 128
        return makeSpawnResult(128);
      }
      return makeSpawnResult(1);
    });

    const files = ['src/ok.ts', DIST_OUT, SYMLINK_FILE];
    const result = gitCheckIgnoredBatch(files, CWD);

    expect(result.get('src/ok.ts')).toBe(false);
    expect(result.get(DIST_OUT)).toBe(true);
    expect(result.get(SYMLINK_FILE)).toBe(true);
  });

  it('returns empty map for empty input', () => {
    const result = gitCheckIgnoredBatch([], CWD);
    expect(result.size).toBe(0);
    // spawnSync should not be called at all
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });
});
