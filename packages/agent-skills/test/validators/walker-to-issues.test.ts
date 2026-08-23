import { describe, expect, it } from 'vitest';

import { deferredAssetsToIssues, walkerExclusionsToIssues } from '../../src/validators/walker-to-issues.js';
import type { ExcludeRule, LinkResolution } from '../../src/walk-link-graph.js';

const SOURCE = '/root/skills/demo/SKILL.md';

/**
 * The two reasons that used to reach no code, named once. Both the enumeration
 * test and the per-reason pins below drive them, and a typo'd reason string is a
 * silently-skipped case rather than a failure — the exact shape this change
 * exists to remove.
 */
const DIRECTORY_TARGET = 'directory-target';
const PATTERN_MATCHED = 'pattern-matched';
const DIRECTORY_PATH = '/root/docs/guides';
const PATTERN_EXCLUDED_PATH = '/root/docs/internal.md';

/**
 * `targetExists` defaults to true because every reason EXCEPT `missing-target`
 * is only ever recorded by the walker for a target it found on disk.
 */
const resolution = (
  reason: LinkResolution['excludeReason'],
  path: string,
  targetExists = true,
): LinkResolution => ({
  path,
  sourcePath: SOURCE,
  sourceLine: 7,
  targetExists,
  bundled: false,
  excludeReason: reason,
  linkHref: path,
});

describe('walkerExclusionsToIssues', () => {
  it('maps every one of the walker\'s eleven reasons to an issue code', () => {
    const input: LinkResolution[] = [
      resolution('depth-exceeded', '/root/a.md'),
      resolution('outside-project', '/other/b.md'),
      resolution('gitignored', '/root/dist/c.md'),
      resolution('skill-definition', '/root/other/SKILL.md'),
      resolution(DIRECTORY_TARGET, '/root/dir'),
      resolution('navigation-file', '/root/README.md'),
      resolution('agent-instruction-file', '/root/packages/core/CLAUDE.md'),
      resolution('missing-target', '/root/nope.md', false),
      resolution('unreadable-target', '/root/docs/locked.md'),
      resolution(PATTERN_MATCHED, '/root/docs/x.md'),
      resolution('non-routable-source', '/root/docs/diagram.svg'),
    ];
    const issues = walkerExclusionsToIssues(input, '/root');
    const codes = issues.map(i => i.code);
    expect(codes).toEqual([
      'LINK_DROPPED_BY_DEPTH',
      'LINK_OUTSIDE_PROJECT',
      'LINK_TO_GITIGNORED_FILE',
      'LINK_TO_SKILL_DEFINITION',
      // Every reason the walker can record now reaches a code. `directory-target`
      // and `pattern-matched` used to be the two that did not: the engine returned
      // null for both and the loop filtered them out, so an author whose link
      // pointed at a directory — or whose reference their own exclude rule
      // refused — got no output at all from this lane. Reason count and issue
      // count are equal, and that equality is the property under test.
      'LINK_TO_UNBUNDLED_DIRECTORY',
      'LINK_TO_NAVIGATION_FILE',
      'LINK_TO_AGENT_INSTRUCTION_FILE',
      'LINK_MISSING_TARGET',
      'LINK_TARGET_UNREADABLE',
      'LINK_EXCLUDED_BY_PATTERN',
      'LINK_FROM_NON_ROUTABLE_FILE',
    ]);
    expect(codes).toHaveLength(input.length);
  });

  it('anchors the issue at the file CONTAINING the link, not the target', () => {
    // The target of a `missing-target` exclusion does not exist, so a location
    // naming it points at nothing. `link` carries the target instead.
    const issues = walkerExclusionsToIssues(
      [resolution('missing-target', '/root/docs/nope.md', false)],
      '/root',
    );
    expect(issues[0]?.location).toBe('skills/demo/SKILL.md');
    expect(issues[0]?.line).toBe(7);
    expect(issues[0]?.link).toBe('/root/docs/nope.md');
  });

  it('reads existence from the walker record instead of asserting it', () => {
    // The engine gates LINK_TO_GITIGNORED_FILE on "gitignored AND exists at
    // source". Hardcoding `existsAtSource: true` here made that guard dead
    // code and rubber-stamped a walker mislabel into a leak accusation about a
    // file that is not there. With the record consulted, a `gitignored` record
    // that says the target is absent falls through to the broken-link verdict.
    const issues = walkerExclusionsToIssues(
      [resolution('gitignored', '/root/dist/vanished.md', false)],
      '/root',
    );
    expect(issues.map(i => i.code)).toEqual(['LINK_MISSING_TARGET']);
  });
});

/**
 * The two reasons this lane used to swallow. Both are adopter-visible strings,
 * so these pin the exact message and severity rather than merely asserting that
 * "an issue was produced" — a test that only counts issues cannot tell a useful
 * finding from a wrong one, and the message IS the finding for a code whose
 * whole purpose is to end a silence.
 */
describe('walkerExclusionsToIssues: the two previously-silent reasons', () => {
  it('reports a prose link to a directory as a warning naming the unshipped target', () => {
    const issues = walkerExclusionsToIssues(
      [resolution(DIRECTORY_TARGET, DIRECTORY_PATH)],
      '/root',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('LINK_TO_UNBUNDLED_DIRECTORY');
    // `warning`, not `error`: #126/D7 decided a navigational directory link is a
    // VALID reference and must not fail a build, and the two sibling codes for
    // the identical phenomenon (LINK_TO_NAVIGATION_FILE,
    // LINK_FROM_NON_ROUTABLE_FILE — "target excluded, packaged link points at
    // nothing") are both warnings.
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toBe(
      'Markdown link targets a directory; directories are never bundled, so the target did not ship and the packaged link points at nothing. (link: /root/docs/guides)',
    );
    // Anchored at the file containing the link, as every issue from this lane is.
    expect(issues[0]?.location).toBe('skills/demo/SKILL.md');
    expect(issues[0]?.link).toBe('/root/docs/guides');
  });

  it('does not reuse LINK_TARGETS_DIRECTORY, whose remedy contradicts this case', () => {
    // LINK_TARGETS_DIRECTORY is the packaging-validator's typed-slot code: an
    // `error` whose own fix text says navigational prose links to a directory do
    // NOT trigger it. Emitting it here would hand one author a finding that
    // denies its own applicability, and would fail builds #126 deliberately
    // allowed. The two codes coexist and say different things.
    const issues = walkerExclusionsToIssues(
      [resolution(DIRECTORY_TARGET, DIRECTORY_PATH)],
      '/root',
    );
    expect(issues.map(i => i.code)).not.toContain('LINK_TARGETS_DIRECTORY');
  });

  it('reports a pattern-excluded reference at info, so it is there when looked for', () => {
    const issues = walkerExclusionsToIssues(
      [resolution(PATTERN_MATCHED, PATTERN_EXCLUDED_PATH)],
      '/root',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('LINK_EXCLUDED_BY_PATTERN');
    // `info`: the author configured this exclusion themselves, so anything
    // louder is noise on a working configuration. Info is the codebase's
    // "available when someone is looking, silent when they are not" severity —
    // the same posture LINK_DEFERRED_ARTIFACT takes.
    expect(issues[0]?.severity).toBe('info');
    expect(issues[0]?.message).toBe(
      'A reference was excluded from the bundle by an excludeReferencesFromBundle rule this project declared; the target did not ship. (link: /root/docs/internal.md)',
    );
  });

  it('names the patterns that refused the reference, not just that something did', () => {
    // "Why did this file not ship?" is the question the silence left unanswered.
    // The walker already records WHICH rule matched; without it in the message
    // an author with several rules learns only that one of them fired.
    const rule: ExcludeRule = { patterns: ['docs/**', 'internal/**'] };
    const issues = walkerExclusionsToIssues(
      [{ ...resolution(PATTERN_MATCHED, PATTERN_EXCLUDED_PATH), matchedRule: rule }],
      '/root',
    );
    expect(issues[0]?.message).toBe(
      'A reference was excluded from the bundle by an excludeReferencesFromBundle rule this project declared; the target did not ship. (link: /root/docs/internal.md; matched excludeReferencesFromBundle pattern(s): docs/**, internal/**)',
    );
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
