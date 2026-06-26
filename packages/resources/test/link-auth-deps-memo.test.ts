import { describe, expect, it, vi } from 'vitest';

import { wrapLinkAuthDepsWithMemo } from '../src/link-auth-deps-memo.js';

const STDOUT_TOKEN = 'gh_token_xyz';

describe('wrapLinkAuthDepsWithMemo', () => {
  it('calls the underlying runCommand at most once per unique argv (single source)', () => {
    const runCommand = vi.fn(() => ({ success: true as const, stdout: STDOUT_TOKEN }));
    const wrapped = wrapLinkAuthDepsWithMemo({ runCommand });

    const r1 = wrapped.runCommand?.(['gh', 'auth', 'token']);
    const r2 = wrapped.runCommand?.(['gh', 'auth', 'token']);
    const r3 = wrapped.runCommand?.(['gh', 'auth', 'token']);

    expect(runCommand).toHaveBeenCalledTimes(1);
    // External constants: every wrapped result must equal the underlying
    // success object. NOT compared to wrapped()'s own output (self-referential).
    expect(r1).toEqual({ success: true, stdout: STDOUT_TOKEN });
    expect(r2).toEqual({ success: true, stdout: STDOUT_TOKEN });
    expect(r3).toEqual({ success: true, stdout: STDOUT_TOKEN });
  });

  it('caches distinct argv tuples independently (two providers, two commands)', () => {
    const runCommand = vi.fn((argv: readonly string[]) => ({
      success: true as const,
      stdout: argv.join('-'),
    }));
    const wrapped = wrapLinkAuthDepsWithMemo({ runCommand });

    wrapped.runCommand?.(['gh', 'auth', 'token']);
    wrapped.runCommand?.(['gh', 'auth', 'token']);
    wrapped.runCommand?.(['az', 'account', 'get-access-token']);
    wrapped.runCommand?.(['az', 'account', 'get-access-token']);

    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('falls back to the engine defaultRunCommand when deps does not supply one', () => {
    // Pass empty deps — wrapper must still expose a runCommand that goes
    // through the engine default. Test by running a harmless real command and
    // asserting we get a stdout back.
    const wrapped = wrapLinkAuthDepsWithMemo({});
    const result = wrapped.runCommand?.(['node', '--version']);
    expect(result?.success).toBe(true);
    expect(result?.stdout).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('preserves other deps fields (only runCommand is wrapped)', () => {
    const env = { GH_TOKEN: 'real' };
    const runCommand = vi.fn(() => ({ success: true as const, stdout: '' }));
    const wrapped = wrapLinkAuthDepsWithMemo({ env, runCommand });
    expect(wrapped.env).toBe(env);
  });

  it('handles undefined deps by wrapping defaultRunCommand alone', () => {
    const wrapped = wrapLinkAuthDepsWithMemo(undefined);
    expect(typeof wrapped.runCommand).toBe('function');
  });
});
