/**
 * Rendering a comparison for a reader whose scarce resource is context.
 *
 * The default output is a table of one line per artifact and nothing else. That
 * is the whole design: `vat audit` alone emits 1.81 MB of YAML carrying 1,755
 * findings, so a comparison that printed diff text by default would rebuild the
 * exact problem the instrument exists to solve. Diff text is produced only when
 * a caller names one artifact, and even then it is capped with the cap stated.
 *
 * Every function here is pure and takes only a `CompareReport` (or one of its
 * rows) — the report already carries the provenance and the constraints, so the
 * renderer never reaches back into a manifest or the filesystem.
 */

import type { ArtifactDelta, ArtifactStatus, CompareReport } from './types.js';

/** Title line shared by the summary and the drill-down. */
const TITLE = '# pipeline snapshot compare';

/** Minimum width of the artifact-name column, so short reports still align. */
const NAME_COLUMN_MIN = 30;

/** Width of the status column. */
const STATUS_COLUMN_WIDTH = 10;

/** Width of the `+N/-N` column. */
const COUNT_COLUMN_WIDTH = 11;

/** How many headlines a row may show before collapsing the rest into a count. */
const HEADLINE_LIMIT = 2;

/** Soft wrap width for the provenance line. */
const PROVENANCE_WRAP_WIDTH = 100;

/** Gap between provenance notes packed onto one line. */
const NOTE_GAP = '   ';

/**
 * Sort weight per status: anything that moved sorts above anything that did not.
 *
 * A `Map` rather than an object literal so the lookup is not a computed member
 * access on a plain object.
 */
const STATUS_RANK = new Map<ArtifactStatus, number>([
  ['changed', 0],
  ['added', 0],
  ['removed', 0],
  ['same', 1],
]);

/**
 * The default, small output — one line per artifact and a count.
 *
 * Rows that did not move collapse to the word `same` with no counts and no
 * headline, because those columns would be noise on an unchanged row. When
 * nothing moved at all the table is dropped entirely and replaced by a single
 * sentence: an all-identical report should not spend a reader's attention
 * listing artifacts they do not need to look at.
 *
 * Note the deliberate asymmetry with {@link ArtifactDelta.addedLines}: a row can
 * read `changed  +0/-0`, which is not a contradiction. The counts are an
 * order-insensitive multiset difference, so a pure reordering moves the text
 * without moving the counts. `status` is the authority.
 *
 * @param report - The comparison to render
 * @returns The summary text, LF-terminated
 */
export function renderCompareSummary(report: CompareReport): string {
  const lines: string[] = [
    TITLE,
    `before: ${report.beforeDir}   after: ${report.afterDir}`,
    ...wrapNotes(report.provenanceNotes, PROVENANCE_WRAP_WIDTH),
  ];

  if (report.constraints.length > 0) {
    lines.push('', ...report.constraints.map((constraint) => `!! ${constraint}`));
  }

  lines.push('', ...renderBody(report));
  return `${lines.join('\n')}\n`;
}

/**
 * The artifact table, or the one-line statement that replaces it.
 *
 * @param report - The comparison to render
 * @returns Body lines, without the trailing newline
 */
function renderBody(report: CompareReport): string[] {
  if (report.deltas.length === 0) {
    return ['No artifacts were compared.'];
  }
  if (report.changedCount === 0) {
    return [`All ${String(report.deltas.length)} artifacts identical.`];
  }

  const sorted = sortDeltas(report.deltas);
  const nameWidth = columnWidth(sorted.map((delta) => delta.name));
  const header =
    'artifact'.padEnd(nameWidth) +
    'status'.padEnd(STATUS_COLUMN_WIDTH) +
    '+/-'.padEnd(COUNT_COLUMN_WIDTH) +
    'headline';

  const lines = [header, ...sorted.map((delta) => renderRow(delta, nameWidth))];
  lines.push(
    '',
    `${String(report.changedCount)} of ${String(report.deltas.length)} artifacts changed.`,
    `detail: vat pipeline compare ${report.beforeDir} ${report.afterDir} --detail ${firstMoved(sorted)}`,
  );
  return lines;
}

/**
 * Width of the artifact-name column: the longest name, floored and padded.
 *
 * @param names - Every name that will appear in the column
 * @returns The column width in characters
 */
function columnWidth(names: readonly string[]): number {
  let longest = 0;
  for (const name of names) {
    longest = Math.max(longest, name.length);
  }
  return Math.max(NAME_COLUMN_MIN, longest + 2);
}

/**
 * Moved rows first, unmoved rows after, each group in its original order.
 *
 * @param deltas - Rows as the comparison produced them
 * @returns A new, sorted array
 */
function sortDeltas(deltas: readonly ArtifactDelta[]): ArtifactDelta[] {
  return [...deltas].sort(
    (a, b) => (STATUS_RANK.get(a.status) ?? 0) - (STATUS_RANK.get(b.status) ?? 0),
  );
}

/**
 * Name of the first row that moved, for the `--detail` hint.
 *
 * @param sorted - Rows already sorted with moved rows first
 * @returns The selector to suggest
 */
function firstMoved(sorted: readonly ArtifactDelta[]): string {
  return sorted.find((delta) => delta.status !== 'same')?.name ?? '';
}

/**
 * One table row.
 *
 * @param delta - The row to render
 * @param nameWidth - Width of the artifact-name column
 * @returns The row, right-trimmed so unchanged rows carry no trailing padding
 */
function renderRow(delta: ArtifactDelta, nameWidth: number): string {
  const name = delta.name.padEnd(nameWidth);
  if (delta.status === 'same') {
    return `${name}same`;
  }
  const counts = `+${String(delta.addedLines)}/-${String(delta.removedLines)}`;
  return (
    name +
    delta.status.padEnd(STATUS_COLUMN_WIDTH) +
    counts.padEnd(COUNT_COLUMN_WIDTH) +
    formatHeadlines(delta.headlines)
  ).trimEnd();
}

/**
 * Headlines for one row, capped so a wide row cannot swamp the table.
 *
 * @param headlines - Every headline the comparison found for this row
 * @returns Up to {@link HEADLINE_LIMIT} headlines, with the remainder counted
 */
function formatHeadlines(headlines: readonly string[]): string {
  if (headlines.length === 0) {
    return '';
  }
  const shown = headlines.slice(0, HEADLINE_LIMIT).join(', ');
  const extra = headlines.length - HEADLINE_LIMIT;
  return extra > 0 ? `${shown} (+${String(extra)} more)` : shown;
}

/**
 * Pack notes onto as few lines as fit inside a soft wrap width.
 *
 * @param notes - Provenance notes, already formatted
 * @param width - Soft wrap width in characters
 * @returns One or more lines; a single over-long note gets its own line
 */
function wrapNotes(notes: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const note of notes) {
    const candidate = current === '' ? note : `${current}${NOTE_GAP}${note}`;
    if (current !== '' && candidate.length > width) {
      lines.push(current);
      current = note;
    } else {
      current = candidate;
    }
  }
  if (current !== '') {
    lines.push(current);
  }
  return lines;
}

/**
 * Drill-down header for one artifact, printed above its diff text.
 *
 * This takes an already-resolved row, so it cannot fail to match: resolving a
 * user's `--detail` selector against `report.deltas` is the caller's job, and
 * the miss case is {@link renderSelectorHelp}, not a `null` from here.
 *
 * @param delta - The row the selector resolved to
 * @returns The header text, LF-terminated
 */
export function renderDetailHeader(delta: ArtifactDelta): string {
  const lines = [
    `${TITLE} --detail ${delta.name}`,
    `artifact: ${delta.artifact}   kind: ${delta.kind}`,
    `status: ${delta.status}   +${String(delta.addedLines)}/-${String(delta.removedLines)}`,
  ];

  if (delta.headlines.length > 0) {
    lines.push(
      ...delta.headlines.map((headline) => `headline: ${headline}`),
      '!! headlines come from a shallow scan of leading key/value lines, not a parse — they are advisory.',
    );
  }
  if (delta.status === 'changed' && delta.addedLines === 0 && delta.removedLines === 0) {
    lines.push(
      '!! the text differs but no line was added or removed: this is a REORDERING. The line counts are an ' +
        'order-insensitive multiset difference and cannot see it.',
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The list a user sees when their `--detail` selector matched nothing.
 *
 * @param report - The comparison whose selectors are on offer
 * @returns The help text, LF-terminated
 */
export function renderSelectorHelp(report: CompareReport): string {
  if (report.deltas.length === 0) {
    return 'No artifacts were compared, so there is no selector to pass to --detail.\n';
  }

  const nameWidth = columnWidth(report.deltas.map((delta) => delta.name));
  const lines = [
    `No artifact matched that selector. ${String(report.deltas.length)} are available:`,
    ...sortDeltas(report.deltas).map((delta) => `  ${delta.name.padEnd(nameWidth)}${delta.status}`),
  ];
  return `${lines.join('\n')}\n`;
}
