/**
 * Human-readable rendering of `memory` reports and comparisons.
 *
 * The legend is printed on both, because either can be pasted somewhere alone
 * and "peak RSS" means three different numbers depending on whether workers and
 * children are in it.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { renderFacetComparison, renderFacetReport, tally, verdictBlock } from '../../harness/render.js';

import type { MemoryComparisonResult } from './compare.js';
import type { MemoryBody, MemoryCommandStats } from './types.js';

/** Kilobytes in a mebibyte, for display only; the report keeps kilobytes. */
const KB_PER_MIB = 1024;

/** Kilobytes in a gibibyte, for display only. */
const KB_PER_GIB = KB_PER_MIB * 1024;

/** What every number here is. */
const LEGEND =
  'Peak RSS per repeat = the largest vat process\'s peak resident set (VmHWM on Linux, ' +
  'process.resourceUsage().maxRSS elsewhere) — worker threads INCLUDED (they share the process), ' +
  'the parent\'s memory EXCLUDED; each vat process is its own figure, counted, and never summed.';

/** How this facet's numbers are qualified on a busy machine. */
const PHRASING = {
  unmeasured: 'no load reading was taken around the capture.',
  contaminated: 'the machine was busy; under memory pressure the OS may page vat out, which lowers a peak.',
} as const;

/**
 * Format a kilobyte figure in the largest unit that keeps it readable.
 *
 * @param kb - Kilobytes
 * @returns `1.01 GiB`, `312.4 MiB`
 */
export function formatKb(kb: number): string {
  if (kb >= KB_PER_GIB) return `${(kb / KB_PER_GIB).toFixed(2)} GiB`;
  return `${(kb / KB_PER_MIB).toFixed(1)} MiB`;
}

/**
 * The lines one command prints in a report.
 *
 * @param row - The command's statistics
 * @returns Lines
 */
function rowLines(row: MemoryCommandStats): readonly string[] {
  if (row.failed) return [`  ${row.name}: FAILED — ${row.failure ?? 'unknown'}`];
  const exit = row.exitCode === 0 || row.exitCode === null ? '' : `, exit ${String(row.exitCode)}`;
  const processes = [...new Set(row.processesPerRepeat)].map((count) => tally(count)).join('/');
  return [
    `  ${row.name}: ${formatKb(row.medianKb)} median peak RSS ` +
      `(±${formatKb(row.iqrKb)} IQR, ${formatKb(row.minKb)}–${formatKb(row.maxKb)}, ` +
      `${tally(row.runs)} runs, ${row.cache}, ${processes} vat processes${exit})`,
  ];
}

/**
 * Render a captured report.
 *
 * @param report - The report to render
 * @returns Text for a terminal
 */
export function renderMemoryReport(report: ReportEnvelope<MemoryBody>): string {
  return renderFacetReport(report, PHRASING, LEGEND, rowLines);
}

/**
 * The lines one command's diff prints.
 *
 * @param diff - The command's diff row
 * @returns Lines
 */
function diffLines(diff: MemoryComparisonResult['commands'][number]): readonly string[] {
  const verdict = diff.verdict;
  const totals = (): string => {
    if (!('peak' in verdict)) return '';
    const { before, after, ratio } = verdict.peak;
    const factor = ratio === null ? '' : ` (×${ratio.toFixed(2)})`;
    const { before: was, after: now } = verdict.processes;
    const processes = was === now ? `${tally(now)} vat processes` : `vat processes ${tally(was)} -> ${tally(now)}`;
    return `median peak RSS ${formatKb(before)} -> ${formatKb(after)}${factor}, ${processes}`;
  };
  return verdictBlock(diff.name, verdict, totals, () => []);
}

/**
 * Render a comparison.
 *
 * @param comparison - A completed comparison
 * @returns Text for a terminal
 */
export function renderMemoryComparison(comparison: MemoryComparisonResult): string {
  return renderFacetComparison(
    comparison,
    LEGEND,
    '⚠  At least one side was captured on a busy machine; under memory pressure a peak can read low.',
    diffLines,
  );
}
