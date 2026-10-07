/**
 * Shared scaffolding for the system tests that put a real named pipe in a
 * reader's way: opening one for reading blocks until a writer appears, so each
 * run is raced against a deadline instead of being allowed to hang the suite.
 * POSIX only — the pipe is made by spawning `mkfifo`.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';

import { afterEach, beforeEach } from 'vitest';

import { normalizedTmpdir } from '../../src/path-utils.js';
import { safePath } from '../../src/path.js';

/** How long a run may take before the test calls it hung on the pipe. */
const HANG_MS = 3000;

/** The outcome of `run` — `'done'`, or what it rejected with — or `'hung on the pipe'` past the deadline. */
export async function outcomeOrHang(run: Promise<unknown>): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const hung = new Promise((resolve) => { timer = setTimeout(() => resolve('hung on the pipe'), HANG_MS); });
    return await Promise.race([run.then(() => 'done', (error: unknown) => error), hung]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A fresh temp dir per test holding a named pipe at `pipeRel` (its parents
 * made), removed afterwards — after releasing any reader a failing
 * implementation left blocked: opening read-write never blocks, and is a writer.
 */
export function setupFifoSuite(prefix: string, pipeRel: string): { dir: () => string; fifo: () => string } {
  let dir = '';
  const fifo = (): string => safePath.join(dir, pipeRel);
  beforeEach(async () => {
    dir = await mkdtemp(safePath.join(normalizedTmpdir(), prefix));
    await mkdir(safePath.join(fifo(), '..'), { recursive: true });
    execFileSync('mkfifo', [fifo()]);
  });
  afterEach(async () => {
    await (await open(fifo(), 'r+')).close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir: () => dir, fifo };
}
