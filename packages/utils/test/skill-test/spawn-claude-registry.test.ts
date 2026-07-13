/**
 * Unit tests for the active-children registry in spawn-claude.ts
 * (killAllActiveClaudeChildren + register-on-spawn / unregister-on-settle).
 *
 * `spawn` is mocked so no real `claude` process is ever launched; the fake
 * child is a plain EventEmitter with PassThrough stdio, driven manually by
 * each test to simulate settle ('close') or to stay in-flight so it can be
 * reaped by killAllActiveClaudeChildren().
 */
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock modules before importing the code under test (hoisted by vitest).
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

const { killAllActiveClaudeChildren, spawnHeadlessClaude } = await import('../../src/skill-test/spawn-claude.js');

/** Minimal fake ChildProcess: an EventEmitter with the stdio surface spawnHeadlessClaude touches. */
class FakeChild extends EventEmitter {
  pid = 4321;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
}

/** Base options for a spawn that never times out mid-test (only settles when the test drives it). */
const baseOpts = {
  prompt: 'hello\n',
  pluginDirs: [],
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
  sandboxDir: '/tmp/sandbox',
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
  cwd: '/tmp/sandbox',
  env: process.env,
  timeoutMs: 60_000,
  binPath: '/fake/claude',
};

describe('active-children registry (spawn-claude)', () => {
  let spawnedChildren: FakeChild[];
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnedChildren = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = new FakeChild();
      spawnedChildren.push(child);
      return child as unknown as ChildProcess;
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null,
    });
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    // Safety net: reap anything a failed assertion left in-flight so state
    // (and any live timers) never bleeds into the next test.
    killAllActiveClaudeChildren();
    killSpy.mockRestore();
    vi.mocked(spawn).mockReset();
    vi.mocked(spawnSync).mockReset();
  });

  it('kills an in-flight child and empties the registry when killAllActiveClaudeChildren runs', async () => {
    const pending = spawnHeadlessClaude(baseOpts);
    const child = spawnedChildren[0];
    expect(child).toBeDefined();

    killAllActiveClaudeChildren();

    // POSIX kill path: SIGKILL the negated pid (whole process group).
    expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');

    // Idempotent: a second call with an already-empty registry does nothing more.
    killSpy.mockClear();
    killAllActiveClaudeChildren();
    expect(killSpy).not.toHaveBeenCalled();

    // Let the pending spawnHeadlessClaude promise settle so it doesn't leak
    // into the next test (killAllActiveClaudeChildren does not itself close
    // the child — it only signals it; the harness's own 'close' listener
    // resolves the promise once the process actually exits).
    child?.emit('close', -1);
    await pending;
  });

  it('unregisters a normally-exited child (registry stays empty; nothing left to kill)', async () => {
    const pending = spawnHeadlessClaude(baseOpts);
    const child = spawnedChildren[0];
    expect(child).toBeDefined();

    child?.emit('close', 0);
    const result = await pending;
    expect(result.status).toBe(0);

    killSpy.mockClear();
    killAllActiveClaudeChildren();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when the registry is already empty', () => {
    expect(() => { killAllActiveClaudeChildren(); }).not.toThrow();
    expect(killSpy).not.toHaveBeenCalled();
  });
});
