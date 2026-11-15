import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { formatIssueAnchor } from '../../src/utils/issue-anchor.js';
import { formatFindingLine } from '../../src/utils/issue-rendering.js';

/** A minimal issue; each case varies only the anchor fields. */
function issue(anchors: Partial<ValidationIssue>): ValidationIssue {
  return { code: 'LINK_OUTSIDE_PROJECT', severity: 'warning', message: 'msg', ...anchors };
}

const GUIDE = 'docs/guide.md';

describe('formatIssueAnchor', () => {
  it.each([
    ['file only', { location: GUIDE }, GUIDE],
    ['file + line', { location: GUIDE, line: 24 }, `${GUIDE}:24`],
    ['file + field', { location: 'SKILL.md', field: 'frontmatter.description' }, 'SKILL.md (frontmatter.description)'],
    ['file + line + field', { location: 'p.json', line: 3, field: 'plugins.0.name' }, 'p.json:3 (plugins.0.name)'],
    // ALLOW_UNUSED points into the project config, which the framework is never
    // handed the path of — the pointer must still be rendered, not dropped.
    ['field only', { field: 'validation.allow.SKILL_TOO_MANY_FILES' }, '(validation.allow.SKILL_TOO_MANY_FILES)'],
    ['file + line + column', { location: GUIDE, line: 24, column: 7 }, `${GUIDE}:24:7`],
    // 🪤 Coordinates with no file are NOT a prefix: `:3` or `3:5:` reads as a file named `3`.
    ['field + line, no file', { field: 'name', line: 3, column: 5 }, '(name)'],
  ])('renders %s', (_label, anchors, expected) => {
    expect(formatIssueAnchor(issue(anchors))).toBe(expected);
  });

  it.each([
    ['no anchor at all', {}],
    ['an empty location string', { location: '' }],
    ['a line and column with no file', { line: 3, column: 5 }],
  ])('returns undefined for %s so callers can omit the line', (_label, anchors) => {
    expect(formatIssueAnchor(issue(anchors))).toBeUndefined();
  });
});

describe('formatFindingLine', () => {
  it('prefixes the coordinates when the finding names a file', () => {
    expect(formatFindingLine(issue({ location: GUIDE, line: 3, column: 5 })))
      .toBe(`${GUIDE}:3:5: warning: msg [LINK_OUTSIDE_PROJECT]`);
  });

  it.each([
    ['line and column', { line: 3, column: 5 }, 'warning: msg [LINK_OUTSIDE_PROJECT] (line 3, column 5)'],
    ['line alone', { line: 3 }, 'warning: msg [LINK_OUTSIDE_PROJECT] (line 3)'],
    ['a field and a line', { field: 'name', line: 3 }, '(name): warning: msg [LINK_OUTSIDE_PROJECT] (line 3)'],
  ])('says the coordinates AFTER the message when no file is named — %s', (_label, anchors, expected) => {
    expect(formatFindingLine(issue(anchors))).toBe(expected);
  });
});
