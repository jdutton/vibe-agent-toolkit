/**
 * Reading the work-counter dumps one repeat left behind.
 *
 * Each vat process — the `vat` wrapper and the CLI it runs — writes one dump at
 * exit when `VAT_WORK_COUNTERS` names a directory. A repeat's reading is the SUM
 * over every dump in its directory: the work is the command's, whichever
 * process did it. A repeat with no `cli` dump is refused, because the wrapper
 * alone does almost nothing and would read as a command that did no work.
 */

import {
  WORK_COUNTER_NAMES,
  WORK_COUNTER_ROLES,
  WORK_COUNTERS_ENV,
  type WorkCounter,
  type WorkCounterRole,
} from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { type DumpKind, type DumpsRefusal, readDumpFiles, refuseDumps } from '../../harness/dumps.js';

import { type WorkCounterReading, WorkCounterNameSchema } from './types.js';

/** The role whose dump a repeat must hold. */
const CLI_ROLE: WorkCounterRole = 'cli';

/**
 * One process's dump. Strict, with no version field: a dump from a newer vat
 * carrying a counter this build does not know is refused; one from an older vat
 * missing a counter parses, and the counter is absent from the reading.
 */
export const WorkDumpSchema = z
  .object({
    pid: z.number().int().nonnegative(),
    role: z.enum(WORK_COUNTER_ROLES),
    counters: z.record(WorkCounterNameSchema, z.number().int().nonnegative()),
  })
  .strict();

/** One process's dump, as this build reads it. */
export type WorkDump = z.infer<typeof WorkDumpSchema>;

/** How the shared reader names and refuses this facet's dumps. */
const WORK_DUMP_KIND: DumpKind<WorkDump> = {
  noun: 'work-counter dump',
  producer: 'vat build (one whose work counters this lab reads)',
  schema: WorkDumpSchema,
  emptyDirectory: (directory) =>
    `no work-counter dumps in '${directory}'. Nothing wrote one, so there is no measurement — ` +
    `the usual cause is a vat build that predates work counters and ignores ${WORK_COUNTERS_ENV}. ` +
    'A build that has them always writes a dump, zeros included, so reporting zero work here would be a guess.',
};

/** One repeat's reading: every process's counts, summed. */
export interface MergedWorkDumps {
  /** How many dumps the repeat held. */
  readonly processes: number;
  /** Summed counts in the utils tuple order; a counter no dump carried is absent. */
  readonly counters: readonly WorkCounterReading[];
}

/** A repeat's reading, or why there is none. */
export type WorkDumpsRead = { readonly ok: true; readonly merged: MergedWorkDumps } | DumpsRefusal;

/**
 * Sum a repeat's dumps into one reading.
 *
 * @param dumps - Every dump the repeat's directory held
 * @returns The reading, or a refusal when no `cli` process wrote a dump
 */
export function mergeWorkDumps(dumps: readonly WorkDump[]): WorkDumpsRead {
  if (!dumps.some((dump) => dump.role === CLI_ROLE)) {
    return refuseDumps(
      `the repeat holds no '${CLI_ROLE}' dump (${String(dumps.length)} other) — the CLI, where the work ` +
        'happens, never wrote its counts, so summing the rest would report work that was not counted.',
    );
  }
  const totals = new Map<WorkCounter, number>();
  for (const dump of dumps) {
    for (const [name, count] of Object.entries(dump.counters) as [WorkCounter, number][]) {
      totals.set(name, (totals.get(name) ?? 0) + count);
    }
  }
  const counters = WORK_COUNTER_NAMES.flatMap((name): WorkCounterReading[] => {
    const count = totals.get(name);
    return count === undefined ? [] : [{ name, count }];
  });
  return { ok: true, merged: { processes: dumps.length, counters } };
}

/**
 * Read and sum one repeat's dumps.
 *
 * @param directory - The repeat's dump directory
 * @returns The reading, or the first refusal
 */
export async function readWorkDumps(directory: string): Promise<WorkDumpsRead> {
  const read = await readDumpFiles(directory, WORK_DUMP_KIND);
  return read.ok ? mergeWorkDumps(read.dumps) : read;
}

/**
 * One counter's count in a reading or a row.
 *
 * @param reading - Anything carrying counter readings
 * @param name - The counter
 * @returns Its count, or `undefined` when the measured vat did not emit it
 */
export function countOf(
  reading: { readonly counters: readonly WorkCounterReading[] },
  name: WorkCounter,
): number | undefined {
  return reading.counters.find((each) => each.name === name)?.count;
}

/**
 * Every counter whose count differs between two readings, or that only one of
 * them carries, in tuple order.
 *
 * @param left - One reading
 * @param right - The other
 * @returns The differing counters
 */
export function variedCounters(
  left: Pick<MergedWorkDumps, 'counters'>,
  right: Pick<MergedWorkDumps, 'counters'>,
): WorkCounter[] {
  return WORK_COUNTER_NAMES.filter((name) => countOf(left, name) !== countOf(right, name));
}
