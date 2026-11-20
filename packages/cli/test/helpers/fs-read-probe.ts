/**
 * The system tests' side of the `node:fs` content-read probe (`fs-read-probe.cjs`):
 * the environment that injects it into every VAT process a run starts, and the
 * per-path read counts read back from the dumps those processes leave.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/** The probe itself: plain JavaScript, which every supported Node loads as a `--require` preload. */
const PROBE_PATH = safePath.resolve(safePath.join(import.meta.dirname, 'fs-read-probe.cjs'));

/** One thread's dump. */
interface ProbeDump {
  readonly pid: number;
  readonly threadId: number;
  readonly reads: Readonly<Record<string, number>>;
}

/**
 * The environment that turns the probe on in every process of a run.
 *
 * @param dumpDir - An empty directory each thread writes its dump to
 * @param root - The directory under which reads are counted
 * @returns Variables to merge into the run's environment
 */
export function readProbeEnv(dumpDir: string, root: string): Record<string, string> {
  return {
    NODE_OPTIONS: `--require ${JSON.stringify(PROBE_PATH)}`,
    VAT_TEST_READ_PROBE_DIR: dumpDir,
    VAT_TEST_READ_PROBE_ROOT: root,
  };
}

/**
 * Content reads per root-relative path, summed over every thread of every process
 * that wrote a dump.
 *
 * @param dumpDir - The directory given to {@link readProbeEnv}
 * @returns Reads per path, and how many dumps were summed
 */
export function probedReads(dumpDir: string): { readonly reads: Map<string, number>; readonly dumps: number } {
  const reads = new Map<string, number>();
  const names = readdirSync(dumpDir).filter((name) => name.startsWith('reads-'));
  for (const name of names) {
    const dump = JSON.parse(readFileSync(safePath.join(dumpDir, name), 'utf-8')) as ProbeDump;
    for (const [path, count] of Object.entries(dump.reads)) reads.set(path, (reads.get(path) ?? 0) + count);
  }
  return { reads, dumps: names.length };
}
