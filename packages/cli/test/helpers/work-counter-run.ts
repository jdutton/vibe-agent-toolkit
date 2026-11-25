/**
 * One run of the CLI with its work counters on, read back: the one way a system test
 * runs a verb to hold what it counted (`VAT_WORK_COUNTERS`), and, when asked, what it
 * read at the `node:fs` boundary (`fs-read-probe`).
 */

import type { SpawnSyncReturns } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

import { safePath, WORK_COUNTERS_ENV, type WorkCounterDump, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import { VALIDATE_DEBUG_FACTS_ENV, type ValidateDebugFacts } from '../../src/commands/validate-debug-facts.js';
import { PROJECTION_STORE_ENV, PROJECTION_STORE_OFF } from '../../src/utils/projection-store.js';
import { executeCli } from '../system/test-common.js';
import { preload } from '../system/test-helpers/checks-phase.js';

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
  /**
   * The core count the supervising process reports (`parent-only-cores.mjs`), or `null` for the
   * host's. `vat validate`'s checks overlap gate reads it: 1 runs the checks child sequential, 2
   * lets it overlap a warm resources phase. A run whose counts depend on the mode states it, and
   * reads back the mode it got ({@link WorkCounterRun.debugFacts}).
   */
  readonly cores: number | null;
}

/** One run, read back. */
interface WorkCounterRun {
  readonly result: SpawnSyncReturns<string>;
  /** Every CLI process's dump (`role: 'cli'`), in no order. */
  readonly dumps: readonly WorkCounterDump[];
  /** The probe's dump directory, or `null` when the run had no probe. */
  readonly probeDir: string | null;
  /**
   * `vat validate`'s debug facts (`VAT_VALIDATE_DEBUG_FACTS`), one per validate process, read on
   * every run that pins its cores: the checks mode the run got, and the gate condition that
   * declined it. Empty for a run that does not pin its cores, or a verb that writes none.
   */
  readonly debugFacts: readonly ValidateDebugFacts[];
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
  const factsDir = options.cores === null ? null : suite.createTempDir();
  const tmp = options.tmpDir;
  const probeEnv = probeDir !== null && options.probeRoot !== null ? readProbeEnv(probeDir, options.probeRoot) : {};
  const coresEnv: Record<string, string> = options.cores === null ? {} : { VAT_TEST_CORES: String(options.cores) };
  const nodeOptions = [probeEnv['NODE_OPTIONS'], options.cores === null ? undefined : preload('parent-only-cores.mjs')].filter((option) => option !== undefined);
  const result = await executeCli(suite.binPath, [...args], {
    cwd,
    env: {
      ...countedStoreEnv(options, workDir),
      ...(tmp !== null && { TMPDIR: tmp, TEMP: tmp, TMP: tmp }),
      ...probeEnv,
      ...coresEnv,
      ...(factsDir !== null && { [VALIDATE_DEBUG_FACTS_ENV]: factsDir }),
      ...(nodeOptions.length > 0 && { NODE_OPTIONS: nodeOptions.join(' ') }),
    },
  });
  const dumps = cliDumps<WorkCounterDump>(workDir);
  if (probeDir !== null) expect(probedReads(probeDir).dumps, `${args.join(' ')}: the read probe ran\n${result.stderr}`).toBeGreaterThan(0);
  const debugFacts = factsDir === null
    ? []
    : readdirSync(factsDir).map((name) => JSON.parse(readFileSync(safePath.join(factsDir, name), 'utf-8')) as ValidateDebugFacts);
  return { result, dumps, probeDir, debugFacts };
}

/**
 * A counted run's store and counter environment.
 *
 * @param store - The run's `VAT_CACHE_DIR`, and whether the projection store is off
 * @param countsDir - Where the work counters are dumped
 * @returns The variables
 */
export function countedStoreEnv(store: { readonly cacheDir: string; readonly storeOff: boolean }, countsDir: string): Record<string, string> {
  return {
    [VAT_CACHE_DIR_ENV]: store.cacheDir,
    ...(store.storeOff && { [PROJECTION_STORE_ENV]: PROJECTION_STORE_OFF }),
    [WORK_COUNTERS_ENV]: countsDir,
  };
}

/**
 * The dumps one directory holds, of CLI processes only.
 *
 * @param directory - A dump directory
 * @returns Each dump, parsed
 */
export function cliDumps<T extends { readonly role: string }>(directory: string): T[] {
  return readdirSync(directory)
    .map((name) => JSON.parse(readFileSync(safePath.join(directory, name), 'utf-8')) as T)
    .filter((dump) => dump.role === 'cli');
}
