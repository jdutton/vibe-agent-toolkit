/**
 * Unit tests for runPreStageBuild — the optional shell command that runs once
 * before staging to generate build artifacts (e.g. bundled scripts not in source).
 *
 * Tests cover: command invoked with correct cwd; non-zero exit aborts and does NOT
 * call any continuation; no command configured → no exec attempted.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  BuildHookError,
  runPreStageBuild,
  type BuildHookOptions,
} from '../../src/skill-test/build-hook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG_ROOT = '/repo/root';
const TEST_BUILD_CMD = 'pnpm bundle:report';

function makeOptions(overrides: Partial<BuildHookOptions> = {}): BuildHookOptions {
  return {
    buildCommand: undefined,
    configRoot: TEST_CONFIG_ROOT,
    spawnFn: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPreStageBuild', () => {
  it('does nothing when buildCommand is not configured', () => {
    const spawnFn = vi.fn();
    runPreStageBuild(makeOptions({ buildCommand: undefined, spawnFn }));
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('invokes spawnFn with the configured command and configRoot as cwd', () => {
    const spawnFn = vi.fn().mockReturnValue({ status: 0 });
    runPreStageBuild(makeOptions({
      buildCommand: TEST_BUILD_CMD,
      configRoot: TEST_CONFIG_ROOT,
      spawnFn,
    }));
    expect(spawnFn).toHaveBeenCalledOnce();
    const [cmd, opts] = spawnFn.mock.calls[0] as [string, { shell: boolean; cwd: string; stdio: string }];
    expect(cmd).toBe(TEST_BUILD_CMD);
    expect(opts.cwd).toBe('/repo/root');
    expect(opts.shell).toBe(true);
    expect(opts.stdio).toBe('inherit');
  });

  it('throws BuildHookError with command name and exit code on non-zero exit', () => {
    const spawnFn = vi.fn().mockReturnValue({ status: 1 });
    expect(() =>
      runPreStageBuild(makeOptions({
        buildCommand: TEST_BUILD_CMD,
        spawnFn,
      })),
    ).toThrow(BuildHookError);
  });

  it('BuildHookError message contains the command and exit code', () => {
    const spawnFn = vi.fn().mockReturnValue({ status: 2 });
    let caught: unknown;
    try {
      runPreStageBuild(makeOptions({ buildCommand: 'node scripts/build.mjs', spawnFn }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BuildHookError);
    const err = caught as BuildHookError;
    expect(err.message).toContain('node scripts/build.mjs');
    expect(err.message).toContain('2');
  });

  it('maps to preflight (exit 2) via mapErrorToExitCode', async () => {
    const { mapErrorToExitCode } = await import('../../src/skill-test/exit-codes.js');
    const err = new BuildHookError('cmd failed with exit code 1: build', 1);
    expect(mapErrorToExitCode(err)).toBe(2);
  });
});
