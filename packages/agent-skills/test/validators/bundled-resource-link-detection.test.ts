/* eslint-disable security/detect-non-literal-fs-filename -- test helpers use controlled temp directories */

import * as fs from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_WEB_REFERENCES_SUBDIR,
  TARGET_SUBDIR_CATEGORIES,
} from '../../src/content-type-routing.js';
import { detectBundledResourceWithoutLinks } from '../../src/validators/bundled-resource-link-detection.js';
import { cleanupTestFiles, setupTempDir } from '../test-helpers.js';

const DEFAULT_BODY = '# sample\nbody\n';

/**
 * Create a skill dir with the given `<subdir>: [files]` layout.
 * An empty file list still creates the (empty) subdirectory.
 */
function makeSkillDir(
  parentDir: string,
  dirs: Readonly<Record<string, readonly string[]>>,
  body: string = DEFAULT_BODY,
): string {
  const skillDir = safePath.join(parentDir, 'sample-skill');
  mkdirSyncReal(skillDir, { recursive: true });
  fs.writeFileSync(safePath.join(skillDir, 'SKILL.md'), body);
  for (const [sub, files] of Object.entries(dirs)) {
    const subDir = safePath.join(skillDir, sub);
    mkdirSyncReal(subDir, { recursive: true });
    for (const file of files) {
      fs.writeFileSync(safePath.join(subDir, file), `content of ${file}\n`);
    }
  }
  return skillDir;
}

function runDetector(skillDir: string, linkedFiles: readonly string[] = []) {
  return detectBundledResourceWithoutLinks(
    safePath.join(skillDir, 'SKILL.md'),
    skillDir,
    linkedFiles,
    skillDir,
  );
}

// Mirrors the real `plugin-dev/skills/command-development` skill in the
// claude-plugins corpus: 7 files under references/, five backticked bare-path
// mentions in the body that between them name only TWO of the seven.
const CORPUS_REFERENCE_FILES = [
  'advanced-workflows.md',
  'documentation-patterns.md',
  'frontmatter-reference.md',
  'interactive-commands.md',
  'marketplace-considerations.md',
  'plugin-features-reference.md',
  'testing-strategies.md',
] as const;

const CORPUS_UNREFERENCED = [
  'advanced-workflows.md',
  'documentation-patterns.md',
  'interactive-commands.md',
  'marketplace-considerations.md',
  'testing-strategies.md',
] as const;

const CORPUS_REFERENCED = ['frontmatter-reference.md', 'plugin-features-reference.md'] as const;

const CORPUS_BODY = [
  '# command-development',
  '',
  'For complete syntax, see `references/plugin-features-reference.md` for bash execution.',
  '',
  '**See `references/plugin-features-reference.md` for detailed patterns.**',
  '',
  'See `references/plugin-features-reference.md` for commands that coordinate with hooks',
  '',
  'For frontmatter field specifications, see `references/frontmatter-reference.md`.',
  'For plugin-specific features, see `references/plugin-features-reference.md`.',
  '',
].join('\n');

describe('detectBundledResourceWithoutLinks', () => {
  const { getTempDir } = setupTempDir('bundled-resource-detection-');
  afterEach(() => cleanupTestFiles());

  it('emits one issue per bundled subdir with no links', () => {
    const skillDir = makeSkillDir(getTempDir(), {
      scripts: ['cli.mjs'],
      references: ['detail.md'],
      assets: ['logo.png'],
    });
    const issues = runDetector(skillDir);
    const dirs = issues.map((i) => i.location).sort((a, b) => (a ?? '').localeCompare(b ?? ''));
    expect(issues).toHaveLength(3);
    for (const issue of issues) {
      expect(issue.code).toBe('SKILL_REFERENCES_BUT_NO_LINKS');
      expect(issue.severity).toBe('info');
    }
    // `location` is relative to the supplied root (here the skill dir itself),
    // so each subdir is named outright rather than as an absolute-path suffix.
    expect(dirs).toEqual(['assets', 'references', 'scripts']);
  });

  it('does not fire when a linked file is inside the bundled subdir', () => {
    const skillDir = makeSkillDir(getTempDir(), { references: ['detail.md'] });
    const issues = runDetector(skillDir, [safePath.join(skillDir, 'references', 'detail.md')]);
    expect(issues).toHaveLength(0);
  });

  it('does not fire when SKILL.md body links into the bundled subdir', () => {
    const skillDir = makeSkillDir(
      getTempDir(),
      { scripts: ['cli.mjs'] },
      '# sample\n\nSee [the runner](scripts/cli.mjs).\n',
    );
    const issues = runDetector(skillDir);
    expect(issues).toHaveLength(0);
  });

  it('emits no issues when no bundled subdir exists', () => {
    const skillDir = makeSkillDir(getTempDir(), {});
    const issues = runDetector(skillDir);
    expect(issues).toHaveLength(0);
  });

  it('does not fire on empty bundled subdir (treat as not present)', () => {
    const skillDir = makeSkillDir(getTempDir(), { scripts: [] });
    const issues = runDetector(skillDir);
    expect(issues).toHaveLength(0);
  });

  // --- Vocabulary: derived from the content-type routing categories --------

  it('covers every content-type routing category plus the claude-web references dir', () => {
    const vocabulary = [...TARGET_SUBDIR_CATEGORIES, CLAUDE_WEB_REFERENCES_SUBDIR];
    for (const sub of vocabulary) {
      const skillDir = makeSkillDir(getTempDir(), { [sub]: ['orphan.md'] });
      const issues = runDetector(skillDir);
      expect(issues.map((i) => i.location), `subdir "${sub}" is not in the detector vocabulary`)
        .toEqual([sub]);
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it('fires on an unreferenced resources/ dir (routing sends every .md there)', () => {
    const skillDir = makeSkillDir(getTempDir(), { resources: ['guide.md'] });
    const issues = runDetector(skillDir);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toBe('resources');
  });

  // --- Per-file coverage: one live mention must not mask dead siblings -----

  it('fires for the dead files when only some files in the subdir are mentioned', () => {
    const skillDir = makeSkillDir(
      getTempDir(),
      { references: [...CORPUS_REFERENCE_FILES] },
      CORPUS_BODY,
    );
    const issues = runDetector(skillDir);

    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue?.code).toBe('SKILL_REFERENCES_BUT_NO_LINKS');
    expect(issue?.severity).toBe('info');
    expect(issue?.location).toBe('references');
    for (const dead of CORPUS_UNREFERENCED) {
      expect(issue?.message).toContain(dead);
    }
    // Positive control for the absence assertion below lives in the next test:
    // the same fixture with every file mentioned must produce no issue at all.
    for (const live of CORPUS_REFERENCED) {
      expect(issue?.message).not.toContain(live);
    }
  });

  it('does not fire when every file in the subdir is mentioned in an inline code span', () => {
    const body = [
      '# command-development',
      '',
      ...CORPUS_REFERENCE_FILES.map((f) => `See \`references/${f}\` for detail.`),
      '',
    ].join('\n');
    const skillDir = makeSkillDir(
      getTempDir(),
      { references: [...CORPUS_REFERENCE_FILES] },
      body,
    );
    expect(runDetector(skillDir)).toHaveLength(0);
  });

  it('accepts a bare prose path (no backticks, no markdown link) as a reference', () => {
    const skillDir = makeSkillDir(
      getTempDir(),
      { scripts: ['cli.mjs'] },
      '# sample\n\nRun scripts/cli.mjs before starting.\n',
    );
    expect(runDetector(skillDir)).toHaveLength(0);
  });

  it('counts a nested file by its subdir-relative path', () => {
    const skillDir = makeSkillDir(getTempDir(), {}, '# sample\n\nSee `references/deep/x.md`.\n');
    mkdirSyncReal(safePath.join(skillDir, 'references', 'deep'), { recursive: true });
    fs.writeFileSync(safePath.join(skillDir, 'references', 'deep', 'x.md'), '# x\n');
    expect(runDetector(skillDir)).toHaveLength(0);
  });

  it('a linked file covers only itself, not its dead siblings', () => {
    const skillDir = makeSkillDir(getTempDir(), { references: ['linked.md', 'orphan.md'] });
    const issues = runDetector(skillDir, [safePath.join(skillDir, 'references', 'linked.md')]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('orphan.md');
    expect(issues[0]?.message).not.toContain('linked.md');
  });
});
