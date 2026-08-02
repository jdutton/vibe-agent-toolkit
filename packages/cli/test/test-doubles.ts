/**
 * Test doubles shared across CLI tests.
 *
 * Deliberately a separate module from `test-helpers.ts`: that one imports
 * `../src/commands/audit.js` at load time, so a unit test that only wants a
 * silent logger would drag the whole audit command in with it. Nothing here
 * imports production code beyond a type.
 */

import { vi } from 'vitest';

import type { Logger } from '../src/utils/logger.js';

/**
 * A logger that swallows every channel.
 *
 * ONE definition, not one per suite: the object is six lines of identical
 * no-ops, which is long enough to register as a duplicate clone and short
 * enough that re-typing it always looks harmless.
 */
export const silentLogger: Logger = {
  info: (_msg: string): void => {},
  warn: (_msg: string): void => {},
  error: (_msg: string): void => {},
  debug: (_msg: string): void => {},
};

/** What {@link captureProcessExit} observed. */
export interface CapturedExit {
  /** Everything written to `process.stderr` during the run. */
  stderr: string;
  /** The code passed to `process.exit`, or `undefined` if it was never called. */
  exited: number | undefined;
}

/** Sentinel thrown by the `process.exit` stub — the real one never returns. */
const EXIT_SENTINEL = 'process.exit';

/**
 * Run `fn` with `process.exit` and `process.stderr.write` captured.
 *
 * `exit` is stubbed to THROW rather than return, because the real one never
 * returns: a stub that returns lets execution fall through into code the
 * production path can never reach after an exit, and the test then asserts
 * against a control flow that does not exist — in the CLI's case, spawning real
 * subprocesses from an action that should already have terminated.
 *
 * The spies are always restored, including when `fn` throws something else.
 */
export async function captureProcessExit(
  fn: () => void | Promise<void>,
): Promise<CapturedExit> {
  let stderr = '';
  let exited: number | undefined;

  const writeSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exited = code;
    throw new Error(EXIT_SENTINEL);
  }) as never);

  try {
    await fn();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== EXIT_SENTINEL) throw error;
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stderr, exited };
}
