import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { formatIssueAnchor } from '../../src/utils/issue-anchor.js';

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
  ])('renders %s', (_label, anchors, expected) => {
    expect(formatIssueAnchor(issue(anchors))).toBe(expected);
  });

  it.each([
    ['no anchor at all', {}],
    ['an empty location string', { location: '' }],
  ])('returns undefined for %s so callers can omit the line', (_label, anchors) => {
    expect(formatIssueAnchor(issue(anchors))).toBeUndefined();
  });
});
