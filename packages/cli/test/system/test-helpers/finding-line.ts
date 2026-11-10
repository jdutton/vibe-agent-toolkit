/**
 * Whether stderr says a finding as the SHARED reporter does: its own line, indented or not, holding
 * exactly `[anchor: ]severity: message [CODE][ (line N, column M)]` — the trailer only for a finding
 * with a line and no file — at the line's end. A home-made format that
 * merely contains `[CODE]` does not match.
 *
 * The expected line is spelled out HERE, never borrowed from the CLI's `formatFindingLine`: a
 * helper that asked the formatter what to expect would follow any change to the format and stay
 * green, so the published line shape would be pinned by nothing.
 */

import type { Finding } from '@vibe-agent-toolkit/schema';

/** Whether the finding names a file its coordinates can be put on. */
function hasFile(finding: Finding): boolean {
  return finding.location !== undefined && finding.location !== '';
}

/** `location[:line[:column]]`, then ` (field)` — what precedes the severity word, or `''`. */
function expectedAnchor(finding: Finding): string {
  const position = finding.line === undefined ? [] : [finding.line, ...(finding.column === undefined ? [] : [finding.column])];
  const at = hasFile(finding) ? [finding.location, ...position.map(String)].join(':') : '';
  if (finding.field === undefined || finding.field === '') return at;
  return at === '' ? `(${finding.field})` : `${at} (${finding.field})`;
}

/** ` (line N[, column M])` after the code — where a finding with NO file says its coordinates. */
function expectedTrailer(finding: Finding): string {
  if (hasFile(finding) || finding.line === undefined) return '';
  const column = finding.column === undefined ? '' : `, column ${String(finding.column)}`;
  return ` (line ${String(finding.line)}${column})`;
}

/** The one line the shared reporter prints for `finding`, spelled independently of it. */
function expectedLine(finding: Finding): string {
  const body = `${finding.severity}: ${finding.message} [${finding.code}]${expectedTrailer(finding)}`;
  const anchor = expectedAnchor(finding);
  return anchor === '' ? body : `${anchor}: ${body}`;
}

export function saysFindingLine(stderr: string, finding: Finding): boolean {
  const line = expectedLine(finding);
  for (let at = stderr.indexOf(line); at !== -1; at = stderr.indexOf(line, at + 1)) {
    const lineStart = stderr.lastIndexOf('\n', at - 1) + 1;
    const end = at + line.length;
    const endsLine = end === stderr.length || stderr[end] === '\n' || stderr[end] === '\r';
    if (endsLine && stderr.slice(lineStart, at).trim() === '') return true;
  }
  return false;
}
