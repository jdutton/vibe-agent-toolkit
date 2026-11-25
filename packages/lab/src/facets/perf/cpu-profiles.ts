/**
 * V8 CPU profiles of the vat processes a `perf` repeat ran (`perf run --cpu-prof-dir`).
 *
 * Node writes a profile for every thread of every node process that inherits
 * `--cpu-prof` on `NODE_OPTIONS`, named `CPU.<date>.<time>.<pid>.<tid>.<seq>.cpuprofile`
 * (thread 0 is the main thread). A repeat's profiles are written into its own dump
 * directory and kept only for vat's processes: the perf probe's records name those
 * pids, so a node process vat is not (an `npx`'s npm) is dropped rather than
 * attributed. Each vat process must have exactly one main-thread profile; a
 * process with none or two is a refusal, because a profile set that is missing a
 * process describes a different run.
 *
 * Profiling slows what it measures: a row captured with profiles has its wall
 * inflated by the sampler, so its timings are for attribution, not for a gate.
 */

import { mkdir, readdir, readFile } from 'node:fs/promises';

import { compareCodeUnits, isPathAbsentError, replaceFile, safePath } from '@vibe-agent-toolkit/utils';

import { messageOf } from '../../harness/dumps.js';

/** The profiles' directory's name inside a repeat's dump directory, beside the probe's records. */
export const CPU_PROFILE_DIRECTORY = 'cpuprofiles';

/** Node's profile file name: `CPU.<yyyymmdd>.<hhmmss>.<pid>.<tid>.<seq>.cpuprofile`. */
const PROFILE_NAME = /^CPU\.\d{8}\.\d{6}\.(\d+)\.(\d+)\.\d+\.cpuprofile$/u;

/** Which process and thread a profile file belongs to. */
interface ProfileOwner {
  readonly pid: number;
  readonly tid: number;
}

/**
 * The `NODE_OPTIONS` fragment that makes every node process write its profiles
 * into `directory`. Quoted and forward-slashed for the reasons `nodeOptionsWith`
 * gives in `harness/preload.ts`.
 *
 * @param directory - Absolute, forward-slashed directory
 * @returns The flags, to append to the run's `NODE_OPTIONS`
 */
export function cpuProfileNodeOptions(directory: string): string {
  return `--cpu-prof --cpu-prof-dir "${directory}"`;
}

/**
 * The process and thread a profile's file name names.
 *
 * @param name - A file name
 * @returns Its owner, or `null` when it is not a Node CPU profile's name
 */
export function parseProfileName(name: string): ProfileOwner | null {
  const match = PROFILE_NAME.exec(name);
  if (match === null) return null;
  return { pid: Number(match[1]), tid: Number(match[2]) };
}

/**
 * The profiles of vat's processes among `names`, or why the set is not one per process.
 *
 * @param names - Every file name in a repeat's profile directory
 * @param vatPids - The pids the perf probe recorded as vat's
 * @returns The names to keep (every thread of a vat process), or the refusal
 */
export function selectVatProfiles(names: readonly string[], vatPids: readonly number[]): readonly string[] | string {
  const vat = new Set(vatPids);
  const kept: string[] = [];
  const mainThreads = new Map<number, number>();
  for (const name of names) {
    const owner = parseProfileName(name);
    if (owner === null || !vat.has(owner.pid)) continue;
    kept.push(name);
    if (owner.tid === 0) mainThreads.set(owner.pid, (mainThreads.get(owner.pid) ?? 0) + 1);
  }
  const wrong = vatPids.filter((pid) => mainThreads.get(pid) !== 1);
  if (wrong.length > 0) {
    return (
      `vat process ${wrong.join(', ')} did not leave exactly one main-thread CPU profile; ` +
      'a profile set missing a process describes a different run'
    );
  }
  return kept.sort(compareCodeUnits);
}

/**
 * Copy one repeat's vat profiles out of its dump directory, which is removed when the repeat ends.
 *
 * A repeat that ran no vat process keeps nothing and is not a refusal: there is
 * no profile to miss, and a node process vat is not may still have left one.
 * A destination that already holds a file (a reused `--cpu-prof-dir`) is refused
 * rather than cleared: kept profiles from another run must never be mixed into
 * this one's, and deleting a user's directory is not this command's to do.
 *
 * @param repeatDirectory - The repeat's dump directory
 * @param destination - Where this repeat's profiles are kept
 * @param vatPids - The pids the perf probe recorded as vat's
 * @returns The kept profiles' paths, or the refusal
 */
export async function keepRepeatProfiles(
  repeatDirectory: string,
  destination: string,
  vatPids: readonly number[],
): Promise<readonly string[] | string> {
  if (vatPids.length === 0) return [];
  const existing = await readdir(destination).catch((error: unknown) => (isPathAbsentError(error) ? [] : error));
  if (!Array.isArray(existing)) return `could not read '${destination}': ${messageOf(existing)}`;
  if (existing.length > 0) return `'${destination}' already holds files; give --cpu-prof-dir a fresh directory`;
  const source = safePath.join(repeatDirectory, CPU_PROFILE_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(source);
  } catch (error) {
    return `could not read the CPU profile directory '${source}': ${messageOf(error)}`;
  }
  const selected = selectVatProfiles(names, vatPids);
  if (typeof selected === 'string') return selected;
  await mkdir(destination, { recursive: true });
  return await Promise.all(
    selected.map(async (name) => {
      const target = safePath.join(destination, name);
      await replaceFile(target, await readFile(safePath.join(source, name)));
      return target;
    }),
  );
}
