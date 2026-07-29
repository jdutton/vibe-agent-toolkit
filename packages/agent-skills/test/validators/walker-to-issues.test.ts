import { describe, expect, it } from 'vitest';

import { deferredAssetsToIssues, walkerExclusionsToIssues } from '../../src/validators/walker-to-issues.js';
import type { LinkResolution } from '../../src/walk-link-graph.js';

const SOURCE = '/root/skills/demo/SKILL.md';

const resolution = (reason: LinkResolution['excludeReason'], path: string): LinkResolution => ({
  path,
  sourcePath: SOURCE,
  sourceLine: 7,
  bundled: false,
  excludeReason: reason,
  linkHref: path,
});

describe('walkerExclusionsToIssues', () => {
  it('maps each reason to the expected issue code', () => {
    const input: LinkResolution[] = [
      resolution('depth-exceeded', '/root/a.md'),
      resolution('outside-project', '/other/b.md'),
      resolution('gitignored', '/root/dist/c.md'),
      resolution('skill-definition', '/root/other/SKILL.md'),
      resolution('directory-target', '/root/dir'),
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
      // directory-target emits no issue (like pattern-matched) — a navigational
      // link to a directory is valid; the directory is excluded from the bundle
      // but no error is raised. Only a files: source that is a directory is an
      // error (checked in packaging-validator, not here).
      'LINK_TO_NAVIGATION_FILE',
      'LINK_MISSING_TARGET',
      // pattern-matched emits no issue
    ]);
  });

  it('anchors the issue at the file CONTAINING the link, not the target', () => {
    // The target of a `missing-target` exclusion does not exist, so a location
    // naming it points at nothing. `link` carries the target instead.
    const issues = walkerExclusionsToIssues(
      [resolution('missing-target', '/root/docs/nope.md')],
      '/root',
    );
    expect(issues[0]?.location).toBe('skills/demo/SKILL.md');
    expect(issues[0]?.line).toBe(7);
    expect(issues[0]?.link).toBe('/root/docs/nope.md');
  });
});

describe('deferredAssetsToIssues', () => {
  it('returns one LINK_DEFERRED_ARTIFACT info issue per asset', () => {
    const issues = deferredAssetsToIssues(
      ['/root/scripts/cli.mjs', '/root/dist/out.js'],
      '/root',
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]?.code).toBe('LINK_DEFERRED_ARTIFACT');
    expect(issues[0]?.severity).toBe('info');
    expect(issues[1]?.code).toBe('LINK_DEFERRED_ARTIFACT');
    expect(issues[1]?.severity).toBe('info');
  });

  it('records project-relative paths in location', () => {
    const issues = deferredAssetsToIssues(['/root/scripts/cli.mjs'], '/root');
    expect(issues[0]?.location).toBe('scripts/cli.mjs');
  });

  it('includes the location in the message', () => {
    const issues = deferredAssetsToIssues(['/root/dist/tool.js'], '/root');
    expect(issues[0]?.message).toContain('dist/tool.js');
  });

  it('returns an empty array for no assets', () => {
    expect(deferredAssetsToIssues([], '/root')).toHaveLength(0);
  });

  it('populates fix and reference from CODE_REGISTRY', () => {
    const issues = deferredAssetsToIssues(['/root/dist/x.js'], '/root');
    expect(issues[0]?.fix).toBeDefined();
    expect(issues[0]?.reference).toBeDefined();
  });
});
