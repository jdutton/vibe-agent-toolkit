/**
 * `vat pipeline compare <before> <after>` — what moved between two captures.
 *
 * The comparison itself is `qa-snapshot/diff.ts` and the rendering is
 * `qa-snapshot/render.ts`; this file decides what gets printed and, crucially,
 * what the exit code means.
 *
 * ## The one answer this command must never give
 *
 * `compareSnapshots` signals a refusal by returning an **empty `deltas` array**
 * together with a constraint string starting `REFUSED:` — which is what happens
 * on a `formatVersion` mismatch, where the artifact sets are not the same shape
 * and no comparison was attempted at all. An empty `deltas` otherwise renders as
 * "nothing changed" and would exit 0, telling a reader that a refactor moved
 * nothing when in fact nothing was compared. {@link isRefusal} detects the
 * prefix explicitly and the run exits 2.
 *
 * The other constraint prefixes — `MASKED:`, `CORPUS:`, `PLATFORM:`, `ADDED:`,
 * `REMOVED:` — are stable and greppable, and are surfaced to the reader by the
 * renderer, but **nothing here branches on them**. They narrow what a comparison
 * may be read to mean; they do not change whether it ran.
 */

import {
  compareSnapshots,
  readSnapshot,
  renderCompareSummary,
  renderDetailHeader,
  renderSelectorHelp,
  renderUnifiedDiff,
  type ArtifactDelta,
  type CompareReport,
  type LoadedSnapshot,
} from '../../qa-snapshot/index.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeStdoutSync } from '../../utils/output.js';

/** Default cap on returned diff lines under `--detail`. */
export const DEFAULT_DIFF_MAX_LINES = 200;

/** Default number of unchanged lines kept around each diff hunk. */
export const DEFAULT_DIFF_CONTEXT = 3;

/** Prefix `compareSnapshots` puts on the constraint when it refused outright. */
const REFUSAL_PREFIX = 'REFUSED:';

/** Every artifact on both sides agreed. */
const EXIT_IDENTICAL = 0;

/** At least one artifact moved. */
const EXIT_CHANGED = 1;

/** Refused, selector matched nothing, or a system error. */
const EXIT_REFUSED = 2;

/** What {@link reportComparison} is asked to print. */
export interface ComparisonOutput {
  /** Artifact name to drill into; absent means print the summary. */
  detail?: string;
  /** Cap on returned diff lines. */
  maxLines: number;
  /** Unchanged lines kept around each hunk. */
  context: number;
}

/** Parsed `vat pipeline compare` flags. */
export interface PipelineCompareOptions {
  detail?: string;
  maxLines?: number;
  context?: number;
  debug?: boolean;
}

/**
 * Compare two loaded snapshots, print the result, and decide the exit code.
 *
 * Shared with `vat pipeline snapshot --compare`, which is defined as "run
 * exactly the comparison `compare` would" — so it must be one implementation,
 * not two that agree today.
 *
 * @param before - The earlier snapshot
 * @param after - The later snapshot
 * @param output - Whether to drill into one artifact, and the diff bounds
 * @returns The process exit code: 0 identical, 1 changed, 2 refused or no such selector
 */
export function reportComparison(
  before: LoadedSnapshot,
  after: LoadedSnapshot,
  output: ComparisonOutput,
): number {
  const report = compareSnapshots(before, after);

  // Capture-time warnings first, from BOTH sides. They record walk-route lanes,
  // lanes whose builder threw and skipped halves — a comparison read without
  // them can be actively misleading, so they precede anything it says.
  writeStdoutSync(renderCaptureWarnings(before, after));

  if (isRefusal(report)) {
    writeStdoutSync(renderCompareSummary(report));
    return EXIT_REFUSED;
  }

  if (output.detail === undefined) {
    writeStdoutSync(renderCompareSummary(report));
    return verdict(report);
  }

  const delta = report.deltas.find((candidate) => candidate.name === output.detail);
  if (delta === undefined) {
    // A typo'd selector must not exit 0 having shown nothing.
    writeStdoutSync(renderSelectorHelp(report));
    return EXIT_REFUSED;
  }

  writeStdoutSync(renderDetail(delta, before, after, output));
  return verdict(report);
}

/**
 * Read both directories, print the comparison, and exit.
 *
 * @param beforeDir - Snapshot directory captured first
 * @param afterDir - Snapshot directory captured second
 * @param options - Parsed flags
 * @returns Never returns normally — the process exits from inside
 */
export function pipelineCompareCommand(
  beforeDir: string,
  afterDir: string,
  options: PipelineCompareOptions,
): void {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();

  try {
    process.exit(
      reportComparison(readSnapshot(beforeDir), readSnapshot(afterDir), {
        ...(options.detail === undefined ? {} : { detail: options.detail }),
        maxLines: options.maxLines ?? DEFAULT_DIFF_MAX_LINES,
        context: options.context ?? DEFAULT_DIFF_CONTEXT,
      }),
    );
  } catch (error) {
    handleCommandError(error, logger, startTime, 'PipelineCompare');
  }
}

/**
 * Whether the comparison was refused rather than performed.
 *
 * Keyed on the documented `REFUSED:` prefix rather than on an empty `deltas`
 * array, because "no artifacts" and "no comparison" are different facts that
 * happen to share a shape.
 *
 * @param report - The comparison to inspect
 * @returns True when a constraint announces a refusal
 */
function isRefusal(report: CompareReport): boolean {
  return report.constraints.some((constraint) => constraint.startsWith(REFUSAL_PREFIX));
}

/**
 * The exit code for a comparison that actually ran.
 *
 * @param report - The comparison
 * @returns 1 when anything moved, 0 when nothing did
 */
function verdict(report: CompareReport): number {
  return report.changedCount > 0 ? EXIT_CHANGED : EXIT_IDENTICAL;
}

/**
 * Both sides' capture-time warnings, side-labelled.
 *
 * @param before - The earlier snapshot
 * @param after - The later snapshot
 * @returns The warning block with a trailing blank line, or an empty string
 */
function renderCaptureWarnings(before: LoadedSnapshot, after: LoadedSnapshot): string {
  const lines = [
    ...warningsOf(before).map((warning) => `!! [before] ${warning}`),
    ...warningsOf(after).map((warning) => `!! [after] ${warning}`),
  ];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n\n`;
}

/**
 * One snapshot's capture-time warnings, tolerating a manifest that lacks them.
 *
 * `readSnapshot` type-asserts the parsed manifest rather than validating it, so
 * a hand-edited `manifest.json` can carry anything. A missing `warnings` array
 * must degrade to "none stated", never throw partway through printing.
 *
 * @param snapshot - The loaded snapshot
 * @returns Its warnings, or an empty array
 */
function warningsOf(snapshot: LoadedSnapshot): readonly string[] {
  return Array.isArray(snapshot.manifest.warnings) ? snapshot.manifest.warnings : [];
}

/**
 * The drill-down for one artifact: header, then bounded diff text.
 *
 * A side that does not carry the artifact (an `added` or `removed` row) reads as
 * the empty string, which is the correct input for a diff against nothing.
 *
 * Note the fidelity limit: when the report carries a `MASKED:` constraint, the
 * summary compared content keys masked out on both sides, while the text diffed
 * here is unmasked. The masking is internal to `compareSnapshots`, so a
 * drill-down under a content-key schema bump will show key churn the summary
 * deliberately hid. The constraint is printed above, so the reader is told.
 *
 * @param delta - The row the selector resolved to
 * @param before - The earlier snapshot
 * @param after - The later snapshot
 * @param output - The diff bounds
 * @returns Header plus diff text
 */
function renderDetail(
  delta: ArtifactDelta,
  before: LoadedSnapshot,
  after: LoadedSnapshot,
  output: ComparisonOutput,
): string {
  const diff = renderUnifiedDiff(
    before.artifacts.get(delta.artifact) ?? '',
    after.artifacts.get(delta.artifact) ?? '',
    { maxLines: output.maxLines, context: output.context },
  );
  return `${renderDetailHeader(delta)}${diff.text}`;
}
