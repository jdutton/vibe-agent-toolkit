import { describe, expect, it } from 'vitest';

import { walkerExclusionsToIssues } from '../../src/validators/walker-to-issues.js';
import type { LinkResolution } from '../../src/walk-link-graph.js';

const resolution = (reason: LinkResolution['excludeReason'], path: string): LinkResolution => ({
  path,
  bundled: false,
  excludeReason: reason,
  linkHref: path,
});

describe('walkerExclusionsToIssues', () => {
  it('maps each reason to the expected issue code', () => {
    // Directory targets are silently skipped by the walker (#126) and so do
    // not appear in excludedReferences — there is no `directory-target`
    // reason to map.
    const input: LinkResolution[] = [
      resolution('depth-exceeded', '/root/a.md'),
      resolution('outside-project', '/other/b.md'),
      resolution('gitignored', '/root/dist/c.md'),
      resolution('skill-definition', '/root/other/SKILL.md'),
      resolution('navigation-file', '/root/README.md'),
      resolution('missing-target', '/root/nope.md'),
      resolution('pattern-matched', '/root/docs/x.md'),
    ];
    const issues = walkerExclusionsToIssues(input, '/root');
    const codes = issues.map(i => i.code);
    expect(codes).toEqual([
      'LINK_DROPPED_BY_DEPTH',
      'LINK_OUTSIDE_PROJECT',
      'LINK_TO_GITIGNORED_FILE',
      'LINK_TO_SKILL_DEFINITION',
      'LINK_TO_NAVIGATION_FILE',
      'LINK_MISSING_TARGET',
      // pattern-matched emits no issue
    ]);
  });

  it('records project-relative paths in location', () => {
    const issues = walkerExclusionsToIssues(
      [resolution('missing-target', '/root/docs/nope.md')],
      '/root',
    );
    expect(issues[0]?.location).toBe('docs/nope.md');
  });
});
