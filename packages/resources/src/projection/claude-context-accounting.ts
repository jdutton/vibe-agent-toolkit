/**
 * What the harness actually charges, given what {@link whatLoadsAt} says is loaded.
 *
 * ## The 4 MiB cliff, and how far it reaches
 *
 * The harness skips any memory file larger than 4,194,304 bytes whole — a cliff,
 * not a truncation, so charging such a file its own size is wrong by the whole
 * file. And a file the harness never read cannot have loaded its imports either,
 * so the skip PRUNES the subtree: a 5 MiB `CLAUDE.md` importing a 200 KB
 * handbook charges neither.
 *
 * ⭐ The cliff fires on EVERY row — `CLAUDE.md`, a rules file, an import. The
 * vendor's prose names `CLAUDE.md` only, and VAT used to stop there; the shipped
 * reader (`Cge` → `Lx(…, g3)`, transcribed in
 * `docs/external/claude-code-memory-loader.md`) is the one every memory file
 * goes through.
 *
 * A member reachable by any route that does not pass through an oversize file is
 * NOT pruned. A `README.md` that is both a root rule's neighbour and the import
 * of a 5 MiB `CLAUDE.md` still loads.
 *
 * ## No threshold
 *
 * Nothing here compares a total against a number. §8.1's 12,000 was calibrated
 * with `estimateTokens` at ONE import level and is uncalibrated at four hops; a
 * gate that fires wrongly teaches people to ignore it.
 *
 * The tokens a row carries are `blobs.claudeInjectedTokens` — the text the
 * harness injects, frontmatter and block-level comments removed and trimmed —
 * while the cliff below reads `blobs.bytes`, the file's own size, because the
 * harness skips on the size it `stat`s, before it reads a byte.
 *
 * ## Nothing here is a floor, and nothing here is a ceiling
 *
 * The totals are an estimate with named, directional uncertainty — the named part
 * being `claude-context-limits.ts`, which the command publishes beside every
 * number this module produces. `unknownTokenRows`, `skippedOversizeRows` and
 * `prunedRows` are COUNTED rather than folded into a zero for the same reason: a
 * sum that silently absorbed them would read as complete.
 */

import type { LoadedContextAnswer, LoadedRow } from './claude-context-query.js';

/**
 * The harness's memory-file size cliff, in bytes — `g3` in the shipped reader.
 *
 * A transcribed vendor quantity cited at its use, not a VAT constant anyone bumps.
 * The comparison against it is strictly greater-than: the vendor loads a file of
 * *up to* 4 MiB in full, so a file measuring exactly this is charged.
 */
export const OVERSIZE_BYTES = 4 * 1024 * 1024;

/** Why a row does or does not contribute to a total. */
export const SIZE_CLIFF_STATES = ['loaded', 'oversize-skipped', 'pruned-by-oversize', 'unmeasured'] as const;

/** The members the fold below compares against, named once. */
const [LOADED, OVERSIZE_SKIPPED, PRUNED_BY_OVERSIZE, UNMEASURED] = SIZE_CLIFF_STATES;

/**
 * The 4 MiB cliff's verdict on one row — NOT whether it is paid at launch.
 *
 * ⛔ No value may be spelled like a `LaunchCharge`: both ride on one
 * `claude_context_loads` row, and `charge = 'charged'` once filtered nothing while
 * reading as the launch-cost filter. Pinned by a disjointness test.
 */
export type SizeCliffState = (typeof SIZE_CLIFF_STATES)[number];

/** A loaded row with its charge decided. */
export interface AccountedRow extends LoadedRow {
  readonly sizeCliff: SizeCliffState;
}

/**
 * The sums, with the unchargeable rows COUNTED rather than folded into zero.
 *
 * `unknownTokenRows > 0` is what stops a total being read as complete.
 */
export interface ContextTotals {
  readonly alwaysTokens: number;
  readonly onDemandTokens: number;
  readonly unknownTokenRows: number;
  readonly skippedOversizeRows: number;
  readonly prunedRows: number;
}

/** The accounted answer. */
export interface AccountedContext {
  readonly rows: readonly AccountedRow[];
  readonly totals: ContextTotals;
}

/**
 * Decide each row's charge and sum what remains.
 *
 * Every row the query returned comes back, in the order it arrived — a row that
 * costs nothing is still part of the answer, and dropping it would leave the
 * reader unable to tell "not loaded" from "never seen". The input answer is not
 * mutated; the charge lands on a copy.
 *
 * @param answer - The query's answer
 * @returns Every row with its charge, and the totals
 */
export function account(answer: LoadedContextAnswer): AccountedContext {
  // ⚠️ `bytes !== null` rather than `(bytes ?? 0)`: a row with no blob has an
  // UNKNOWN size, which is a state of its own, and a coalesced zero would quietly
  // assert it is under the cliff. It is not over it either — an unmeasured file is
  // charged nothing and counted in `unknownTokenRows`, never skipped as oversize.
  const oversizePaths = new Set(
    answer.rows
      .filter((row) => row.bytes !== null && row.bytes > OVERSIZE_BYTES)
      .map((row) => row.path),
  );

  // Hoisted out of the map: the fixpoint is a property of the whole row set, so
  // recomputing it per row would be the same answer at N times the cost.
  const broken = brokenRoutes(answer.rows, oversizePaths);

  const rows = answer.rows.map((row) => ({ ...row, sizeCliff: sizeCliffOf(row, oversizePaths, broken) }));
  return { rows, totals: totalsOf(rows) };
}

/**
 * Every path whose ONLY import routes pass through a file the cliff skipped.
 *
 * Computed by propagation rather than per-row, because a single admission names
 * only its closure root and its immediate importer — a skip three hops up would
 * be invisible to a check that looked at those two alone. Iterating to a fixpoint
 * over the row set closes that: a row is broken when every import admission it
 * carries is anchored to a broken or oversize `viaPath`, and a row with any
 * non-import admission is never broken at all.
 *
 * ⚠️ The case that separates this from a single pass is an oversize file in the
 * MIDDLE of a closure, not at its root. A descendant of an oversize ROOT is
 * caught without iterating, because every import admission names its root — so a
 * fixture built only on oversize roots cannot tell the two implementations apart
 * however deep it goes.
 *
 * Bounded by the row count, which is the members of one directory's instruction
 * set — tens, not thousands.
 *
 * @param rows - Every loaded row
 * @param oversizePaths - Paths of rows past the cliff
 * @returns The paths whose every route is broken
 */
function brokenRoutes(
  rows: readonly LoadedRow[],
  oversizePaths: ReadonlySet<string>,
): ReadonlySet<string> {
  const broken = new Set(oversizePaths);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (broken.has(row.path) || !everyRouteBroken(row, broken)) continue;
      broken.add(row.path);
      grew = true;
    }
  }
  return broken;
}

/**
 * Does every admission on this row arrive through a file already known broken?
 *
 * ⛔ An EMPTY admission list answers false. `[].every(…)` is `true`, so without
 * this the query's own "no route reached this" row would be pruned as though
 * every route into it were broken — an under-report produced by a vacuous truth.
 * Nothing loaded such a row, but nothing broke it either.
 *
 * An import whose `viaPath` is null is the query's unattributed row. It is not
 * evidence of a broken route, so it only counts as broken when its closure ROOT
 * is: guessing the other way would prune a member that really loads.
 *
 * @param row - The loaded row
 * @param broken - Paths known broken so far in the propagation
 * @returns True when the row has admissions and all of them are import routes
 *   anchored to a broken file
 */
function everyRouteBroken(row: LoadedRow, broken: ReadonlySet<string>): boolean {
  if (row.admissions.length === 0) return false;
  return row.admissions.every(
    (admission) =>
      admission.kind === 'import'
      && (broken.has(admission.rootPath)
        || (admission.viaPath !== null && broken.has(admission.viaPath))),
  );
}

/**
 * One row's charge state.
 *
 * Order matters: the cliff outranks everything (a skipped file's own size is not
 * charged however else it was admitted), then an unmeasurable size, then the
 * prune. A row reachable by ANY route that does not pass through a skipped file
 * still loads — dropping it would under-report, which is the one direction a
 * context-budget answer cannot tolerate.
 *
 * @param row - The loaded row
 * @param oversizePaths - Paths of rows past the cliff
 * @param broken - Every path whose every import route passes through one
 * @returns The charge state
 */
function sizeCliffOf(
  row: LoadedRow,
  oversizePaths: ReadonlySet<string>,
  broken: ReadonlySet<string>,
): SizeCliffState {
  if (oversizePaths.has(row.path)) return OVERSIZE_SKIPPED;
  if (row.tokens === null) return UNMEASURED;
  return broken.has(row.path) ? PRUNED_BY_OVERSIZE : LOADED;
}

/**
 * Sum the charged rows and count the rest.
 *
 * The four states are mutually exclusive and every row lands in exactly one
 * bucket, which is what lets a reader add the counts back to the row total and
 * find nothing missing.
 *
 * @param rows - Every accounted row
 * @returns The totals
 */
function totalsOf(rows: readonly AccountedRow[]): ContextTotals {
  let alwaysTokens = 0;
  let onDemandTokens = 0;
  let unknownTokenRows = 0;
  let skippedOversizeRows = 0;
  let prunedRows = 0;

  for (const row of rows) {
    // ⚠️ The `?? 0` on the two summing branches is a COMPILER obligation, not a
    // guard: `sizeCliffOf` returns `unmeasured` for every null-token row before
    // either branch can be reached, so no input can exercise the zero. It cannot
    // be deleted (the field is `number | null`) and it cannot be tested.
    if (row.sizeCliff === UNMEASURED) unknownTokenRows += 1;
    else if (row.sizeCliff === OVERSIZE_SKIPPED) skippedOversizeRows += 1;
    else if (row.sizeCliff === PRUNED_BY_OVERSIZE) prunedRows += 1;
    else if (row.loadClass === 'always') alwaysTokens += row.tokens ?? 0;
    else onDemandTokens += row.tokens ?? 0;
  }

  return { alwaysTokens, onDemandTokens, unknownTokenRows, skippedOversizeRows, prunedRows };
}
