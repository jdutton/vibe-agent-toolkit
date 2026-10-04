/**
 * `install --build` shells out to `vat build`. The child's stdout must not go
 * through a pipe: spawnSync buffers a pipe under a 1 MiB `maxBuffer`, and a
 * build document past that kills the child (ENOBUFS) — which this verb then
 * reported as "vat build failed" about a build it had killed itself. The
 * child's stdout goes straight to this process's stderr (fd 2) instead, since
 * this verb's own stdout carries only its report.
 */

import type * as processUtils from '@vibe-agent-toolkit/utils/process';
import { CommandExecutionError } from '@vibe-agent-toolkit/utils/process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeExecSync = vi.fn();

vi.mock('@vibe-agent-toolkit/utils/process', async (importOriginal) => ({
  ...(await importOriginal<typeof processUtils>()),
  safeExecSync: (...args: unknown[]) => safeExecSync(...args),
}));

const { runBuild } = await import('../../../../src/commands/claude/plugin/install.js');

const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() };

/** What `runBuild` threw, or `undefined`. */
function thrownBy(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('runBuild (install --build)', () => {
  beforeEach(() => {
    safeExecSync.mockReset();
  });

  it('routes the child build\'s stdout to fd 2 — never a buffered pipe', () => {
    runBuild('/project', logger as never);

    const options = safeExecSync.mock.calls[0]?.[2] as { stdio: unknown[]; cwd: string };
    expect(options.cwd).toBe('/project');
    expect(options.stdio).toStrictEqual(['inherit', 2, 'inherit']);
  });

  it('refuses a build that exited non-zero as RUN_INCOMPLETE', () => {
    safeExecSync.mockImplementation(() => {
      throw new CommandExecutionError('Command failed with exit code 1', 1, '', '');
    });

    expect(thrownBy(() => runBuild('/project', logger as never))).toMatchObject({ refusal: 'RUN_INCOMPLETE' });
  });

  it('refuses a build that could not be started as RUN_INCOMPLETE, naming why', () => {
    safeExecSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    });

    const error = thrownBy(() => runBuild('/project', logger as never));
    expect(error).toMatchObject({ refusal: 'RUN_INCOMPLETE' });
    expect(String(error)).toContain('ENOENT');
  });
});
