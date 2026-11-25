/**
 * One `vat validate` run with its work counters and the `node:fs` read probe on, split
 * into the `vat validate` process (the parent, whose dump carries the `resources` phase)
 * and every other CLI process (the supervised checks child). Shared by the system files
 * that count what `vat validate` spends.
 */

import type { WorkCounter, WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, expect } from 'vitest';

import { createSuiteContext, join } from '../system/test-common.js';

import { probedReadsOf } from './fs-read-probe.js';
import { runWithWorkCounters } from './work-counter-run.js';

/** A suite's build and temp directories. */
type ValidateCountsSuite = ReturnType<typeof createSuiteContext>;

/**
 * A suite context with its hooks registered: the build located before the file's tests,
 * every temp directory removed after them.
 *
 * @param prefix - The temp directories' prefix
 * @param testFileUrl - The calling file's `import.meta.url`, which locates the CLI build
 * @returns The context
 */
export function validateCountsSuite(prefix: string, testFileUrl: string): ValidateCountsSuite {
  const context = createSuiteContext(prefix, testFileUrl);
  beforeAll(() => {
    context.setup();
  });
  afterAll(() => {
    context.cleanup();
  });
  return context;
}

/** One arm's private store and temp directory, and whether its store is on. */
export interface ValidateArm {
  readonly storeDir: string;
  readonly tmpDir: string;
  readonly storeOff: boolean;
}

/**
 * A fresh arm: nothing cached anywhere it can reach.
 *
 * @param suite - The suite whose temp directories it uses
 * @param storeOff - Whether its projection store is off
 * @returns The arm
 */
export function freshValidateArm(suite: ValidateCountsSuite, storeOff: boolean): ValidateArm {
  return { storeDir: suite.createTempDir(), tmpDir: suite.createTempDir(), storeOff };
}

/** What one `vat validate` run counted. */
export interface ValidateRunCounts {
  /** The `vat validate` process's own counters. */
  readonly parent: Readonly<Record<WorkCounter, number>>;
  /** Its counters per phase. */
  readonly phases: Readonly<Record<string, Readonly<Record<WorkCounter, number>>>>;
  /** Every other CLI process's counters, summed: the supervised checks child. */
  readonly children: Readonly<Record<WorkCounter, number>>;
  /** Content reads per path in the parent process, from the probe, relative to the probe's root. */
  readonly parentReads: ReadonlyMap<string, number>;
  /** Content reads per path in the child processes, from the probe. */
  readonly childReads: ReadonlyMap<string, number>;
  /** The run's exit status. */
  readonly status: number | null;
  /** The run's report. */
  readonly stdout: string;
}

/** Sum counter records. */
function summed(records: ReadonlyArray<Readonly<Record<WorkCounter, number>>>): Record<WorkCounter, number> {
  const sum = {} as Record<WorkCounter, number>;
  for (const record of records) {
    for (const [name, value] of Object.entries(record) as Array<[WorkCounter, number]>) sum[name] = (sum[name] ?? 0) + value;
  }
  return sum;
}

/**
 * Run `vat validate` once in `cwd` and read back what it counted. The probe is rooted one
 * directory above `cwd`, so a file just outside the project is counted too.
 *
 * @param suite - The suite's build and temp directories
 * @param cwd - The project root
 * @param arm - Where its caches live
 * @returns The parent's counts, per phase, the children's, and the probe's reads
 */
export async function validateCounts(suite: ValidateCountsSuite, cwd: string, arm: ValidateArm): Promise<ValidateRunCounts> {
  const { result, dumps: cli, probeDir } = await runWithWorkCounters(suite, cwd, ['validate'], {
    cacheDir: arm.storeDir,
    tmpDir: arm.tmpDir,
    storeOff: arm.storeOff,
    probeRoot: join(cwd, '..'),
    cores: null,
  });
  if (probeDir === null) throw new Error('validateCounts runs with the probe');
  // Positive control: the resources phase ran, so its counts cover it.
  expect(result.stdout, result.stderr).toContain('name: resources');

  const parent = cli.filter((dump) => 'resources' in dump.phases);
  expect(parent, 'exactly one dump is the validate process').toHaveLength(1);
  const parentDump = parent[0] as WorkCounterDump;
  // Positive control: the probe ran in the parent.
  expect(probedReadsOf(probeDir, (pid) => pid === parentDump.pid).dumps).toBeGreaterThan(0);
  return {
    parent: parentDump.counters,
    phases: parentDump.phases,
    children: summed(cli.filter((dump) => dump !== parentDump).map((dump) => dump.counters)),
    parentReads: probedReadsOf(probeDir, (pid) => pid === parentDump.pid).reads,
    childReads: probedReadsOf(probeDir, (pid) => pid !== parentDump.pid).reads,
    status: result.status,
    stdout: result.stdout,
  };
}

/**
 * A config file: read by the config loader in every process, outside the population.
 *
 * @param path - A probed path
 * @returns Whether it is a VAT config
 */
export function isConfig(path: string): boolean {
  return path.endsWith('vibe-agent-toolkit.config.yaml');
}

/**
 * Paths the probe saw read more than once, config files aside.
 *
 * @param reads - Reads per path, from {@link ValidateRunCounts}
 * @returns The paths
 */
export function readTwice(reads: ReadonlyMap<string, number>): string[] {
  return [...reads].filter(([path, count]) => count > 1 && !isConfig(path)).map(([path]) => path);
}

/**
 * The probe's key for a project-relative path: the probe is rooted one directory above the project.
 *
 * @param cwd - The project root the run ran in
 * @param path - A project-relative path
 * @returns The key {@link ValidateRunCounts.parentReads} counts it under
 */
export function probed(cwd: string, path: string): string {
  const name = cwd.slice(cwd.lastIndexOf('/') + 1);
  return `${name}/${path}`;
}
