/**
 * Shared test helper: run a command lane with its stdout, stderr and
 * `process.exit` captured ({@link captureCommand}).
 */

import { captureProcessExit, type CapturedExit } from '../test-doubles.js';

/**
 * Intercept process.stdout.write and collect all output into `captured`.
 * Returns a restore function that must be called in a finally block.
 */
function captureStdout(captured: string[]): () => void {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
  };
}

/** What a command lane wrote and how it ended. */
interface CapturedCommand extends CapturedExit {
  /** Everything written to `process.stdout` — the published document. */
  stdout: string;
}

/**
 * Run a command lane with stdout, stderr and `process.exit` captured: the
 * document it published, the human half on stderr, and the code it ended on.
 */
export async function captureCommand(fn: () => void | Promise<void>, onFirstExit?: () => void): Promise<CapturedCommand> {
  const written: string[] = [];
  const restore = captureStdout(written);
  try {
    const captured = await captureProcessExit(fn, onFirstExit);
    return { ...captured, stdout: written.join('') };
  } finally {
    restore();
  }
}
