/**
 * Whether stderr says a finding as the SHARED reporter does: its own line, indented or not, holding
 * exactly `[anchor: ]severity: message [CODE]`, the code at the line's end. A home-made format that
 * merely contains `[CODE]` does not match.
 *
 * The expected line is spelled out HERE, never borrowed from the CLI's `formatFindingLine`: a
 * helper that asked the formatter what to expect would follow any change to the format and stay
 * green, so the published line shape would be pinned by nothing.
 */

import type { Finding } from '@vibe-agent-toolkit/schema';

/** `location[:line[:column]]`, then ` (field)` — what precedes the severity word, or `''`. */
function expectedAnchor(finding: Finding): string {
  const position = finding.line === undefined ? [] : [finding.line, ...(finding.column === undefined ? [] : [finding.column])];
  const at = finding.location === undefined || finding.location === '' ? '' : [finding.location, ...position.map(String)].join(':');
  if (finding.field === undefined || finding.field === '') return at;
  return at === '' ? `(${finding.field})` : `${at} (${finding.field})`;
}

/** The one line the shared reporter prints for `finding`, spelled independently of it. */
function expectedLine(finding: Finding): string {
  const body = `${finding.severity}: ${finding.message} [${finding.code}]`;
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
