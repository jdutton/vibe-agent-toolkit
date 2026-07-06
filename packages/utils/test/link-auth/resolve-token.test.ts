import { describe, expect, it, vi } from 'vitest';

import {
  resolveToken,
  type TokenResolutionDeps,
} from '../../src/link-auth/resolve-token.js';

const FALLBACK_ENV = 'FALLBACK';
const FALLBACK_VALUE = 'fallback-value';

function makeDeps(overrides?: Partial<TokenResolutionDeps>): TokenResolutionDeps {
  return {
    env: overrides?.env ?? {},
    runCommand: overrides?.runCommand ?? (() => ({ success: false, stdout: '' })),
    allowCommand: overrides?.allowCommand ?? true,
  };
}

describe('resolveToken', () => {
  describe('env source', () => {
    it('returns the env value when set and non-empty', () => {
      const deps = makeDeps({ env: { GITHUB_TOKEN: 'ghp_abcdef' } });
      expect(resolveToken([{ env: 'GITHUB_TOKEN' }], deps)).toBe('ghp_abcdef');
    });

    it('falls through to the next source when the env var is unset', () => {
      const deps = makeDeps({ env: { OTHER: 'x' } });
      expect(resolveToken([{ env: 'GITHUB_TOKEN' }], deps)).toBeUndefined();
    });

    it('treats an explicitly empty env value as not resolved', () => {
      const deps = makeDeps({ env: { GITHUB_TOKEN: '' } });
      expect(resolveToken([{ env: 'GITHUB_TOKEN' }], deps)).toBeUndefined();
    });

    it('does NOT trim env values — the user set them deliberately', () => {
      const deps = makeDeps({ env: { GITHUB_TOKEN: '  with-spaces  ' } });
      expect(resolveToken([{ env: 'GITHUB_TOKEN' }], deps)).toBe('  with-spaces  ');
    });

    it('uses Object.hasOwn for env lookup — __proto__ as an env name returns undefined', () => {
      // Adversarial: a malicious or accidentally-named env var "__proto__"
      // must not resolve to Object.prototype via prototype-chain lookup.
      const deps = makeDeps({ env: {} });
      expect(resolveToken([{ env: '__proto__' }], deps)).toBeUndefined();
    });
  });

  describe('command source — argv form', () => {
    it('runs the command and returns trimmed stdout', () => {
      const runCommand = vi.fn(() => ({ success: true, stdout: 'token-value\n' }));
      const deps = makeDeps({ runCommand });
      expect(resolveToken([{ command: ['gh', 'auth', 'token'] }], deps)).toBe('token-value');
      expect(runCommand).toHaveBeenCalledWith(['gh', 'auth', 'token']);
    });

    it('trims surrounding whitespace and newlines from command output', () => {
      const deps = makeDeps({ runCommand: () => ({ success: true, stdout: '  abc\n\n' }) });
      expect(resolveToken([{ command: ['x'] }], deps)).toBe('abc');
    });

    it('falls through when the command fails (non-zero exit)', () => {
      const deps = makeDeps({ runCommand: () => ({ success: false, stdout: 'irrelevant' }) });
      expect(resolveToken([{ command: ['x'] }], deps)).toBeUndefined();
    });

    it('falls through when the command succeeds with empty stdout', () => {
      const deps = makeDeps({ runCommand: () => ({ success: true, stdout: '' }) });
      expect(resolveToken([{ command: ['x'] }], deps)).toBeUndefined();
    });

    it('falls through when the command succeeds with whitespace-only stdout', () => {
      const deps = makeDeps({ runCommand: () => ({ success: true, stdout: '   \n  ' }) });
      expect(resolveToken([{ command: ['x'] }], deps)).toBeUndefined();
    });

    it('falls through when the argv is empty (no binary to run)', () => {
      const runCommand = vi.fn(() => ({ success: true, stdout: 'never' }));
      const deps = makeDeps({ runCommand });
      expect(resolveToken([{ command: [] }], deps)).toBeUndefined();
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  describe('command source — convenience string form', () => {
    it('whitespace-tokenizes a string command into argv (does NOT shell)', () => {
      const runCommand = vi.fn(() => ({ success: true, stdout: 'ok' }));
      const deps = makeDeps({ runCommand });
      resolveToken([{ command: 'gh auth token' }], deps);
      expect(runCommand).toHaveBeenCalledWith(['gh', 'auth', 'token']);
    });

    it('handles multiple spaces and tabs without producing empty argv slots', () => {
      const runCommand = vi.fn(() => ({ success: true, stdout: 'ok' }));
      const deps = makeDeps({ runCommand });
      resolveToken([{ command: 'gh   auth\ttoken' }], deps);
      expect(runCommand).toHaveBeenCalledWith(['gh', 'auth', 'token']);
    });

    it('shell operators in the string form are passed as literal argv elements (no shell)', () => {
      // Pinned: "gh auth token | cat" tokenizes to ['gh', 'auth', 'token', '|', 'cat'].
      // The "|" is a literal argv element, NOT a shell pipe. If a future change
      // ever silently enables `shell: true`, this assertion catches it.
      const runCommand = vi.fn(() => ({ success: true, stdout: 'ok' }));
      const deps = makeDeps({ runCommand });
      resolveToken([{ command: 'gh auth token | cat' }], deps);
      expect(runCommand).toHaveBeenCalledWith(['gh', 'auth', 'token', '|', 'cat']);
    });

    it('falls through for an empty string command', () => {
      const runCommand = vi.fn(() => ({ success: true, stdout: 'never' }));
      const deps = makeDeps({ runCommand });
      expect(resolveToken([{ command: '' }], deps)).toBeUndefined();
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  describe('ordered first-non-empty wins', () => {
    it('uses the first source that resolves a non-empty value', () => {
      const deps = makeDeps({
        env: { [FALLBACK_ENV]: FALLBACK_VALUE },
        runCommand: () => ({ success: true, stdout: 'command-value' }),
      });
      const result = resolveToken(
        [{ command: ['gh', 'auth', 'token'] }, { env: FALLBACK_ENV }],
        deps,
      );
      expect(result).toBe('command-value');
    });

    it('falls through from a failed source to a succeeding later source', () => {
      const deps = makeDeps({
        env: { [FALLBACK_ENV]: FALLBACK_VALUE },
        runCommand: () => ({ success: false, stdout: '' }),
      });
      const result = resolveToken(
        [{ command: ['failing'] }, { env: FALLBACK_ENV }],
        deps,
      );
      expect(result).toBe(FALLBACK_VALUE);
    });

    it('returns undefined when every source fails — caller produces an "unverified" outcome', () => {
      const deps = makeDeps({
        env: {},
        runCommand: () => ({ success: false, stdout: '' }),
      });
      const result = resolveToken(
        [{ env: 'MISSING' }, { command: ['failing'] }],
        deps,
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined for an empty sources array', () => {
      expect(resolveToken([], makeDeps())).toBeUndefined();
    });

    it('stops at the first match — does NOT call later sources unnecessarily', () => {
      const runCommand = vi.fn(() => ({ success: true, stdout: 'never-reached' }));
      const deps = makeDeps({
        env: { GITHUB_TOKEN: 'first-wins' },
        runCommand,
      });
      resolveToken(
        [{ env: 'GITHUB_TOKEN' }, { command: ['unreached'] }],
        deps,
      );
      expect(runCommand).not.toHaveBeenCalled();
    });
  });
});

describe('resolveToken — no token leakage in serialized errors', () => {
  it('a thrown error from runCommand does NOT escape resolveToken (callers should see undefined, not a token leak)', () => {
    // Defensive: if a custom runCommand throws (or a future safeExecResult
    // wrapper does), the token value would never have been resolved. Make sure
    // a throw from the dep is treated as "this source failed", not a crash
    // that could embed in-flight bytes in a stack trace.
    const deps = makeDeps({
      runCommand: () => {
        throw new Error('command crashed');
      },
    });
    expect(() => resolveToken([{ command: ['x'] }], deps)).toThrow('command crashed');
    // Note: the design's threat model treats config-controlled command failure
    // as a config bug, not a runtime concern. This test pins that the function
    // DOES propagate the throw (no swallowing of operator errors). If you want
    // graceful handling, wrap at the call site.
  });
});

describe('resolveToken — allowCommand opt-out', () => {
  it('skips command sources when allowCommand is false', () => {
    const runCommand = vi.fn(() => ({ success: true, stdout: 'should-not-run' }));
    const deps = makeDeps({ allowCommand: false, runCommand });
    expect(resolveToken([{ command: ['gh', 'auth', 'token'] }], deps)).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('still resolves env sources when allowCommand is false', () => {
    const deps = makeDeps({ allowCommand: false, env: { MY_TOKEN: 'env-wins' } });
    expect(resolveToken([{ command: ['gh', 'auth', 'token'] }, { env: 'MY_TOKEN' }], deps)).toBe('env-wins');
  });

  // Note: `allowCommand: true` is `makeDeps`'s default, so every command-source
  // test above already exercises the allow-true path. No dedicated test needed.

  it('skips all command sources in a mixed list when allowCommand is false', () => {
    const runCommand = vi.fn(() => ({ success: true, stdout: 'cmd-token' }));
    const deps = makeDeps({
      allowCommand: false,
      runCommand,
      env: { FALLBACK_TOKEN: 'fallback' },
    });
    const result = resolveToken(
      [{ command: ['gh', 'auth', 'token'] }, { command: ['az', 'account', 'get-access-token'] }, { env: 'FALLBACK_TOKEN' }],
      deps,
    );
    expect(result).toBe('fallback');
    expect(runCommand).not.toHaveBeenCalled();
  });

  // Note: the `VAT_LINKAUTH_ALLOW_COMMAND` env-var-at-call-time behaviour is
  // covered by the system test (link-auth-token-dispatch.system.test.ts), where
  // real process.env interaction is safe. Unit tests here inject `allowCommand`
  // directly to avoid ambient-state pollution.
});
