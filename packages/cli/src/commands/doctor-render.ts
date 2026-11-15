/**
 * `vat doctor`'s human block — the one rendering, for two channels.
 *
 * Under `--format yaml|json` the block goes to stderr beside the document; under
 * `--format text` it IS the stdout rendering (registered as the verb's
 * `renderText`), so a text run prints it once. A module of its own because the
 * published-shape registry imports the text renderer, and the registry must not
 * import the command (the cycle `report-schemas.ts` describes).
 */

import type { Report } from '@vibe-agent-toolkit/schema';

import type { DoctorCheckResult, DoctorData, DoctorOutcome } from './doctor-schema.js';

/** How many checks landed in each outcome. Published beside the verdict, never folded into it. */
type DoctorOutcomeCounts = Record<DoctorOutcome, number>;

/** Tally checks by outcome. The four buckets always sum to `checks.length`. */
export function countByOutcome(checks: readonly DoctorCheckResult[]): DoctorOutcomeCounts {
  const counts: DoctorOutcomeCounts = { pass: 0, fail: 0, undetermined: 0, skipped: 0 };
  for (const check of checks) {
    counts[check.outcome] += 1;
  }
  return counts;
}

/**
 * Which checks the renderer prints.
 *
 * Verbose prints all of them. Concise hides only the checks with nothing to say:
 * a clean `pass` with no suggestion, and a `skipped` check that does not apply
 * here. `fail` and `undetermined` are ALWAYS printed — an undetermined check is
 * the one a concise view must never swallow.
 *
 * Whatever this hides, {@link formatDoctorSummary} states the number of hidden
 * checks, so the printed list and the printed counts cannot disagree.
 */
export function selectDisplayChecks(
  checks: readonly DoctorCheckResult[],
  verbose: boolean,
): DoctorCheckResult[] {
  if (verbose) return [...checks];
  return checks.filter(
    c => c.suggestion !== undefined || (c.outcome !== 'pass' && c.outcome !== 'skipped'),
  );
}

const OUTCOME_ICONS: Record<DoctorOutcome, string> = {
  pass: '✅',
  fail: '❌',
  undetermined: '❓',
  skipped: '⏭️',
};

/**
 * The summary block: the distribution, how many checks were not rendered, and
 * the verdict.
 *
 * `displayedCount` is required precisely so the block can never claim more
 * checks than the reader was shown without saying so.
 */
export function formatDoctorSummary(
  counts: DoctorOutcomeCounts,
  displayedCount: number,
): string[] {
  const total = counts.pass + counts.fail + counts.undetermined + counts.skipped;
  const lines = [
    `📊 Results: ${total} checks — ${counts.pass} passed, ${counts.fail} failed, ` +
      `${counts.undetermined} undetermined, ${counts.skipped} skipped`,
  ];

  const hidden = total - displayedCount;
  if (hidden > 0) {
    lines.push(
      `   ${hidden} not shown (nothing to report) — re-run with --verbose to see every check.`,
    );
  }

  lines.push('');

  if (counts.fail > 0) {
    lines.push(`⚠️  ${counts.fail} check(s) failed. See suggestions above to fix.`);
  } else if (counts.undetermined > 0) {
    lines.push(
      `❓ Nothing failed, but ${counts.undetermined} check(s) could not be determined — ` +
        'that is not the same as healthy.',
    );
  } else {
    lines.push('✨ All checks passed! Your vat setup looks healthy.');
  }

  return lines;
}

/**
 * The whole human block: the project context when run below the project root,
 * the checks the view selects, then the summary.
 *
 * @param data - The document's data — `currentDir` says whether doctor ran below the project root
 * @param verbose - Print every check rather than only those with something to say
 * @returns The block, newline-terminated
 */
export function renderDoctorBlock(data: DoctorData, verbose: boolean): string {
  const lines = ['🩺 vat doctor', ''];

  const { currentDir, projectRoot, configPath } = data;
  if (projectRoot !== null && projectRoot !== currentDir) {
    lines.push('📍 Project Context', `   Current directory: ${currentDir}`, `   Project root:      ${projectRoot}`);
    if (configPath !== null) lines.push(`   Configuration:     ${configPath}`);
    lines.push('');
  }

  lines.push('Running diagnostic checks...', '');

  const displayed = selectDisplayChecks(data.checks, verbose);
  for (const check of displayed) {
    lines.push(`${OUTCOME_ICONS[check.outcome]} ${check.name}`, `   ${check.message}`);
    if (check.suggestion !== undefined) lines.push(`   💡 ${check.suggestion}`);
    lines.push('');
  }

  // The summary states the distribution AND how many checks it did not print,
  // so the count can never contradict the list above it.
  lines.push(...formatDoctorSummary(countByOutcome(data.checks), displayed.length));
  return `${lines.join('\n')}\n`;
}

/**
 * `vat doctor --format text`: the human block, with every check — the text
 * document is the whole report, which is why no check is filtered from it — or,
 * for a run that produced no verdict, its refusal line.
 */
export function renderDoctorText(report: Report<unknown>): string {
  if (report.status === 'error') return `error: ${report.error.message} [${report.error.code}]\n`;
  return renderDoctorBlock(report.data as DoctorData, true);
}
