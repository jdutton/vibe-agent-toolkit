/**
 * Unit tests for the parts of spawn-claude.ts that need a live child process:
 * the active-children registry (killAllActiveClaudeChildren + register-on-spawn /
 * unregister-on-settle) and the stdout/stderr chunk DECODING.
 *
 * `spawn` is mocked so no real `claude` process is ever launched; the fake
 * child is a plain EventEmitter with PassThrough stdio, driven manually by
 * each test to simulate settle ('close') or to stay in-flight so it can be
 * reaped by killAllActiveClaudeChildren(). Driving the PassThrough by hand is
 * also the only way to control where a chunk boundary falls, which is what the
 * decoding tests need.
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
const { parseStreamJsonTranscript } = await import('../../src/skill-test/transcript.js');

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

let spawnedChildren: FakeChild[];
let killSpy: ReturnType<typeof vi.spyOn>;

// File-scope hooks: both suites below need the same mocked spawn + kill, and the
// repo's zero-duplication policy rules out a second copy of this block.
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

/** The child the mocked `spawn` just produced, narrowed (never `undefined` in practice). */
function spawnedChild(): FakeChild {
  const child = spawnedChildren[0];
  if (child === undefined) throw new Error('spawn was not called');
  return child;
}

describe('active-children registry (spawn-claude)', () => {
  it('kills an in-flight child and empties the registry when killAllActiveClaudeChildren runs', async () => {
    const pending = spawnHeadlessClaude(baseOpts);
    const child = spawnedChildren[0];
    expect(child).toBeDefined();

    killAllActiveClaudeChildren();

    // The reap mechanism is platform-specific (killProcessTree): POSIX SIGKILLs
    // the negated pid (whole process group); Windows has no process groups, so it
    // shells out to `taskkill /T /F` over the tree. Assert whichever this host uses
    // so the registry behavior is verified on every platform (not skipped on Windows).
    if (process.platform === 'win32') {
      expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F']);
    } else {
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');
    }

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

/**
 * A pipe hands the reader whatever bytes have arrived — typically capped at 64 KiB
 * — with no regard for character boundaries. Calling `.toString()` on each chunk
 * independently therefore turns any multi-byte character that straddles a boundary
 * into replacement characters, on BOTH sides of the split.
 *
 * That is not a cosmetic defect for this harness: the corrupted bytes sit inside a
 * stream-json line, so either the line stops parsing (its tool call, and the
 * contamination evidence in it, silently disappears) or — worse, because it is
 * invisible — the line still parses and the VALUE is mangled, so the detector's
 * needle simply fails to match a path it was looking at. An arm wanting its reach
 * unseen only has to make the transcript long enough; an innocent run with a
 * non-ASCII path or an emoji corrupts by chance.
 */
describe('stdout/stderr decoding (spawn-claude)', () => {
  /** Let queued 'data' emissions land (two macrotask turns, deterministically). */
  const flush = async (): Promise<void> => {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  };

  /**
   * Write `payload` as two separate chunks split at byte offset `at`, flushing
   * between them so the split is guaranteed to survive as two 'data' events
   * (a PassThrough would otherwise be free to coalesce back-to-back writes).
   */
  const writeSplit = async (target: PassThrough, payload: string, at: number): Promise<void> => {
    const bytes = Buffer.from(payload, 'utf8');
    target.write(bytes.subarray(0, at));
    await flush();
    target.write(bytes.subarray(at));
    await flush();
  };

  it('reassembles a multi-byte character split across a stdout chunk boundary', async () => {
    const chunks: string[] = [];
    const pending = spawnHeadlessClaude({ ...baseOpts, onStdout: (c) => chunks.push(c) });
    const child = spawnedChild();

    // '😀' is four UTF-8 bytes; the boundary falls after byte 1 of the payload,
    // i.e. two bytes into the emoji.
    await writeSplit(child.stdout, 'a😀b', 3);

    expect(chunks.join('')).toBe('a😀b');
    expect(chunks.join('')).not.toContain('�');

    child.emit('close', 0);
    await pending;
  });

  it('reassembles a multi-byte character split across a stderr chunk boundary', async () => {
    const chunks: string[] = [];
    const pending = spawnHeadlessClaude({ ...baseOpts, onStderr: (c) => chunks.push(c) });
    const child = spawnedChild();

    await writeSplit(child.stderr, 'x—y', 2);

    expect(chunks.join('')).toBe('x—y');
    expect(chunks.join('')).not.toContain('�');

    child.emit('close', 0);
    await pending;
  });

  it('keeps a stream-json tool_use path intact when the boundary falls inside it', async () => {
    const filePath = '/Users/José/tmp/vat-skill-test/my-skill-abc12345/staged/s/SKILL.md';
    const line = `${JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: filePath } }] },
    })}\n`;

    const chunks: string[] = [];
    const pending = spawnHeadlessClaude({ ...baseOpts, onStdout: (c) => chunks.push(c) });
    const child = spawnedChild();

    // Split one byte into the two-byte 'é' — the character in the reached path.
    const boundary = Buffer.from(line, 'utf8').indexOf(Buffer.from('é', 'utf8')) + 1;
    expect(boundary).toBeGreaterThan(0);
    await writeSplit(child.stdout, line, boundary);

    const parsed = parseStreamJsonTranscript(chunks.join(''));
    expect(parsed.malformedLineCount).toBe(0);
    // The load-bearing assertion: the reached path round-trips byte for byte, so
    // a detector needle built from it still matches.
    expect(parsed.toolUses[0]?.input).toEqual({ file_path: filePath });

    child.emit('close', 0);
    await pending;
  });

  it('flushes a trailing incomplete sequence at EOF rather than dropping it', async () => {
    const chunks: string[] = [];
    const pending = spawnHeadlessClaude({ ...baseOpts, onStdout: (c) => chunks.push(c) });
    const child = spawnedChild();

    // Truncated mid-character and then EOF: the harness must still see something
    // (a replacement char), never silently swallow the tail.
    child.stdout.write(Buffer.from('ok😀', 'utf8').subarray(0, 4));
    child.stdout.end();
    await flush();

    expect(chunks.join('')).toBe('ok�');

    child.emit('close', 0);
    await pending;
  });
});
