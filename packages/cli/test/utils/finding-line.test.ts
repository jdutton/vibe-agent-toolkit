/**
 * The exit-code matrix's stderr check accepts the shared reporter's line and nothing home-made.
 */

import type { Finding } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { reportFindings } from '../../src/utils/issue-rendering.js';
import { saysFindingLine } from '../system/test-helpers/finding-line.js';

const FINDING: Finding = { code: 'LINK_BROKEN_FILE', severity: 'error', message: 'Link target not found', location: 'docs/a.md', line: 3 };

function reported(finding: Finding): string {
  const lines: string[] = [];
  reportFindings([finding], { verbose: true, write: (line) => lines.push(line) });
  return `${lines.join('\n')}\n`;
}

describe('saysFindingLine', () => {
  it('accepts what the shared reporter prints', () => {
    expect(saysFindingLine(reported(FINDING), FINDING)).toBe(true);
    expect(saysFindingLine(`before\n${reported(FINDING)}after\n`, FINDING)).toBe(true);
  });

  it.each([
    ['a bracketed-severity format', '[ERROR] [LINK_BROKEN_FILE] Link target not found\n'],
    ['the code without the severity', 'docs/a.md:3: Link target not found [LINK_BROKEN_FILE]\n'],
    ['the line inside a sentence', 'note: docs/a.md:3: error: Link target not found [LINK_BROKEN_FILE]\n'],
    ['text after the code', 'docs/a.md:3: error: Link target not found [LINK_BROKEN_FILE] (see above)\n'],
  ])('refuses %s', (_label, stderr) => {
    expect(saysFindingLine(stderr, FINDING)).toBe(false);
  });
});
