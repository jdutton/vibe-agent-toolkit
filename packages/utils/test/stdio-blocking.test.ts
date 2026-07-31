import { describe, expect, it } from 'vitest';

import { describeStdioBlocking, makeStdioBlocking } from '../src/stdio-blocking.js';

/**
 * The internal handle `makeStdioBlocking` reaches through. Node does not type it,
 * and its SHAPE is exactly what varies by platform — which is the whole point of
 * these tests.
 */
interface StreamWithHandle {
  _handle?: { setBlocking?: (blocking: boolean) => void } | undefined;
}

/**
 * Swap both streams' internal handles for the given fakes, run `fn`, restore.
 *
 * Substituting the handle rather than skipping by platform is deliberate:
 * `setBlocking` is an INTERNAL Node API and Windows named pipes do not present
 * the same handle shape as POSIX pipes, so a `skipIf(win32)` test would leave the
 * one platform that can actually fail permanently unexercised. Injecting the
 * handle makes every case reachable from every OS, and never touches the real fd
 * — the suite's own stdout is left exactly as it was found.
 */
function withHandles<T>(
  handles: { stdout: unknown; stderr: unknown },
  fn: () => T,
): T {
  const out = process.stdout as unknown as StreamWithHandle;
  const err = process.stderr as unknown as StreamWithHandle;
  const originals = { stdout: out._handle, stderr: err._handle };
  out._handle = handles.stdout as StreamWithHandle['_handle'];
  err._handle = handles.stderr as StreamWithHandle['_handle'];
  try {
    return fn();
  } finally {
    out._handle = originals.stdout;
    err._handle = originals.stderr;
  }
}

/** A handle of the shape a POSIX pipe presents: `setBlocking` is callable. */
function workingHandle(): { handle: unknown; calls: () => boolean[] } {
  const calls: boolean[] = [];
  return {
    handle: { setBlocking: (blocking: boolean) => calls.push(blocking) },
    calls: () => calls,
  };
}

describe('makeStdioBlocking', () => {
  it('reports both streams switched, and asks for blocking mode', () => {
    const out = workingHandle();
    const err = workingHandle();

    const result = withHandles({ stdout: out.handle, stderr: err.handle }, () =>
      makeStdioBlocking(),
    );

    expect(result).toEqual({ stdout: true, stderr: true });
    expect(out.calls()).toEqual([true]);
    expect(err.calls()).toEqual([true]);
  });

  it('reports a stream UNswitched when its handle exposes no setBlocking', () => {
    // A handle without `setBlocking` is how a redirect-to-file (and, per Node's
    // own issue history, some Windows named pipes) presents. Silently returning
    // void here is what let the truncation bug reappear with no signal.
    const out = workingHandle();

    const result = withHandles({ stdout: out.handle, stderr: {} }, () =>
      makeStdioBlocking(),
    );

    expect(result).toEqual({ stdout: true, stderr: false });
  });

  it('reports a stream UNswitched when the handle is absent entirely', () => {
    const result = withHandles({ stdout: undefined, stderr: undefined }, () =>
      makeStdioBlocking(),
    );

    expect(result).toEqual({ stdout: false, stderr: false });
  });

  it('reports UNswitched rather than propagating when setBlocking throws', () => {
    const err = workingHandle();
    const throwing = {
      setBlocking: () => {
        throw new Error('ENOTSUP: setBlocking is not supported on this handle');
      },
    };

    const result = withHandles({ stdout: throwing, stderr: err.handle }, () =>
      makeStdioBlocking(),
    );

    expect(result).toEqual({ stdout: false, stderr: true });
  });
});

/**
 * These assert on the clause that NAMES THE FAILING STREAMS, not merely on the
 * presence of the words "stdout"/"stderr"/"truncate" — the healthy message
 * mentions all three ("…are blocking; process.exit cannot truncate output"), so
 * a looser assertion passes against a formatter that always claims success and
 * proves nothing. The wording coupling is the point: the warning is the payload.
 */
describe('describeStdioBlocking', () => {
  it('states plainly that output is safe when both streams switched', () => {
    const message = describeStdioBlocking({ stdout: true, stderr: true });

    expect(message).not.toMatch(/\bNOT\b/);
    expect(message).toMatch(/cannot truncate/i);
  });

  it('names the ONE stream that failed, and warns its output may be truncated', () => {
    const message = describeStdioBlocking({ stdout: true, stderr: false });

    expect(message).toMatch(/could NOT make stderr blocking/);
    expect(message).toMatch(/may be truncated/i);
    // The working stream must not be reported as failing.
    expect(message).not.toMatch(/NOT make stdout/);
  });

  it('names BOTH streams when neither could be switched', () => {
    const message = describeStdioBlocking({ stdout: false, stderr: false });

    expect(message).toMatch(/could NOT make stdout and stderr blocking/);
    expect(message).toMatch(/may be truncated/i);
  });

  it('produces a distinct message for every outcome', () => {
    const messages = new Set([
      describeStdioBlocking({ stdout: true, stderr: true }),
      describeStdioBlocking({ stdout: true, stderr: false }),
      describeStdioBlocking({ stdout: false, stderr: true }),
      describeStdioBlocking({ stdout: false, stderr: false }),
    ]);

    expect(messages.size).toBe(4);
  });
});
