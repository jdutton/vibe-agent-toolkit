/**
 * One run of the CLI with its work counters on, read back: the one way a system test
 * runs a verb to hold what it counted (`VAT_WORK_COUNTERS`), and, when asked, what it
 * read at the `node:fs` boundary (`fs-read-probe`).
 */

import type { SpawnSyncReturns } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

import { VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/resources';
import { safePath, WORK_COUNTERS_ENV, type WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import { PROJECTION_STORE_ENV, PROJECTION_STORE_OFF } from '../../src/utils/projection-store.js';
import { executeCli } from '../system/test-common.js';

import { probedReads, readProbeEnv } from './fs-read-probe.js';

/** What a run needs of its suite: the CLI build, and private directories. */
interface WorkCounterSuite {
  readonly binPath: string;
  readonly createTempDir: () => string;
}

/** How one run is set up. Every field is stated: none has a default a caller could forget. */
interface WorkCounterRunOptions {
  /** The run's `VAT_CACHE_DIR`. */
  readonly cacheDir: string;
  /** The run's `TMPDIR`, `TEMP` and `TMP`, or `null` to leave the host's. */
  readonly tmpDir: string | null;
  /** Whether the projection store is off (`VAT_PROJECTION_STORE=off`). */
  readonly storeOff: boolean;
  /** The directory under which the fs-read probe counts reads, or `null` for no probe. */
  readonly probeRoot: string | null;
}

/** One run, read back. */
interface WorkCounterRun {
  readonly result: SpawnSyncReturns<string>;
  /** Every CLI process's dump (`role: 'cli'`), in no order. */
  readonly dumps: readonly WorkCounterDump[];
  /** The probe's dump directory, or `null` when the run had no probe. */
  readonly probeDir: string | null;
}

/**
 * Run `vat <args>` in `cwd` with its work counters on, and read every CLI process's
 * dump back. With a probe, asserts it ran (a dump was written), so an empty read map
 * means nothing was read rather than nothing was watched.
 *
 * @param suite - The suite's build and temp directories
 * @param cwd - Where the verb runs
 * @param args - The verb and its arguments
 * @param options - The run's directories, store and probe
 * @returns The run
 */
export async function runWithWorkCounters(
  suite: WorkCounterSuite,
  cwd: string,
  args: readonly string[],
  options: WorkCounterRunOptions,
): Promise<WorkCounterRun> {
  const workDir = suite.createTempDir();
  const probeDir = options.probeRoot === null ? null : suite.createTempDir();
  const tmp = options.tmpDir;
  const result = await executeCli(suite.binPath, [...args], {
    cwd,
    env: {
      [VAT_CACHE_DIR_ENV]: options.cacheDir,
      ...(options.storeOff && { [PROJECTION_STORE_ENV]: PROJECTION_STORE_OFF }),
      [WORK_COUNTERS_ENV]: workDir,
      ...(tmp !== null && { TMPDIR: tmp, TEMP: tmp, TMP: tmp }),
      ...(probeDir !== null && options.probeRoot !== null && readProbeEnv(probeDir, options.probeRoot)),
    },
  });
  const dumps = readdirSync(workDir)
    .map((name) => JSON.parse(readFileSync(safePath.join(workDir, name), 'utf-8')) as WorkCounterDump)
    .filter((dump) => dump.role === 'cli');
  if (probeDir !== null) expect(probedReads(probeDir).dumps, `${args.join(' ')}: the read probe ran\n${result.stderr}`).toBeGreaterThan(0);
  return { result, dumps, probeDir };
}
