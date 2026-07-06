/**
 * System test: token command dispatch via the real OS process layer.
 *
 * Exercises `resolveToken` with actual binaries — `git --version` (always
 * available in CI) and `gh --version` (skipped when not installed). On Windows,
 * both binaries are `.cmd` shims and the spawn path goes through `shouldUseShell`
 * in `safe-exec.ts`. This test exists precisely to catch cross-platform dispatch
 * regressions that unit tests (with injected `runCommand`) cannot catch.
 *
 * Also verifies GIT_* env scrubbing behaviorally (by inspecting what the child
 * process sees) and the `VAT_LINKAUTH_ALLOW_COMMAND=0` opt-out via real
 * `process.env` interaction.
 */
import { describe, it, expect } from 'vitest';

import { resolveToken } from '../../src/link-auth/resolve-token.js';
import { isToolAvailable } from '../../src/safe-exec.js';

describe('System Test: linkAuth token command dispatch', () => {
  it('resolves a token via real git binary (git --version)', () => {
    // git is required in CI — if it's absent the test harness cannot even clone
    // the repo, so a hard assertion is correct here.
    const result = resolveToken([{ command: ['git', '--version'] }]);
    expect(result).toBeDefined();
    expect(result).toMatch(/^git version /);
  });

  it.skipIf(!isToolAvailable('gh'))('resolves a token via real gh binary (gh --version)', () => {
    const result = resolveToken([{ command: ['gh', '--version'] }]);
    expect(result).toBeDefined();
    // gh version output: "gh version X.Y.Z (YYYY-MM-DD)\n..."
    expect(result).toMatch(/^gh version /);
  });

  it('GIT_* env vars are stripped before spawning — child process cannot see them', () => {
    // Whitebox check: spawn a node child that echoes GIT_DIR back via
    // stdout.write (no color codes, unlike `node -p` which colorizes undefined).
    // If scrubbing regressed, the child prints the poison; scrubbing means it
    // prints the sentinel. This is what unblocks `gh auth token` inside a
    // pre-commit hook, where git pre-sets GIT_DIR / GIT_WORK_TREE / etc.
    const savedGitDir = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = 'POISONED_GIT_DIR_VALUE';
    try {
      const result = resolveToken([
        { command: ['node', '-e', "process.stdout.write(process.env.GIT_DIR ?? 'GIT_DIR_NOT_SET')"] },
      ]);
      expect(result).toBe('GIT_DIR_NOT_SET');
    } finally {
      if (savedGitDir === undefined) {
        delete process.env['GIT_DIR'];
      } else {
        process.env['GIT_DIR'] = savedGitDir;
      }
    }
  });

  it('VAT_LINKAUTH_ALLOW_COMMAND=0 skips command sources via real process.env', () => {
    // Verifies the runtime env-var read in resolveToken. Unit tests can pin the
    // `allowCommand` prop directly but cannot cover the ambient env pathway.
    const saved = process.env['VAT_LINKAUTH_ALLOW_COMMAND'];
    process.env['VAT_LINKAUTH_ALLOW_COMMAND'] = '0';
    try {
      // git --version would resolve if allowCommand defaulted to true; with the
      // opt-out set to '0' the source is skipped and resolveToken returns
      // undefined (no other sources supplied).
      const result = resolveToken([{ command: ['git', '--version'] }]);
      expect(result).toBeUndefined();
    } finally {
      if (saved === undefined) {
        delete process.env['VAT_LINKAUTH_ALLOW_COMMAND'];
      } else {
        process.env['VAT_LINKAUTH_ALLOW_COMMAND'] = saved;
      }
    }
  });

  it('VAT_LINKAUTH_ALLOW_COMMAND unset (default) allows command sources', () => {
    // Complement of the previous test — pins the default-allow behavior against
    // real process.env, so a regression that flipped the default to opt-in
    // would be caught here.
    const saved = process.env['VAT_LINKAUTH_ALLOW_COMMAND'];
    delete process.env['VAT_LINKAUTH_ALLOW_COMMAND'];
    try {
      const result = resolveToken([{ command: ['git', '--version'] }]);
      expect(result).toMatch(/^git version /);
    } finally {
      if (saved !== undefined) {
        process.env['VAT_LINKAUTH_ALLOW_COMMAND'] = saved;
      }
    }
  });

  it('returns undefined for env-only sources when env var is absent', () => {
    // Sanity check: the env path works correctly via the real dep defaults too
    const result = resolveToken([{ env: '__VAT_LINKAUTH_TEST_ABSENT__' }]);
    expect(result).toBeUndefined();
  });
});
