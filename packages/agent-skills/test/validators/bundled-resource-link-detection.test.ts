/* eslint-disable security/detect-non-literal-fs-filename -- test helpers use controlled temp directories */

import * as fs from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { detectBundledResourceWithoutLinks } from '../../src/validators/bundled-resource-link-detection.js';
import { cleanupTestFiles, setupTempDir } from '../test-helpers.js';

interface SkillLayout {
  hasScripts?: boolean;
  hasReferences?: boolean;
  hasAssets?: boolean;
}

function makeSkillDir(parentDir: string, layout: SkillLayout): string {
  const skillDir = safePath.join(parentDir, 'sample-skill');
  mkdirSyncReal(skillDir, { recursive: true });
  fs.writeFileSync(safePath.join(skillDir, 'SKILL.md'), '# sample\nbody\n');
  if (layout.hasScripts) {
    mkdirSyncReal(safePath.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(safePath.join(skillDir, 'scripts', 'cli.mjs'), 'console.log(1)\n');
  }
  if (layout.hasReferences) {
    mkdirSyncReal(safePath.join(skillDir, 'references'), { recursive: true });
    fs.writeFileSync(safePath.join(skillDir, 'references', 'detail.md'), '# detail\n');
  }
  if (layout.hasAssets) {
    mkdirSyncReal(safePath.join(skillDir, 'assets'), { recursive: true });
    fs.writeFileSync(safePath.join(skillDir, 'assets', 'logo.png'), 'fake');
  }
  return skillDir;
}

describe('detectBundledResourceWithoutLinks', () => {
  const { getTempDir } = setupTempDir('bundled-resource-detection-');
  afterEach(() => cleanupTestFiles());

  it('emits one issue per bundled subdir with no links', () => {
    const skillDir = makeSkillDir(getTempDir(), {
      hasScripts: true,
      hasReferences: true,
      hasAssets: true,
    });
    const issues = detectBundledResourceWithoutLinks(
      safePath.join(skillDir, 'SKILL.md'),
      skillDir,
      [], // no linked files
    );
    const dirs = issues.map((i) => i.location).sort((a, b) => (a ?? '').localeCompare(b ?? ''));
    expect(issues).toHaveLength(3);
    for (const issue of issues) {
      expect(issue.code).toBe('SKILL_REFERENCES_BUT_NO_LINKS');
      expect(issue.severity).toBe('info');
    }
    expect(dirs.some((d) => d?.endsWith('/scripts'))).toBe(true);
    expect(dirs.some((d) => d?.endsWith('/references'))).toBe(true);
    expect(dirs.some((d) => d?.endsWith('/assets'))).toBe(true);
  });

  it('does not fire when a linked file is inside the bundled subdir', () => {
    const skillDir = makeSkillDir(getTempDir(), { hasReferences: true });
    const issues = detectBundledResourceWithoutLinks(
      safePath.join(skillDir, 'SKILL.md'),
      skillDir,
      [safePath.join(skillDir, 'references', 'detail.md')],
    );
    expect(issues).toHaveLength(0);
  });

  it('does not fire when SKILL.md body links into the bundled subdir', () => {
    const skillDir = makeSkillDir(getTempDir(), { hasScripts: true });
    // Replace SKILL.md with a body that mentions scripts/ via markdown link.
    fs.writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      '# sample\n\nSee [the runner](scripts/cli.mjs).\n',
    );
    const issues = detectBundledResourceWithoutLinks(
      safePath.join(skillDir, 'SKILL.md'),
      skillDir,
      [],
    );
    expect(issues).toHaveLength(0);
  });

  it('emits no issues when none of the three subdirs exist', () => {
    const skillDir = makeSkillDir(getTempDir(), {});
    const issues = detectBundledResourceWithoutLinks(
      safePath.join(skillDir, 'SKILL.md'),
      skillDir,
      [],
    );
    expect(issues).toHaveLength(0);
  });

  it('does not fire on empty bundled subdir (treat as not present)', () => {
    const skillDir = makeSkillDir(getTempDir(), {});
    mkdirSyncReal(safePath.join(skillDir, 'scripts'), { recursive: true });
    const issues = detectBundledResourceWithoutLinks(
      safePath.join(skillDir, 'SKILL.md'),
      skillDir,
      [],
    );
    expect(issues).toHaveLength(0);
  });
});
