/**
 * Whether stderr says a finding as the SHARED reporter does: its own line, indented or not, holding
 * exactly what `formatFindingLine` renders — `[anchor: ]severity: message [CODE]`, the code at the
 * line's end. A home-made format that merely contains `[CODE]` does not match.
 */

import type { Finding } from '@vibe-agent-toolkit/schema';

import { formatFindingLine } from '../../../src/utils/issue-rendering.js';

export function saysFindingLine(stderr: string, finding: Finding): boolean {
  const line = formatFindingLine(finding);
  for (let at = stderr.indexOf(line); at !== -1; at = stderr.indexOf(line, at + 1)) {
    const lineStart = stderr.lastIndexOf('\n', at - 1) + 1;
    const end = at + line.length;
    const endsLine = end === stderr.length || stderr[end] === '\n' || stderr[end] === '\r';
    if (endsLine && stderr.slice(lineStart, at).trim() === '') return true;
  }
  return false;
}
