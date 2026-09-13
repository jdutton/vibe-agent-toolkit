/**
 * The pure half of `vat audit`'s directory lane: a flat enumeration (what the
 * `crawl` lane hands back) → the subjects the audit validates, in the order the
 * old recursive walk produced them, plus the two other facts the walk used to
 * discover on its way down (nested configs, exclusion by the project's own
 * `resources.exclude`).
 *
 * No filesystem here. The enumeration itself is the `crawl` lane's, pinned in
 * `test/integration/audit-scan-population.integration.test.ts`; this file pins
 * what the audit MAKES of an enumeration, which is the part that used to be
 * interleaved with `readdir` and therefore untestable without a tree.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';

import {
  classifyScanPopulation,
  isExcludedByMatcher,
  type AuditScanSubject,
} from '../../../src/commands/audit/scan-population.js';

const ROOT = '/scan';

/** `[kind, scan-relative path]` — readable in a `toEqual`. */
function shape(subjects: readonly AuditScanSubject[]): [string, string][] {
  return subjects.map((s) => [s.kind, safePath.relative(ROOT, s.kind === 'plugin' ? s.dir : s.path)]);
}

describe('classifyScanPopulation', () => {
  it('names a skill for every SKILL.md and a registry for every registry file', () => {
    const { subjects } = classifyScanPopulation(ROOT, [
      'skills/a/SKILL.md',
      'installed_plugins.json',
      'skills/a/README.md',
      'known_marketplaces.json',
    ], true);

    expect(shape(subjects)).toEqual([
      ['registry', 'installed_plugins.json'],
      ['registry', 'known_marketplaces.json'],
      ['skill', 'skills/a/SKILL.md'],
    ]);
  });

  it('names a plugin for a directory holding `.claude-plugin/`, once however many files are inside', () => {
    const { subjects } = classifyScanPopulation(ROOT, [
      'plug/.claude-plugin/plugin.json',
      'plug/.claude-plugin/marketplace.json',
      'plug/skills/x/SKILL.md',
    ], true);

    expect(shape(subjects)).toEqual([
      ['plugin', 'plug'],
      ['skill', 'plug/skills/x/SKILL.md'],
    ]);
  });

  it('orders as the recursive walk did: a directory’s own subjects (plugin first) before its subdirectories’', () => {
    const { subjects } = classifyScanPopulation(ROOT, [
      'b/SKILL.md',
      'a/nested/SKILL.md',
      'a/.claude-plugin/plugin.json',
      'a/SKILL.md',
      'a/Aardvark/SKILL.md',
      'SKILL.md',
    ], true);

    expect(shape(subjects)).toEqual([
      ['skill', 'SKILL.md'],
      ['plugin', 'a'],
      ['skill', 'a/SKILL.md'],
      ['skill', 'a/Aardvark/SKILL.md'],
      ['skill', 'a/nested/SKILL.md'],
      ['skill', 'b/SKILL.md'],
    ]);
  });

  it('is deterministic whatever order the enumeration arrived in', () => {
    const paths = ['z/SKILL.md', 'a/SKILL.md', 'm/.claude-plugin/plugin.json', 'm/SKILL.md'];
    const forward = classifyScanPopulation(ROOT, paths, true).subjects;
    const reversed = classifyScanPopulation(ROOT, [...paths].reverse(), true).subjects;

    expect(shape(reversed)).toEqual(shape(forward));
  });

  it('under --no-recursive keeps only the root’s files and the immediate subdirectories’ plugin markers', () => {
    const { subjects } = classifyScanPopulation(ROOT, [
      'SKILL.md',
      'installed_plugins.json',
      'plug/.claude-plugin/plugin.json',
      'plug/SKILL.md',
      'deep/plug/.claude-plugin/plugin.json',
      'skills/a/SKILL.md',
    ], false);

    // Byte order within a directory, as git lists: `S` before `i`.
    expect(shape(subjects)).toEqual([
      ['skill', 'SKILL.md'],
      ['registry', 'installed_plugins.json'],
      ['plugin', 'plug'],
    ]);
  });

  it('reports every nested config strictly beneath the root, and never the root’s own', () => {
    const { nestedConfigs } = classifyScanPopulation(ROOT, [
      'vibe-agent-toolkit.config.yaml',
      'pkg/a/vibe-agent-toolkit.config.yaml',
      'pkg/b/vibe-agent-toolkit.config.yaml',
    ], true);

    expect(nestedConfigs).toEqual([
      safePath.join(ROOT, 'pkg/a/vibe-agent-toolkit.config.yaml'),
      safePath.join(ROOT, 'pkg/b/vibe-agent-toolkit.config.yaml'),
    ]);
  });

  it('ignores files that are none of the audit’s subjects', () => {
    const { subjects, nestedConfigs } = classifyScanPopulation(ROOT, [
      'README.md',
      'skill.md',
      'x/.claude-plugin',
      'x/claude-plugin/plugin.json',
      'notes/installed_plugins.json.bak',
    ], true);

    expect(subjects).toEqual([]);
    expect(nestedConfigs).toEqual([]);
  });

  it('resolves every subject to an absolute path under the scan root', () => {
    const { subjects } = classifyScanPopulation(ROOT, ['p/.claude-plugin/plugin.json', 'p/s/SKILL.md'], true);

    expect(subjects).toEqual([
      { kind: 'plugin', dir: safePath.join(ROOT, 'p') },
      { kind: 'skill', dir: safePath.join(ROOT, 'p/s'), path: safePath.join(ROOT, 'p/s/SKILL.md') },
    ]);
  });
});

describe('isExcludedByMatcher', () => {
  // The project's `resources.exclude` is written against the PROJECT root, and
  // the walk used to prune a directory the moment it matched, so a file is out
  // when it matches or when any directory between the scan root and it does.
  const matcher = { isMatch: picomatch(['fixtures/**', 'vendor'], { dot: true }), base: '/proj' };

  it('excludes a file whose own path matches', () => {
    expect(isExcludedByMatcher(matcher, '/proj', '/proj/fixtures/x/SKILL.md')).toBe(true);
  });

  it('excludes a file beneath a directory the pattern names bare, as the walk pruned it', () => {
    // `vendor` never matches `vendor/x/SKILL.md` as a file; it matched the
    // DIRECTORY on the way down, and everything under it never got listed.
    expect(isExcludedByMatcher(matcher, '/proj', '/proj/vendor/x/SKILL.md')).toBe(true);
  });

  it('keeps a file nothing matches', () => {
    expect(isExcludedByMatcher(matcher, '/proj', '/proj/skills/x/SKILL.md')).toBe(false);
  });

  it('never tests the scan root itself or anything above it', () => {
    // The operator pointed the scan AT `vendor`; their intent wins, and the
    // ancestors between the project root and the scan root were never walked.
    expect(isExcludedByMatcher(matcher, '/proj/vendor', '/proj/vendor/x/SKILL.md')).toBe(false);
  });
});
