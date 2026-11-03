/**
 * Shared test helper: run a command lane with its stdout, stderr and
 * `process.exit` captured ({@link captureCommand}).
 */

import type { Report } from '@vibe-agent-toolkit/schema';
import * as YAML from 'yaml';

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

/**
 * Run a command lane that should end refused by the writer's run-integrity check: what it
 * captured, the YAML document it published, the RESOURCE_CHECK_BROKEN finding in it, and how
 * many times stderr carries that finding's line.
 */
export async function captureWriterRefusal(fn: () => Promise<void>): Promise<{
  captured: CapturedCommand;
  document: Report<unknown>;
  refusal: Report<unknown>['findings'][number] | undefined;
  refusalLines: number;
}> {
  const captured = await captureCommand(fn);
  const document = YAML.parse(captured.stdout) as Report<unknown>;
  const refusal = document.findings.find((finding) => finding.code === 'RESOURCE_CHECK_BROKEN');
  const refusalLines = captured.stderr.split(`error: ${refusal?.message ?? '<no refusal>'} [RESOURCE_CHECK_BROKEN]`).length - 1;
  return { captured, document, refusal, refusalLines };
}
