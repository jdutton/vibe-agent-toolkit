/**
 * `symlinkCapability` probes once and memoizes for the whole process, so what
 * it reads as "no" matters more than usual: a `null` here silently `skip()`s
 * every symlink test for the rest of the run. It used to `catch { null }` the
 * probe `symlinkSync`, which made "this host cannot create symlinks" (`EPERM`
 * on Windows without Developer Mode, `ENOTSUP` on a filesystem without them)
 * indistinguishable from "the tmpdir is unwritable / missing / a bug" — a
 * process-wide skip for a reason nothing reported.
 *
 * `node:fs` is mocked for `symlinkSync` only, with a knob for what it throws;
 * every other fs call, and every un-knobbed `symlinkSync`, is the real one. The
 * module is re-imported per case because the memo is module state.
 */
import type fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSymlinkFailure, setSymlinkFailure } = vi.hoisted(() => {
  let failure: string | null = null;
  return {
    getSymlinkFailure: (): string | null => failure,
    setSymlinkFailure: (code: string | null): void => {
      failure = code;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const symlinkSync = ((...args: Parameters<typeof actual.symlinkSync>) => {
    const code = getSymlinkFailure();
    if (code !== null) throw Object.assign(new Error(`${code}: simulated, symlink`), { code });
    return actual.symlinkSync(...args);
  }) as typeof actual.symlinkSync;
  return { ...actual, symlinkSync, default: { ...actual, symlinkSync } };
});

async function freshSymlinkCapability(): Promise<() => unknown> {
  vi.resetModules();
  const mod = await import('../src/test-helpers.js');
  return mod.symlinkCapability;
}

describe('symlinkCapability: only "this host cannot make symlinks" is a no', () => {
  beforeEach(() => setSymlinkFailure(null));
  afterEach(() => setSymlinkFailure(null));

  it('answers with a capability token when the probe link is created (positive control)', async () => {
    const symlinkCapability = await freshSymlinkCapability();
    // Skipped where the host genuinely cannot: that IS the null case, exercised
    // below by injection so it is reachable everywhere.
    if (symlinkCapability() === null) return;
    expect(symlinkCapability()).not.toBeNull();
  });

  it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP'])('answers null when the probe fails with %s', async (code) => {
    setSymlinkFailure(code);
    const symlinkCapability = await freshSymlinkCapability();
    expect(symlinkCapability()).toBeNull();
  });

  it.each(['EACCES', 'ENOENT', 'EROFS'])('throws rather than memoizing a process-wide no when the probe fails with %s', async (code) => {
    setSymlinkFailure(code);
    const symlinkCapability = await freshSymlinkCapability();
    expect(() => symlinkCapability()).toThrow(code);
  });
});
