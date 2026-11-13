/**
 * `vat-compile-resources` is this repo's SECOND published bin, and it had the
 * same stdout-truncation exposure the main `vat` CLI was fixed for.
 *
 * Every path through this CLI writes with `console.log` and then calls
 * `process.exit()` immediately — `exitWithResults` in `compile-utils.ts`, and the
 * two `process.exit(1)` error handlers in `compile-command.ts` /
 * `generate-types-command.ts`. Node makes a PIPE's stdio non-blocking, so those
 * writes are buffered and asynchronous, and `process.exit` does not drain them:
 * everything past the first pipe buffer (64 KB on Linux/macOS) is discarded, cut
 * mid-token, with exit code 0. An interactive TTY is unbuffered and always looked
 * correct, which is why it survives unnoticed.
 *
 * The fix is not a new mechanism — it is the same `makeStdioBlocking()` the main
 * CLI's entry points call, applied to this bin's entry point (`runCLI`).
 *
 * The subprocess cases below are the reason this file is not just a mock
 * assertion: they run a real child with a real pipe and show the loss actually
 * happening, so "we called setBlocking" is anchored to "and that is what stops
 * the truncation".
 */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

import { describe, it, expect, vi } from 'vitest';

import { runCLI } from '../../src/cli/index.js';

/**
 * The internal handle `makeStdioBlocking` reaches through. Node does not type it,
 * and its presence and shape are exactly what vary by platform and by how the
 * test runner wired its own stdio — which is why the tests install their own
 * rather than asserting against whatever they happen to inherit.
 */
/** What the `process.exit` stub throws, so the harness can tell an exit from a crash. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
    this.name = 'ExitSignal';
  }
}

interface StreamWithHandle {
  _handle?: { setBlocking?: (blocking: boolean) => number } | undefined;
}

/**
 * Swap in a handle that RECORDS `setBlocking` instead of performing it.
 *
 * Installing a handle rather than wrapping the inherited one keeps the real fd
 * untouched (the suite's own stdout is left exactly as it was found) and makes
 * the assertion deterministic under any runner. Pass `setBlocking: false` to
 * model the platform where the call is unavailable — the silent-failure path.
 */
function installRecordingHandle(
  stream: NodeJS.WriteStream,
  options: { setBlocking?: boolean } = {},
): { calls: boolean[]; restore: () => void } {
  const target = stream as unknown as StreamWithHandle;
  const original = target._handle;
  const calls: boolean[] = [];
  target._handle = options.setBlocking === false
    ? {}
    : {
        // libuv reports the switch as an int RETURN VALUE — 0 for success, a
        // negative errno for a refusal — never as a throw. The double answers
        // the way the real handle does, so the production check
        // (`=== 0`) is what the assertion below exercises.
        setBlocking: (blocking: boolean) => {
          calls.push(blocking);
          return 0;
        },
      };
  return {
    calls,
    restore: () => {
      target._handle = original;
    },
  };
}

/**
 * Drive `runCLI` to completion with the streams instrumented and every exit and
 * write intercepted.
 *
 * `runCLI` is a bin entry point: with no subcommand Commander prints help and
 * exits, so an un-neutered call would take the test runner down with it. The
 * `process.exit` stub throws instead, which `runCLI`'s own rejection path
 * absorbs.
 */
async function runInstrumentedCLI(
  argv: string[],
  options: { stdoutCanBlock?: boolean } = {},
): Promise<{ stdout: boolean[]; stderr: boolean[]; errorOutput: string }> {
  const outHandle = installRecordingHandle(
    process.stdout,
    options.stdoutCanBlock === false ? { setBlocking: false } : {},
  );
  const errHandle = installRecordingHandle(process.stderr);
  const errorOutput: string[] = [];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errorOutput.push(String(chunk));
    return true;
  });
  const logSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorOutput.push(args.map(String).join(' '));
  });

  try {
    await runCLI(argv);
  } catch (error) {
    // Commander's own exit path, rethrown by the stub above. Irrelevant here:
    // the assertions are about what happened BEFORE any command ran. Anything
    // else is a crash inside the CLI and must not be read as "it exited".
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    outSpy.mockRestore();
    exitSpy.mockRestore();
    errHandle.restore();
    outHandle.restore();
  }

  return { stdout: outHandle.calls, stderr: errHandle.calls, errorOutput: errorOutput.join('') };
}

describe('vat-compile-resources entry point', () => {
  it('switches BOTH stdout and stderr to blocking before any command can write', async () => {
    const result = await runInstrumentedCLI(['node', 'vat-compile-resources']);

    // Both streams, not just stdout: this CLI puts its per-file failure lines on
    // stderr (`printOperationSummary`), and a failure report that loses its tail
    // is worse than one that never printed.
    expect(result.stdout).toEqual([true]);
    expect(result.stderr).toEqual([true]);
  });

  it('warns under VAT_DEBUG when a stream could NOT be made blocking', async () => {
    vi.stubEnv('VAT_DEBUG', '1');
    try {
      const result = await runInstrumentedCLI(['node', 'vat-compile-resources'], {
        stdoutCanBlock: false,
      });

      // Naming the failing stream is the payload. A handle without `setBlocking`
      // is how some platforms present, and reverting to truncation with nothing
      // to distinguish it from a working run is what makes such a report
      // impossible to diagnose.
      expect(result.errorOutput).toMatch(/could NOT make stdout blocking/);
      expect(result.errorOutput).not.toMatch(/NOT make stderr/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** Node's pipe buffer on Linux/macOS. A payload must exceed it to be a real test. */
const PIPE_BUFFER_BYTES = 65_536;

/** Comfortably several pipe buffers, so the loss is unmistakable. */
const LARGE_PAYLOAD_BYTES = 300_000;

/**
 * The payload for the STALLING pair, sized against everything that can hold
 * bytes while the reader is stalled — not against a pipe buffer.
 *
 * A child's `'pipe'` stdio on POSIX is a libuv socketpair, not a pipe(2). Its
 * kernel capacity is the AF_UNIX send buffer: about 8 KB on macOS, but
 * `net.core.wmem_default` (212,992) on Linux, and a stream send may overshoot
 * that by one skb of up to half the buffer — so a Linux runner can hold roughly
 * 320 KB with nobody reading. A paused parent stream also keeps reading until its
 * buffer reaches `highWaterMark`: measured at most 16 KiB on Node 22 and 128 KiB
 * on Node 24 (its 64 KiB mark plus the in-flight read). 300,000 bytes
 * fit inside that sum, which is how an unfixed child delivered all 300,001 to a
 * reader that was stalled until its exit. 8 MiB exceeds the sum by more than an
 * order of magnitude on any default kernel.
 */
const STALLED_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * How long the reader stops reading after its first chunk when the child is
 * BLOCKING. Such a child cannot exit while the reader is stalled, so it needs a
 * timer to end the stall; the timing cannot change its outcome, because it waits
 * for the reader whatever the delay. A child that is NOT blocking is never resumed
 * on a timer: see {@link writeThroughStallingPipe}.
 */
const READER_STALL_MS = 300;

/** The fix itself, guarded the way a real platform check must be. */
const APPLY_FIX =
  'process.stdout._handle && process.stdout._handle.setBlocking && process.stdout._handle.setBlocking(true);';

/**
 * This CLI's exact write shape: one `console.log` of the whole payload, then an
 * immediate `process.exit(0)` — `printOperationSummary` followed by
 * `exitWithResults`.
 *
 * @param bytes - Payload size to emit.
 * @param blocking - Whether the child applies the fix before writing.
 * @returns Source for a `node -e` child.
 */
function childSource(bytes: number, blocking: boolean): string {
  return `${blocking ? APPLY_FIX : ''}console.log('x'.repeat(${bytes}));process.exit(0);`;
}

/**
 * Run the child with a reader that drains as fast as it possibly can.
 *
 * @param bytes - Payload size to emit.
 * @param blocking - Whether the child applies the fix before writing.
 * @returns The child's stdout, read through a real pipe.
 */
function writeThroughPipe(bytes: number, blocking: boolean): string {
  const child = spawnSync(process.execPath, ['-e', childSource(bytes, blocking)], {
    encoding: 'utf8',
    maxBuffer: LARGE_PAYLOAD_BYTES * 4,
  });
  expect(child.status).toBe(0);
  return child.stdout;
}

/**
 * Run the child against a reader that STALLS after its first chunk.
 *
 * The stall is the whole point, and removing it is what previously made this
 * suite flaky. libuv loops `writev` until the pipe returns EAGAIN, so a reader
 * that drains continuously can keep the pipe from ever filling — and then an
 * unfixed child loses nothing at all. `spawnSync` polls in exactly such a tight
 * loop: macOS happened to deliver one 64 KB buffer, one ubuntu-latest runner
 * delivered 219,264 bytes, and another delivered the entire 300,001 — failing a
 * suite that had already been re-pinned once, from a byte count to the missing
 * trailing newline. Neither is invariant, because the drain race is not.
 *
 * Refusing to read removes the race instead of re-pinning to whichever side of it
 * a runner lands on: a stalled reader and the kernel together hold a bounded
 * amount (see {@link STALLED_PAYLOAD_BYTES}), so an unfixed child writing more
 * than that provably hits EAGAIN and exits, discarding the rest, while a blocking
 * child provably waits and delivers all of it. Same harness, opposite `blocking` flag,
 * opposite outcome — which is what makes this pair able to tell a working fix from
 * a no-op one.
 *
 * For the unfixed child the stall ends only when the child has EXITED, never on a
 * timer. A timer was a second race: on a loaded runner the child had not reached
 * its exit when the timer fired, the reader drained the pipe, and the child's
 * queued writes completed, so all 300,001 bytes arrived. A blocking child cannot
 * exit while stalled, so it resumes after {@link READER_STALL_MS} — it must not
 * wait for the exit as well, or the two deadlock. Nor can the reader skip reading
 * altogether until the exit: `child_process` resumes a stdio stream nobody
 * listens to when the child exits, discarding its data, and a `net.Socket` reads
 * ahead to `highWaterMark` whether or not anyone consumes it.
 *
 * @param bytes - Payload size to emit.
 * @param blocking - Whether the child applies the fix before writing.
 * @returns The child's stdout and exit code.
 */
async function writeThroughStallingPipe(
  bytes: number,
  blocking: boolean,
): Promise<{ received: string; status: number | null }> {
  const child = spawn(process.execPath, ['-e', childSource(bytes, blocking)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout.setEncoding('utf8');

  let received = '';
  let stalled = false;
  const exited = once(child, 'exit');
  child.stdout.on('data', (chunk: string) => {
    received += chunk;
    if (!stalled) {
      stalled = true;
      child.stdout.pause();
      if (blocking) setTimeout(() => child.stdout.resume(), READER_STALL_MS);
      else exited.then(
        () => child.stdout.resume(),
        () => child.stdout.resume(),
      );
    }
  });

  // `close`, not `exit`: it waits for the stdio streams to drain and end, which
  // is precisely the window the unfixed child abandons.
  const [status] = (await once(child, 'close')) as [number | null];
  return { received, status };
}

describe('stdout truncation through a real pipe', () => {
  // Windows pipes do not present the POSIX handle shape, so the LOSS is not
  // reproducible there; the two spawnSync cases below still assert on every OS.
  it.skipIf(process.platform === 'win32')(
    'loses the tail of a payload larger than a stalled reader can hold, without the fix',
    async () => {
      const { received, status } = await writeThroughStallingPipe(STALLED_PAYLOAD_BYTES, false);

      expect(status).toBe(0);
      expect(received.length).toBeLessThan(STALLED_PAYLOAD_BYTES);
      // Cut mid-token, so the terminating newline `console.log` appends never
      // arrives — the signature of the defect, on top of the byte count.
      expect(received.endsWith('\n')).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'delivers that same payload intact WITH the fix, against the same stalling reader',
    async () => {
      const { received, status } = await writeThroughStallingPipe(STALLED_PAYLOAD_BYTES, true);

      expect(status).toBe(0);
      // Length first, so a short delivery reports a byte count before any diff.
      expect(received).toHaveLength(STALLED_PAYLOAD_BYTES + 1);
      expect(received).toBe(`${'x'.repeat(STALLED_PAYLOAD_BYTES)}\n`);
    },
  );

  it('delivers a payload larger than one pipe buffer intact with the fix', () => {
    const received = writeThroughPipe(LARGE_PAYLOAD_BYTES, true);

    expect(received.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
    expect(received).toBe(`${'x'.repeat(LARGE_PAYLOAD_BYTES)}\n`);
  });

  it('still delivers a SMALL payload intact with the fix', () => {
    // Positive control: proves the mechanism moves bytes rather than merely
    // failing to crash. A no-op "fix" passes the large case only by accident;
    // one that swallowed output would fail here.
    const received = writeThroughPipe(32, true);

    expect(received).toBe(`${'x'.repeat(32)}\n`);
  });
});
