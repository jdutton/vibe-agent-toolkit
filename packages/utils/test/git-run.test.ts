/**
 * `runGit` is the chokepoint that makes git safe by default, and
 * `safeExecSync`/`safeExecResult` refuse git so nobody can route around it.
 *
 * These are the properties that make the guarantee real rather than documented:
 * an unsafe call is impossible to write through the generic helper, and the safe
 * one does not need the caller to remember anything.
 */

import { describe, expect, it } from 'vitest';

import { runGit, runGitOrThrow } from '../src/git-run.js';
import {
  getToolVersion,
  isToolAvailable,
  safeExecResult,
  safeExecSync,
} from '../src/safe-exec.js';

describe('safeExec* refuse git', () => {
  it.each([
    ['safeExecSync', () => safeExecSync('git', ['--version'])],
    // `safeExecResult` is documented not to throw. The refusal is deliberately
    // the one exception: folded into its result it would read as "git is
    // unavailable", and its callers treat a failure as information and carry on.
    ['safeExecResult', () => safeExecResult('git', ['--version'])],
  ])('%s throws and names runGit', (_label, call) => {
    expect(call).toThrow(/runGit\(\)/);
  });

  it.each(['git.exe', 'git.cmd', '/usr/bin/git', String.raw`C:\Program Files\Git\bin\git`])(
    'refuses %s too, so the spelling is not an escape hatch',
    (spelling) => {
      expect(() => safeExecResult(spelling, ['--version'])).toThrow(/runGit\(\)/);
    },
  );

  it('still runs a non-git command, so the refusal is not a blanket block', () => {
    const result = safeExecResult(process.execPath, ['--version']);
    expect(result.success).toBe(true);
  });

  it('yields to allowGit, the one deliberate opt-out', () => {
    // For an argv the OPERATOR configured — `link-auth`'s token command — where
    // "say which repository you mean" has nobody to ask, and where that caller
    // strips every GIT_* key rather than runGit's targeted subset. Pinned so the
    // hatch stays visible: it is the only way past the refusal, and a second
    // caller reaching for it should have to change this test.
    expect(() => safeExecResult('git', ['--version'], { allowGit: true })).not.toThrow();
  });

  it('does not refuse a command that merely contains "git"', () => {
    // `gitleaks` is a real tool this repo shells out to. A substring match would
    // break it, and would do so only on the machines that have it installed.
    expect(() => safeExecResult('gitleaks-does-not-exist', ['--version'])).not.toThrow(
      /runGit\(\)/,
    );
  });
});

describe('the refusal does not reach the version probes', () => {
  // These two ask a *binary* its version — they name no repository, so the
  // refusal is wrong for them, and wrong silently: both report absence as a
  // null/false that their callers render as "not installed". `vat doctor` said
  // exactly that about a perfectly good git before this was fixed.
  it('getToolVersion reports git rather than null', () => {
    expect(getToolVersion('git')).toMatch(/^git version /);
  });

  it('honours a custom version argument for git', () => {
    expect(getToolVersion('git', 'version')).toMatch(/^git version /);
  });

  it('isToolAvailable finds git', () => {
    expect(isToolAvailable('git')).toBe(true);
  });

  it('still reports a genuinely absent tool as absent', () => {
    // The negative control: without it, a probe that returned a constant would
    // pass all three above.
    expect(getToolVersion('nonexistent-tool-xyz-123')).toBeNull();
    expect(isToolAvailable('nonexistent-tool-xyz-123')).toBe(false);
  });
});

describe('runGit', () => {
  it('reports a non-zero exit as not-ok rather than throwing', () => {
    const result = runGit(['rev-parse', '--verify', 'refs/heads/no-such-branch-xyzzy']);
    expect(result.ok).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('reports an unknown subcommand without throwing', () => {
    const result = runGit(['definitely-not-a-subcommand']);
    expect(result.ok).toBe(false);
    expect(result.status).toBeGreaterThan(0);
  });

  it('rejects an empty argument list instead of running bare git', () => {
    const result = runGit([]);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('surfaces a truncated read as a failure, not as a short answer', () => {
    // Shrinking the cap reproduces the real ENOBUFS fault in milliseconds. The
    // opposite approach — growing a fixture until it overruns the 1 MiB default
    // — costs seconds locally and far more in CI, and is why this class of bug
    // went unnoticed: `spawnSync` can leave `status: 0` with truncated stdout,
    // so an exit-code check calls a partial answer a successful one.
    const result = runGit(['--version'], { maxBuffer: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns trimmed stdout on success', () => {
    const result = runGit(['--version']);
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/^git version /);
    expect(result.stdout).toBe(result.stdout.trim());
  });
});

describe('runGitOrThrow', () => {
  it('returns stdout on success', () => {
    expect(runGitOrThrow(['--version'])).toMatch(/^git version /);
  });

  it('throws on failure, naming the subcommand and not the whole argv', () => {
    expect(() => runGitOrThrow(['definitely-not-a-subcommand'])).toThrow(
      /git definitely-not-a-subcommand failed/,
    );
  });
});
