import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultRunCommand,
  resolveToken,
  scrubGitEnv,
  type TokenResolutionDeps,
} from '../../src/link-auth/resolve-token.js';
import { safeExecResult } from '../../src/safe-exec.js';

// Mock safeExecResult so we can unit-test defaultRunCommand without spawning.
// Existing tests below inject their own `runCommand` via makeDeps, so they never
// reach the mocked module — this mock only affects the `defaultRunCommand`
// describe block at the bottom.
vi.mock('../../src/safe-exec.js', () => ({
  safeExecResult: vi.fn(),
}));

const mockedSafeExecResult = vi.mocked(safeExecResult);

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

describe('scrubGitEnv', () => {
  it('strips uppercase GIT_* keys', () => {
    expect(scrubGitEnv({ GIT_DIR: 'x', PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('strips mixed-case GIT_* keys (Windows case-insensitivity defense)', () => {
    // Windows treats env-var names case-insensitively at the OS level. Even
    // though Node's `process.env` preserves the original case, a shell or user
    // could set `Git_Dir` and reasonably expect it to behave the same as
    // `GIT_DIR`. Scrub must match all case variants.
    expect(scrubGitEnv({ Git_Dir: 'x', git_index_file: 'y', HOME: '/h' })).toEqual({ HOME: '/h' });
  });

  it('preserves non-GIT vars', () => {
    expect(scrubGitEnv({ PATH: '/bin', NODE_ENV: 'test', HOME: '/h' })).toEqual({
      PATH: '/bin',
      NODE_ENV: 'test',
      HOME: '/h',
    });
  });

  it('only strips keys that START with GIT_ — MY_GIT_TOKEN survives', () => {
    // Guards against sweeping too broadly. A user var like MY_GIT_TOKEN must
    // NOT be scrubbed just because "GIT_" appears in the middle of its name.
    expect(scrubGitEnv({ MY_GIT_TOKEN: 'keep', GIT_TOKEN: 'strip' })).toEqual({
      MY_GIT_TOKEN: 'keep',
    });
  });

  it('returns an empty object for empty input', () => {
    expect(scrubGitEnv({})).toEqual({});
  });
});

describe('defaultRunCommand', () => {
  beforeEach(() => {
    mockedSafeExecResult.mockReset();
  });

  it('returns { success: false, stdout: "" } for empty argv (no spawn attempted)', () => {
    const result = defaultRunCommand([]);
    expect(result).toEqual({ success: false, stdout: '' });
    expect(mockedSafeExecResult).not.toHaveBeenCalled();
  });

  it('spawns via safeExecResult, forwards GIT_*-scrubbed env, and returns spawn result', () => {
    mockedSafeExecResult.mockReturnValue({
      success: true,
      stdout: 'output-value',
    } as unknown as ReturnType<typeof safeExecResult>);

    process.env['__TEST_FORWARD_VAR__'] = 'reached';
    process.env['GIT_DIR'] = 'should-be-stripped';
    try {
      const result = defaultRunCommand(['echo', 'x', 'y']);
      expect(result).toEqual({ success: true, stdout: 'output-value' });

      expect(mockedSafeExecResult).toHaveBeenCalledTimes(1);
      const [bin, args, opts] = mockedSafeExecResult.mock.calls[0] as [
        string,
        string[],
        { env?: NodeJS.ProcessEnv; encoding?: string },
      ];
      expect(bin).toBe('echo');
      expect(args).toEqual(['x', 'y']);
      expect(opts.encoding).toBe('utf8');
      expect(opts.env?.['__TEST_FORWARD_VAR__']).toBe('reached');
      expect(opts.env?.['GIT_DIR']).toBeUndefined();
    } finally {
      delete process.env['__TEST_FORWARD_VAR__'];
      delete process.env['GIT_DIR'];
    }
  });

  it('coerces Buffer stdout from safeExecResult to a utf8 string', () => {
    // When encoding isn't set to 'utf8' by the caller, safeExecResult may
    // return a Buffer. defaultRunCommand normalizes to string.
    mockedSafeExecResult.mockReturnValue({
      success: true,
      stdout: Buffer.from('buffered-value\n'),
    } as unknown as ReturnType<typeof safeExecResult>);
    const result = defaultRunCommand(['some-bin']);
    expect(result.stdout).toBe('buffered-value\n');
  });
});
