/**
 * Fragments are folded into `CHANGELOG.md` by the stable bump; a malformed
 * one must fail on the branch that wrote it. These cases pin the grammar, the
 * fold (existing sections keep their sub-structure, missing sections are
 * appended in changelog order), and the on-disk reader.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHANGES_DIR,
  FRAGMENT_SECTIONS,
  isFragmentProblem,
  mergeFragmentsIntoBody,
  parseFragment,
  readFragments,
  validateFragments,
  type ChangelogFragment,
} from '../src/changelog-fragments.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

const FILE = '.changes/topic.md';

function fragment(text: string): ChangelogFragment {
  const parsed = parseFragment(text, FILE);
  if (isFragmentProblem(parsed)) throw new Error(parsed.reason);
  return parsed;
}

describe('parseFragment', () => {
  it('accepts headings from the section list with bullets and continuations', () => {
    const parsed = fragment('### Fixed\n\n- **One thing.** Fixed.\n  Continued here.\n\n### Added\n\n- Another.\n');

    expect(isFragmentProblem(parsed)).toBe(false);
    expect([...parsed.sections.keys()]).toEqual(['Fixed', 'Added']);
    expect(parsed.sections.get('Fixed')).toEqual(['- **One thing.** Fixed.', '  Continued here.']);
  });

  it.each([
    ['an unknown section', '### Notes\n\n- x\n', /is not a changelog section/],
    ['a version heading', '## [1.0.0]\n\n- x\n', /version headings belong to CHANGELOG.md/],
    ['content before any heading', '- x\n\n### Fixed\n', /before the first/],
    ['a non-bullet line', '### Fixed\n\nplain prose\n', /expected a "- " bullet/],
    ['no bullets at all', '### Fixed\n\n', /no bullets/],
    ['an empty file', '', /no bullets/],
  ])('refuses %s', (_label, text, reason) => {
    const parsed = parseFragment(text, FILE);

    expect(isFragmentProblem(parsed)).toBe(true);
    if (isFragmentProblem(parsed)) expect(parsed.reason).toMatch(reason);
  });

  it('names every section the changelog uses, in changelog order', () => {
    expect([...FRAGMENT_SECTIONS]).toEqual(['Breaking', 'Added', 'Changed', 'Deprecated', 'Removed', 'Security', 'Fixed']);
  });
});

describe('mergeFragmentsIntoBody', () => {
  const body = ['', 'Intro prose.', '', '### Breaking', '', '#### CLI', '', '- old break', '', '### Fixed', '', '- old fix', ''].join('\n');

  it('appends bullets at the end of an existing section, keeping its sub-structure', () => {
    const merged = mergeFragmentsIntoBody(body, [fragment('### Breaking\n\n- new break\n')]);

    expect(merged).toBe(
      ['', 'Intro prose.', '', '### Breaking', '', '#### CLI', '', '- old break', '', '- new break', '', '### Fixed', '', '- old fix', ''].join('\n'),
    );
  });

  it('adds sections the body lacks, in changelog order, after the existing text', () => {
    const merged = mergeFragmentsIntoBody(body, [fragment('### Security\n\n- s\n\n### Added\n\n- a\n')]);

    const headings = merged.split('\n').filter((line) => line.startsWith('### '));
    expect(headings).toEqual(['### Breaking', '### Fixed', '### Added', '### Security']);
    expect(merged.endsWith('### Security\n\n- s\n')).toBe(true);
  });

  it('returns the body untouched when there are no fragments', () => {
    expect(mergeFragmentsIntoBody(body, [])).toBe(body);
  });

  it('concatenates the same section from several fragments in file order', () => {
    const merged = mergeFragmentsIntoBody('', [fragment('### Fixed\n\n- first\n'), fragment('### Fixed\n\n- second\n')]);

    expect(merged).toBe('\n### Fixed\n\n- first\n- second\n');
  });
});

describe('readFragments / validateFragments', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir({ prefix: 'changes-' });
    // eslint-disable-next-line local/no-fs-mkdirSync -- fixture path is a temp dir; realpath is not read back
    mkdirSync(safePath.join(root, CHANGES_DIR));
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('reads every .md except README.md, sorted, and reports problems beside fragments', () => {
    writeFileSync(safePath.join(root, CHANGES_DIR, 'README.md'), '# not a fragment');
    writeFileSync(safePath.join(root, CHANGES_DIR, 'b.md'), '### Fixed\n\n- b\n');
    writeFileSync(safePath.join(root, CHANGES_DIR, 'a.md'), '### Fixed\n\n- a\n');
    writeFileSync(safePath.join(root, CHANGES_DIR, 'bad.md'), 'nope\n');

    const { fragments, problems } = readFragments(root);

    expect(fragments.map((f) => f.relPath)).toEqual(['.changes/a.md', '.changes/b.md']);
    expect(problems.map((p) => p.relPath)).toEqual(['.changes/bad.md']);
    expect(validateFragments(root)).toHaveLength(1);
  });

  it('treats a missing .changes/ directory as "no fragments", not as an error', () => {
    const empty = createTestTempDir({ prefix: 'no-changes-' });
    try {
      expect(readFragments(empty)).toEqual({ fragments: [], problems: [] });
    } finally {
      cleanupTestTempDir(empty);
    }
  });
});
