/**
 * The exit-code matrix's stderr check accepts the shared reporter's line and nothing home-made.
 */

import type { Finding } from '@vibe-agent-toolkit/schema';
import { describe, expect, it, vi } from 'vitest';

import type * as IssueRendering from '../../src/utils/issue-rendering.js';
import { reportFindings } from '../../src/utils/issue-rendering.js';
import { saysFindingLine } from '../system/test-helpers/finding-line.js';

// The helper must pin the shape itself: were it to build its expectation with the CLI's own
// `formatFindingLine`, a change to that format would move the expectation with it and stay green.
// The exported formatter is swapped for a different shape; the reporter's own internal call is not.
vi.mock('../../src/utils/issue-rendering.js', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueRendering>()),
  formatFindingLine: () => 'a format the helper must not borrow',
}));

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

  it('accepts the pinned literal line — anchor, severity word, message, [CODE] — not whatever the CLI formats', () => {
    expect(saysFindingLine('  docs/a.md:3: error: Link target not found [LINK_BROKEN_FILE]\n', FINDING)).toBe(true);
    expect(saysFindingLine('warning: left at /tmp/x [TREE_CLEANUP_INCOMPLETE]\n', { code: 'TREE_CLEANUP_INCOMPLETE', severity: 'warning', message: 'left at /tmp/x' })).toBe(true);
    expect(saysFindingLine('a.md:2:7 (name): info: m [C]\n', { code: 'C', severity: 'info', message: 'm', location: 'a.md', line: 2, column: 7, field: 'name' })).toBe(true);
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
