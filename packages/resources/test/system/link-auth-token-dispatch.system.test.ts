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
import { isToolAvailable } from '@vibe-agent-toolkit/utils/process';
import { describe, it, expect } from 'vitest';

import { resolveToken } from '../../src/link-auth/resolve-token.js';

describe('System Test: linkAuth token command dispatch', () => {
  it('dispatches to real git binary and returns trimmed stdout (cross-platform smoke)', () => {
    // `git --version` returns a version string, not a token, but it exercises
    // the full spawn → trim → return path against a real binary. On Windows,
    // `git` is a `.cmd` shim so this covers the `shouldUseShell` path in
    // safe-exec.ts. git is required in CI (harness cloning depends on it), so
    // a hard assertion is correct here.
    const result = resolveToken([{ command: ['git', '--version'] }]);
    expect(result).toBeDefined();
    expect(result).toMatch(/^git version /);
  });

  it.skipIf(!isToolAvailable('gh'))('dispatches to real gh binary and returns trimmed stdout (cross-platform smoke)', () => {
    const result = resolveToken([{ command: ['gh', '--version'] }]);
    expect(result).toBeDefined();
    // gh version output: "gh version X.Y.Z (YYYY-MM-DD)\n..."
    expect(result).toMatch(/^gh version /);
  });

  it('GIT_* env vars are stripped before spawning — child process cannot see them (case-insensitive)', () => {
    // Whitebox check: spawn a node child that echoes both an uppercase and a
    // mixed-case GIT_* var back via stdout.write. If scrubbing regressed, the
    // child prints the poison; scrubbing means it prints the sentinels. Two
    // vars in one test to exercise both the canonical `GIT_DIR` and the
    // case-insensitive branch (`Git_Index_File` — matters on Windows where env
    // names are case-insensitive at the OS level).
    const savedGitDir = process.env['GIT_DIR'];
    const savedMixed = process.env['Git_Index_File'];
    process.env['GIT_DIR'] = 'POISONED_GIT_DIR_VALUE';
    process.env['Git_Index_File'] = 'POISONED_MIXED_CASE_VALUE';
    try {
      const script =
        "process.stdout.write((process.env.GIT_DIR ?? 'UNSET') + '|' + (process.env.Git_Index_File ?? 'UNSET'))";
      const result = resolveToken([{ command: ['node', '-e', script] }]);
      expect(result).toBe('UNSET|UNSET');
    } finally {
      if (savedGitDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = savedGitDir;
      if (savedMixed === undefined) delete process.env['Git_Index_File'];
      else process.env['Git_Index_File'] = savedMixed;
    }
  });

  it('non-GIT_* env vars ARE forwarded to the child — scrub is scoped, not indiscriminate', () => {
    // Positive-case complement of the scrub test: if a future regression
    // over-scrubbed (e.g. stripped everything, or every var starting with any
    // uppercase letter), the previous test would still pass but real-world
    // tools that need PATH / HOME / auth-provider vars would break silently.
    // Assert a synthetic non-GIT_* var reaches the child.
    const sentinel = '__VAT_LINKAUTH_ENV_FORWARD_PROBE__';
    const savedProbe = process.env[sentinel];
    process.env[sentinel] = 'reached-child';
    try {
      const script = `process.stdout.write(process.env['${sentinel}'] ?? 'MISSING')`;
      const result = resolveToken([{ command: ['node', '-e', script] }]);
      expect(result).toBe('reached-child');
    } finally {
      if (savedProbe === undefined) delete process.env[sentinel];
      else process.env[sentinel] = savedProbe;
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
