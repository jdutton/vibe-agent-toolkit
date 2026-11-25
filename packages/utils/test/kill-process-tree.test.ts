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
const { windowsTaskkillPath } = await import('../src/kill-process-tree.js');

const onPosix = process.platform !== 'win32';
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

/** Where every Windows case below finds the system directory; any host can compute the path. */
const SYSTEM_ROOT = 'C:/Windows';
const TASKKILL = 'C:/Windows/System32/taskkill.exe';

/** Run the rest of the test as if on Windows; `afterEach` restores the real platform and env. */
function asWindows(): void {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('SystemRoot', SYSTEM_ROOT);
}

/** Put the real platform and environment back after a case that pretended to be Windows. */
function restoreHost(): void {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  spawnSync.mockReset();
}

/** A stand-in child whose own `kill` is recorded. */
function child(pid: number | undefined): { pid: number | undefined; kill: ReturnType<typeof vi.fn> } {
  return { pid, kill: vi.fn(() => true) };
}

describe('killProcessTree', () => {
  afterEach(restoreHost);

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

  it('Windows: taskkill /T /F takes the whole tree, the leader option notwithstanding', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    asWindows();

    killProcessTree(child(4242), { groupLeader: false, throughChild: false });

    expect(spawnSync).toHaveBeenCalledExactlyOnceWith(TASKKILL, ['/pid', '4242', '/T', '/F'], expect.anything());
    expect(kill).not.toHaveBeenCalled();
  });

  it('Windows, throughChild: the child\'s own kill comes BEFORE the taskkill sweep', () => {
    // libuv records the signal only when `child.kill`'s own TerminateProcess lands
    // (`uv_process_kill` sets `exit_signal`); a taskkill first leaves `exit` reading (1, null).
    const order: string[] = [];
    const stub = child(4242);
    stub.kill.mockImplementation(() => {
      order.push('child.kill');
      return true;
    });
    spawnSync.mockImplementation(() => {
      order.push('taskkill');
      return { status: 0 };
    });
    asWindows();

    killProcessTree(stub, { groupLeader: false, throughChild: true });

    expect(order).toStrictEqual(['child.kill', 'taskkill']);
    expect(stub.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
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

describe('windowsTaskkillPath', () => {
  // A bare `taskkill` resolves through PATH, so a PATH entry ahead of System32 could stand in for
  // it. The path comes from SystemRoot alone; this only computes it, so it runs on every host.
  afterEach(restoreHost);

  it('names taskkill.exe in System32 under SystemRoot', () => {
    expect(windowsTaskkillPath({ SystemRoot: SYSTEM_ROOT })).toBe(TASKKILL);
  });

  it.each([
    ['missing', {}],
    ['empty', { SystemRoot: '' }],
  ])('refuses a %s SystemRoot by name instead of falling back to PATH', (_label, env) => {
    expect(() => windowsTaskkillPath(env)).toThrow(/SystemRoot/);
  });

  it('Windows with no SystemRoot: the tree kill refuses loudly and spawns nothing', () => {
    asWindows();
    vi.stubEnv('SystemRoot', undefined);

    expect(() => {
      killProcessTree(child(4242), { groupLeader: false, throughChild: false });
    }).toThrow(/SystemRoot/);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
