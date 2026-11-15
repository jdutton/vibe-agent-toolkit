/**
 * Read the severities back out of rendered finding lines.
 *
 * Every lane renders a finding through `formatIssueLines`, whose first line is
 * `[anchor: ]severity: message [CODE]`. A test asserting the SHAPE of a rendered
 * set — which severities, in which order — reads them here, so the parse lives
 * in one place beside the one renderer it parses.
 */

/** The severity a finding line opens with, or that follows its anchor. */
const SEVERITY_AFTER_ANCHOR = /(?:^|: )(error|warning|info|ignore): /;

/**
 * Every severity label present in a rendered set, in order, upper-cased.
 *
 * @param lines - Rendered report lines; lines that are not a finding are skipped
 */
export function renderedLabels(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const severity = SEVERITY_AFTER_ANCHOR.exec(line.trimStart())?.[1];
    return severity === undefined ? [] : [severity.toUpperCase()];
  });
}
