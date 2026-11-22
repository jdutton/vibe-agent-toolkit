/**
 * One run of the CLI with its git spawn log and its work counters on, read back per CLI process:
 * every git process each one started (`VAT_GIT_SPAWNS`), beside what it counted
 * (`VAT_WORK_COUNTERS`), so a test names each spawn its `git.calls` counts.
 */

import type { SpawnSyncReturns } from 'node:child_process';

import { GIT_SPAWNS_ENV, type GitSpawnDump, type WorkCounterDump } from '@vibe-agent-toolkit/utils';

import { executeCli } from '../system/test-common.js';

import { cliDumps, countedStoreEnv } from './work-counter-run.js';

/** What a run needs of its suite: the CLI build, and private directories. */
interface GitSpawnSuite {
  readonly binPath: string;
  readonly createTempDir: () => string;
}

/** One CLI process of a run: its counts and its spawn log. */
export interface GitSpawnProcess {
  readonly counters: WorkCounterDump;
  readonly spawns: GitSpawnDump;
}

/** One run, read back. */
export interface GitSpawnRun {
  readonly result: SpawnSyncReturns<string>;
  /** Every CLI process (`role: 'cli'`), in no order. */
  readonly processes: readonly GitSpawnProcess[];
}

/**
 * Run `vat <args>` in `cwd` over the store in `cacheDir`, with the git spawn log and the work
 * counters on, and pair each CLI process's two dumps by pid.
 *
 * @param suite - The suite's build and temp directories
 * @param cwd - Where the verb runs
 * @param args - The verb and its arguments
 * @param options - The run's `VAT_CACHE_DIR`, and whether the projection store is off
 * @returns The run
 * @throws Error when a process filed one dump without the other
 */
export async function runWithGitSpawns(
  suite: GitSpawnSuite,
  cwd: string,
  args: readonly string[],
  options: { readonly cacheDir: string; readonly storeOff: boolean },
): Promise<GitSpawnRun> {
  const countsDir = suite.createTempDir();
  const spawnsDir = suite.createTempDir();
  const result = await executeCli(suite.binPath, [...args], {
    cwd,
    env: { ...countedStoreEnv(options, countsDir), [GIT_SPAWNS_ENV]: spawnsDir },
  });
  const counters = cliDumps<WorkCounterDump>(countsDir);
  const spawns = new Map(cliDumps<GitSpawnDump>(spawnsDir).map((dump) => [dump.pid, dump]));
  const processes = counters.map((dump): GitSpawnProcess => {
    const log = spawns.get(dump.pid);
    if (log === undefined) throw new Error(`process ${String(dump.pid)} filed its counts and no git spawn log`);
    return { counters: dump, spawns: log };
  });
  if (spawns.size !== processes.length) throw new Error(`${String(spawns.size)} git spawn logs for ${String(processes.length)} count dumps`);
  return { result, processes };
}
