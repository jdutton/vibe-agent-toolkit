/**
 * `vat-lab perf attribute`: a `perf run --cpu-prof-dir` report and its profiles,
 * folded into per-surface cost buckets.
 *
 * For each command and repeat, every vat process's main-thread profile is cut
 * into windows: a process that wrote `Surface:` banners by its banners (see
 * `bannerWindows`), any other as one `(process <n>)` window, `n` its start order
 * among the repeat's vat processes; every name in a repeat is distinct (see
 * `repeatWindows`). Repeats are read, attributed and dropped one at a time, so
 * only one repeat's profiles are in memory at once. Each window's samples are attributed with
 * the bucket rules, and a window's figure is the median over repeats, beside its
 * share of the window's median span. Worker threads' profiles are not read: a
 * window is one thread's wall.
 */

import { readdir, readFile } from 'node:fs/promises';

import { appendAll, everyInOrder, safePath } from '@vibe-agent-toolkit/utils';

import { messageOf } from '../../harness/dumps.js';

import { parseProfileName, selectVatProfiles } from './cpu-profiles.js';
import {
  attributeProfile,
  OTHER_BUCKET,
  bannerWindows,
  type BucketRule,
  type CpuProfile,
  CpuProfileSchema,
  type ProfileWindow,
  type WindowAttribution,
} from './profile-attribution.js';
import { summarize } from './stats.js';
import type { PerfBody, PerfProcessDump } from './types.js';

/** How many frames a window lists per bucket, and for `other`, where the missing rules show. */
const FRAMES_SHOWN = 5;
const OTHER_FRAMES_SHOWN = 12;

/** One bucket of one window, over repeats. */
interface BucketFigure {
  readonly bucket: string;
  readonly medianMs: number;
  /** `medianMs` over the window's median span. */
  readonly share: number;
  /** The heaviest frames in it (see `frameSignature`), mean milliseconds per repeat. */
  readonly frames: readonly { readonly frame: string; readonly meanMs: number }[];
}

/** One window of one command, over repeats. */
interface WindowFigure {
  readonly name: string;
  readonly spanMedianMs: number;
  readonly buckets: readonly BucketFigure[];
}

/** One command's attribution. */
interface CommandAttribution {
  readonly command: string;
  readonly repeats: number;
  readonly windows: readonly WindowFigure[];
  /** Per repeat and process: how far the probe's and the profile's clocks disagree about its start (ms). */
  readonly startSkewMs: readonly number[];
}

/**
 * Fold every repeat's window attributions into one figure per window name.
 *
 * @param perRepeat - Each repeat's attributions
 * @returns One figure per window name, in first-seen order
 */
export function foldWindows(perRepeat: readonly (readonly WindowAttribution[])[]): WindowFigure[] {
  const names = [...new Set(perRepeat.flatMap((windows) => windows.map((window) => window.name)))];
  return names.map((name) => {
    const found = perRepeat.map((windows) => windows.find((window) => window.name === name));
    const spanMedianMs = summarize(found.map((window) => window?.spanMs ?? 0)).medianMs;
    const bucketNames = [...new Set(found.flatMap((window) => Object.keys(window?.buckets ?? {})))];
    const buckets = bucketNames
      .map((bucket) => {
        const medianMs = summarize(found.map((window) => window?.buckets[bucket] ?? 0)).medianMs;
        const frames = heaviestFrames(found.map((window) => window?.frames[bucket]), bucket === OTHER_BUCKET ? OTHER_FRAMES_SHOWN : FRAMES_SHOWN);
        return { bucket, medianMs, share: spanMedianMs === 0 ? 0 : medianMs / spanMedianMs, frames };
      })
      .sort((a, b) => b.medianMs - a.medianMs);
    return { name, spanMedianMs, buckets };
  });
}

/**
 * A bucket's heaviest frames over repeats, as a mean per repeat.
 *
 * @param perRepeat - The bucket's frame tally in each repeat (`undefined` where it had no samples)
 * @param shown - How many to keep
 * @returns The heaviest first
 */
function heaviestFrames(
  perRepeat: readonly (Readonly<Record<string, number>> | undefined)[],
  shown: number,
): { readonly frame: string; readonly meanMs: number }[] {
  const total: Record<string, number> = {};
  for (const tally of perRepeat) {
    for (const [frame, ms] of Object.entries(tally ?? {})) total[frame] = (total[frame] ?? 0) + ms;
  }
  return Object.entries(total)
    .map(([frame, ms]) => ({ frame, meanMs: ms / perRepeat.length }))
    .sort((a, b) => b.meanMs - a.meanMs)
    .slice(0, shown);
}

/**
 * A namer that returns a name the first time and `<name> #<n>` the n-th time,
 * so a window is never folded into another that happens to share its name.
 *
 * @returns The namer
 */
function uniqueNames(): (name: string) => string {
  const seen = new Map<string, number>();
  return (name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} #${String(count)}`;
  };
}

/**
 * The windows of one repeat's processes, each process's own profile beside them.
 *
 * Every window name in a repeat is distinct, because {@link foldWindows} folds
 * repeats by name. A bannerless process is `(process <n>)`; the first process
 * with banners keeps their names; a later one's are qualified as
 * `<name> (process <n>)`; a banner repeated within a process is `<name> #<k>`.
 *
 * @param records - The repeat's vat-process records
 * @param profiles - Each pid's main-thread profile
 * @returns Per process: its profile and windows, or the refusal naming a missing profile
 */
export function repeatWindows(
  records: readonly PerfProcessDump[],
  profiles: ReadonlyMap<number, CpuProfile>,
): { readonly profile: CpuProfile; readonly windows: ProfileWindow[]; readonly startSkewMs: number }[] | string {
  const ordered = [...records].sort((a, b) => a.startMs - b.startMs);
  const firstWithBanners = ordered.find((record) => record.banners.length > 0);
  const unique = uniqueNames();
  const result: { profile: CpuProfile; windows: ProfileWindow[]; startSkewMs: number }[] = [];
  for (const [index, record] of ordered.entries()) {
    const profile = profiles.get(record.pid);
    if (profile === undefined) return `no main-thread profile for vat process ${String(record.pid)}`;
    const { windows, startSkewMs } = bannerWindows(record, profile);
    const process = `(process ${String(index + 1)})`;
    const nameOf = (name: string): string => {
      if (record.banners.length === 0) return process;
      return unique(record === firstWithBanners ? name : `${name} ${process}`);
    };
    result.push({ profile, windows: windows.map((window) => ({ ...window, name: nameOf(window.name) })), startSkewMs });
  }
  return result;
}

/**
 * Read one repeat's main-thread profiles, by pid: only the pids the report's
 * records name, so a file a reused directory still holds from another run is
 * never read, and a recorded pid with no main-thread profile, or two, is refused
 * (`selectVatProfiles`). A repeat that ran no vat process reads nothing.
 *
 * @param directory - `<cpu-prof-dir>/<command>/repeat-<n>`
 * @param pids - The repeat's recorded vat pids
 * @returns The profiles, or the refusal
 */
async function readRepeatProfiles(directory: string, pids: readonly number[]): Promise<Map<number, CpuProfile> | string> {
  if (pids.length === 0) return new Map();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    return `cannot read '${directory}': ${messageOf(error)}`;
  }
  const selected = selectVatProfiles(names, pids);
  if (typeof selected === 'string') return selected;
  const mains = selected.flatMap((name) => {
    const owner = parseProfileName(name);
    return owner?.tid === 0 ? [{ pid: owner.pid, name }] : [];
  });
  const parsed = await Promise.all(mains.map(async ({ pid, name }) => ({ pid, name, result: await readProfile(safePath.join(directory, name)) })));
  const profiles = new Map<number, CpuProfile>();
  for (const { pid, name, result } of parsed) {
    if (typeof result === 'string') return `'${name}': ${result}`;
    profiles.set(pid, result);
  }
  return profiles;
}

/**
 * Read and parse one `.cpuprofile`.
 *
 * @param file - Its path
 * @returns The profile, or why it is not one
 */
async function readProfile(file: string): Promise<CpuProfile | string> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf-8'));
  } catch (error) {
    return `cannot read it as JSON: ${messageOf(error)}`;
  }
  const parsed = CpuProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'not a V8 CPU profile';
}

/**
 * Attribute every command of a perf report from the profiles kept beside it.
 *
 * Repeats are handled one at a time, in order: a repeat's profiles are read,
 * attributed, and dropped before the next is read, so memory holds one repeat's
 * profiles however many commands and repeats the report has. A repeat that ran
 * no vat process contributes no windows.
 *
 * @param body - The report's body, captured with `--cpu-prof-dir`
 * @param profileDir - That directory
 * @param rules - The bucket rules, in priority order
 * @returns One attribution per command that was measured, or the first refusal
 */
export async function attributeReport(
  body: PerfBody,
  profileDir: string,
  rules: readonly BucketRule[],
): Promise<CommandAttribution[] | string> {
  const attributions: CommandAttribution[] = [];
  let refusal: string | null = null;
  await everyInOrder(
    body.commands.filter((candidate) => !candidate.failed),
    async (row) => {
      const perRepeat: WindowAttribution[][] = [];
      const startSkewMs: number[] = [];
      const complete = await everyInOrder(row.processes.entries(), async ([index, records]) => {
        const directory = safePath.join(profileDir, row.name, `repeat-${String(index + 1)}`);
        const profiles = await readRepeatProfiles(directory, records.map((record) => record.pid));
        const processes = typeof profiles === 'string' ? profiles : repeatWindows(records, profiles);
        if (typeof processes === 'string') {
          refusal = `${row.name} repeat ${String(index + 1)}: ${processes}`;
          return false;
        }
        perRepeat.push(processes.flatMap((process) => attributeProfile(process.profile, process.windows, rules)));
        appendAll(startSkewMs, processes.map((process) => process.startSkewMs));
        return true;
      });
      if (complete) attributions.push({ command: row.name, repeats: perRepeat.length, windows: foldWindows(perRepeat), startSkewMs });
      return complete;
    },
  );
  return refusal ?? attributions;
}

/**
 * Render attributions as text: per command, per window, its buckets and the heaviest unmatched leaves.
 *
 * @param attributions - From {@link attributeReport}
 * @returns The text
 */
export function renderAttributions(attributions: readonly CommandAttribution[]): string {
  const lines: string[] = [];
  const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;
  for (const command of attributions) {
    const skew = summarize([...command.startSkewMs]);
    lines.push(`${command.command} (${String(command.repeats)} repeats; probe/profile start skew median ${skew.medianMs.toFixed(1)}ms, max ${skew.maxMs.toFixed(1)}ms)`);
    for (const window of command.windows) {
      lines.push(`  ${window.name}: ${window.spanMedianMs.toFixed(1)}ms median span`);
      for (const bucket of window.buckets) {
        lines.push(`    ${bucket.bucket}: ${bucket.medianMs.toFixed(1)}ms (${pct(bucket.share)})`);
        for (const frame of bucket.frames) lines.push(`      ${frame.meanMs.toFixed(1)}ms ${frame.frame}`);
      }
    }
  }
  return lines.join('\n');
}
