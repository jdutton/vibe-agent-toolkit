/**
 * The ONE process-tree kill: which target each platform and option reaches, what is absorbed as
 * "already gone", and what stays loud. The kill is stubbed; `taskkill` is stubbed on Windows.
 */

import type * as ChildProcessModule from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawnSync,
}));

const { killProcessTree } = await import('../src/process.js');

const onPosix = process.platform !== 'win32';

/** A stand-in child whose own `kill` is recorded. */
function child(pid: number | undefined): { pid: number | undefined; kill: ReturnType<typeof vi.fn> } {
  return { pid, kill: vi.fn(() => true) };
}

describe('killProcessTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSync.mockReset();
  });

  it('a child with no pid: no kill, no taskkill — only the child\'s own kill when asked to go through it', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const stub = child(undefined);

    killProcessTree(stub, { groupLeader: true, throughChild: true });

    expect(kill).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(stub.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it.skipIf(!onPosix)('POSIX, a group leader: SIGKILLs the whole group through the negated pid', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const stub = child(4242);

    killProcessTree(stub, { groupLeader: true, throughChild: false });

    expect(kill).toHaveBeenCalledExactlyOnceWith(-4242, 'SIGKILL');
    expect(stub.kill).not.toHaveBeenCalled();
  });

  it.skipIf(!onPosix)('POSIX, not a leader: SIGKILLs the pid alone — it has no group of its own', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killProcessTree(child(4242), { groupLeader: false, throughChild: false });

    expect(kill).toHaveBeenCalledExactlyOnceWith(4242, 'SIGKILL');
  });

  it.skipIf(onPosix)('Windows: taskkill /T /F takes the whole tree, the leader option notwithstanding', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killProcessTree(child(4242), { groupLeader: false, throughChild: false });

    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('taskkill', ['/pid', '4242', '/T', '/F'], expect.anything());
    expect(kill).not.toHaveBeenCalled();
  });

  it('throughChild: the child\'s own kill too, so a refusal surfaces as its `error`', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const stub = child(4242);

    killProcessTree(stub, { groupLeader: true, throughChild: true });

    expect(stub.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it.skipIf(!onPosix).each(['ESRCH', 'EPERM'])('reads %s as "already gone" and says nothing', (code) => {
    // ESRCH: no such group. EPERM: the group id has been recycled to a process this uid may not
    // signal — which, for a group WE created, also means every process of ours in it has exited.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });

    expect(() => {
      killProcessTree(child(9999), { groupLeader: true, throughChild: false });
    }).not.toThrow();
  });

  it.skipIf(!onPosix)('lets anything else thrown by the kill stay loud instead of reporting the tree reaped', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new TypeError('kill is not a function');
    });

    expect(() => {
      killProcessTree(child(9999), { groupLeader: true, throughChild: false });
    }).toThrow(TypeError);
  });
});
