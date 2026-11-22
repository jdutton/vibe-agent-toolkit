/**
 * Reducing a repeat's vat-process records, and its debug facts, to what a `perf`
 * row says. Pure: no file is read here, so every rule is unit-testable.
 *
 * Three rules are the point of this module:
 *
 * - **CPU is summed over processes, wall never is.** A vat that overlaps its
 *   checks child runs two processes at once; their CPU adds, their lifetimes do
 *   not. The total wall is the command's own `wallMs`.
 * - **A surface's wall is banner to next banner**, the last to the bannering
 *   process's exit: sequential intervals of one process, so they partition its
 *   banner-to-exit span.
 * - **Disagreement is a refusal, never an average.** Repeats that ran a different
 *   number of vat processes, wrote different surfaces or reported different
 *   modes did not measure one thing.
 */

import { summarize } from './stats.js';
import type { GateDeclinedBy, PerfProcessDump, PerfStats, ValidateDebugFacts } from './types.js';

/** Microseconds in a millisecond. */
const US_PER_MS = 1000;

/** One surface's wall in one repeat. */
interface SurfaceWall {
  readonly name: string;
  readonly wallMs: number;
}

/**
 * Total CPU over processes: user plus system, one record per process.
 *
 * @param records - One repeat's vat-process records
 * @returns Milliseconds
 */
export function totalCpuMs(records: readonly PerfProcessDump[]): number {
  return records.reduce((sum, record) => sum + record.userCpuUs + record.systemCpuUs, 0) / US_PER_MS;
}

/**
 * Per-surface wall for the process that wrote the banners.
 *
 * A surface named twice in one run is `name`, then `name#2`, so each banner
 * keeps its own interval.
 *
 * @param record - A process that wrote banners
 * @returns One entry per banner, in order
 */
export function surfaceWalls(record: PerfProcessDump): SurfaceWall[] {
  const seen = new Map<string, number>();
  return record.banners.map((banner, index) => {
    const end = record.banners[index + 1]?.atMs ?? record.endMs;
    const count = (seen.get(banner.name) ?? 0) + 1;
    seen.set(banner.name, count);
    return { name: count === 1 ? banner.name : `${banner.name}#${String(count)}`, wallMs: end - banner.atMs };
  });
}

/** What a command's repeats' process records say. */
interface FoldedProcesses {
  readonly cpuMs: PerfStats | null;
  readonly surfaces: Record<string, PerfStats>;
}

/**
 * One repeat's surface walls, or the refusal when more than one process banners.
 *
 * @param records - One repeat's records
 * @param index - The repeat's position, for the message
 * @returns The walls (none when no process wrote a banner), or the refusal
 */
function repeatSurfaces(records: readonly PerfProcessDump[], index: number): SurfaceWall[] | string {
  const bannering = records.filter((record) => record.banners.length > 0);
  if (bannering.length > 1) {
    return (
      `repeat ${String(index + 1)}: ${String(bannering.length)} vat processes wrote \`Surface:\` banners;` +
      "which one's banners are the command's surfaces is not decidable"
    );
  }
  return bannering[0] === undefined ? [] : surfaceWalls(bannering[0]);
}

/**
 * Fold every repeat's records into total CPU and per-surface wall statistics.
 *
 * No records in any repeat is a legitimate answer (a command no vat package
 * owns), and gives `cpuMs: null`; records in some repeats only is a refusal.
 *
 * @param recordsPerRepeat - Each repeat's records, in repeat order
 * @returns The statistics, or why the repeats are not samples of one thing
 */
export function foldProcessRepeats(recordsPerRepeat: readonly (readonly PerfProcessDump[])[]): FoldedProcesses | string {
  const counts = recordsPerRepeat.map((records) => records.length);
  if (new Set(counts).size > 1) {
    return (
      `the repeats disagree on how many vat processes wrote a record (${counts.join('/')}): a process that was ` +
      'killed leaves none, or vat ran differently from one repeat to the next; either way the repeats are not ' +
      'samples of one thing'
    );
  }
  if (counts[0] === undefined || counts[0] === 0) return { cpuMs: null, surfaces: {} };

  const wallsPerRepeat: SurfaceWall[][] = [];
  for (const [index, records] of recordsPerRepeat.entries()) {
    const walls = repeatSurfaces(records, index);
    if (typeof walls === 'string') return walls;
    wallsPerRepeat.push(walls);
  }
  const names = wallsPerRepeat.map((walls) => walls.map((wall) => wall.name).join(' > '));
  if (new Set(names).size > 1) {
    return `the repeats disagree on which surfaces ran (${[...new Set(names)].join(' vs ')})`;
  }

  const surfaces: Record<string, PerfStats> = {};
  for (const [position, first] of (wallsPerRepeat[0] ?? []).entries()) {
    surfaces[first.name] = summarize(wallsPerRepeat.map((walls) => walls[position]?.wallMs ?? 0));
  }
  return { cpuMs: summarize(recordsPerRepeat.map((records) => totalCpuMs(records))), surfaces };
}

/** The mode a command's repeats reported. */
interface FoldedFacts {
  readonly checksOverlapped: 0 | 1 | null;
  readonly gateDeclinedBy: GateDeclinedBy | null;
}

/**
 * Fold every repeat's debug facts into the row's mode.
 *
 * A build that writes no dump leaves every repeat `null`, and the answer is
 * unknown (`null`), never 0. Some repeats with facts and some without, or
 * repeats that disagree on the mode or on what declined it, are a refusal: the
 * gate is a function of the build and the subject, so a repeat that differs is a
 * finding rather than noise to take a median over.
 *
 * @param factsPerRepeat - Each repeat's facts, or `null` where it wrote none
 * @returns The mode, or why the repeats disagree
 */
export function foldDebugFacts(factsPerRepeat: readonly (ValidateDebugFacts | null)[]): FoldedFacts | string {
  const present = factsPerRepeat.filter((facts): facts is ValidateDebugFacts => facts !== null);
  if (present.length === 0) return { checksOverlapped: null, gateDeclinedBy: null };
  if (present.length !== factsPerRepeat.length) {
    return `only ${String(present.length)} of ${String(factsPerRepeat.length)} repeats wrote debug facts, so whether the checks child overlapped is not one answer`;
  }
  const modes = new Set(present.map((facts) => `${String(facts.checksOverlapped)} ${JSON.stringify(facts.gateDeclinedBy)}`));
  if (modes.size > 1) {
    return `the repeats disagree on whether the checks child overlapped, or on what declined it: ${[...modes].join(' vs ')}`;
  }
  const [first] = present;
  return { checksOverlapped: first?.checksOverlapped ?? null, gateDeclinedBy: first?.gateDeclinedBy ?? null };
}
