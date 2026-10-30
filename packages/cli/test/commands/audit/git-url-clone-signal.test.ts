/**
 * `withClonedRepo`'s guard, on its failure path: the ONE disposal answers what it left behind
 * whichever path started it — so a signal that arrives during the failure path's disposal still
 * names a clone that would not go — and a disposal that REJECTS still releases the guard.
 *
 * The clone, the staging directory and the disposals are stand-ins; the raise and the exit are
 * stubbed. Through the real binary: `signal-guard-group-ctrl-c.system.test.ts`.
 */

import type * as AgentSkills from '@vibe-agent-toolkit/agent-skills';
import type * as Utils from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  afterFailure: vi.fn<(dir: string, failure: unknown) => Promise<unknown>>(),
}));

vi.mock('@vibe-agent-toolkit/agent-skills', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentSkills>()),
  cloneGitSource: () => {
    throw new Error('clone failed');
  },
}));
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof Utils>()),
  disposeTempDirAfterFailure: fakes.afterFailure,
}));
vi.mock('../../../src/utils/staging-dir.js', () => ({
  makeStagingDir: () => Promise.resolve('/stand-in/vat-audit-x'),
}));

const { withClonedRepo } = await import('../../../src/commands/audit/git-url-clone.js');

const PARSED = { cloneUrl: 'file:///stand-in/repo.git' } as Parameters<typeof withClonedRepo>[0];
const OPTIONS = { keepTempForDebug: false };
const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGBREAK'] as const;

function counts(): number[] {
  return SIGNALS.map((signal) => process.listenerCount(signal));
}

describe('withClonedRepo — its signal guard on the failure path', () => {
  let baseline: number[];
  let stderr: string[];

  beforeEach(() => {
    baseline = counts();
    stderr = [];
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(Atomics, 'wait').mockImplementation(() => 'timed-out');
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fakes.afterFailure.mockReset();
  });

  // 🚨 The guard was released only after a disposal that SETTLED: one that rejected left it installed.
  it('a disposal that rejects still releases the guard, and its rejection is what the caller sees', async () => {
    fakes.afterFailure.mockRejectedValue(new Error('refused to dispose'));

    await expect(withClonedRepo(PARSED, OPTIONS, () => Promise.resolve(1))).rejects.toThrow('refused to dispose');

    expect(counts()).toStrictEqual(baseline);
  });

  // 🚨 The failure path's disposal answered nothing, so a signal that joined it said nothing of
  // the clone it left behind.
  it('a signal during the failure path\'s disposal names the clone that disposal left behind', async () => {
    let settle: ((leftover: unknown) => void) | undefined;
    fakes.afterFailure.mockReturnValue(new Promise((resolve) => {
      settle = resolve;
    }));
    const exit = vi.mocked(process.exit);

    // Never settles: a signal is ending the process.
    withClonedRepo(PARSED, OPTIONS, () => Promise.resolve(1)).catch(() => undefined);
    await vi.waitFor(() => {
      expect(fakes.afterFailure).toHaveBeenCalledOnce();
    });
    process.emit('SIGINT', 'SIGINT');
    settle?.(new Error('could not remove /stand-in/vat-audit-x'));

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(2);
    });
    expect(stderr.join('')).toContain('temp dir left behind: could not remove /stand-in/vat-audit-x');
    expect(counts()).toStrictEqual(baseline);
  });
});
