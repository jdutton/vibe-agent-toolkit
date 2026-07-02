import { mkdir, writeFile } from 'node:fs/promises';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { validateShippedPluginSkillLinks } from '../../src/commands/build.js';
import { createTempDirTracker } from '../system/test-common.js';

function skillDirPath(cwd: string, marketplace: string, plugin: string, skill: string): string {
  return safePath.join(
    cwd, 'dist', '.claude', 'plugins', 'marketplaces', marketplace, 'plugins', plugin, 'skills', skill,
  );
}

describe('validateShippedPluginSkillLinks', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-shipped-links-');

  afterEach(() => cleanupTempDirs());

  it('returns a PACKAGED_BROKEN_LINK error for a shipped skill with a dead relative link', async () => {
    const cwd = createTempDir();
    const skillDir = skillDirPath(cwd, 'mp1', 'plugin-a', 'skill-a');
    mkdirSyncReal(skillDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
    await writeFile(
      safePath.join(skillDir, 'SKILL.md'),
      '---\nname: skill-a\ndescription: test\n---\n\nSee [missing](./missing.md).\n',
    );

    const issues = await validateShippedPluginSkillLinks(cwd);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_BROKEN_LINK');
    expect(issues[0]?.severity).toBe('error');
  });

  it('returns no issues for a shipped skill with only valid links', async () => {
    const cwd = createTempDir();
    const skillDir = skillDirPath(cwd, 'mp1', 'plugin-a', 'skill-a');
    mkdirSyncReal(skillDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
    await mkdir(safePath.join(skillDir, 'docs'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
    await writeFile(safePath.join(skillDir, 'docs', 'guide.md'), '# Guide\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
    await writeFile(
      safePath.join(skillDir, 'SKILL.md'),
      '---\nname: skill-a\ndescription: test\n---\n\nSee [guide](./docs/guide.md).\n',
    );

    const issues = await validateShippedPluginSkillLinks(cwd);

    expect(issues).toHaveLength(0);
  });

  it('returns no issues when no plugin tree has been built', async () => {
    const cwd = createTempDir();

    const issues = await validateShippedPluginSkillLinks(cwd);

    expect(issues).toHaveLength(0);
  });

  // Self-containment (docs/skill-quality-and-compatibility.md): a skill is a
  // portable unit that may be mounted standalone, so a link escaping the skill
  // dir is a broken shipped link even when the target co-ships in a sibling
  // skill of the same plugin. The correct fix is to bundle the file into the
  // skill and link it as ./foo.md, not to reach into a sibling.
  it('flags a link that escapes the skill dir to a sibling skill, even though the sibling file co-ships in the plugin', async () => {
    const cwd = createTempDir();
    const skillA = skillDirPath(cwd, 'mp1', 'plugin-a', 'skill-a');
    const skillB = skillDirPath(cwd, 'mp1', 'plugin-a', 'skill-b');
    mkdirSyncReal(skillA, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
    await mkdir(safePath.join(skillB, 'refs'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
    await writeFile(safePath.join(skillB, 'refs', 'guide.md'), '# Guide\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
    await writeFile(safePath.join(skillB, 'SKILL.md'), '---\nname: skill-b\ndescription: test\n---\n\n# skill-b\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
    await writeFile(
      safePath.join(skillA, 'SKILL.md'),
      '---\nname: skill-a\ndescription: test\n---\n\nSee [guide](../skill-b/refs/guide.md).\n',
    );

    const issues = await validateShippedPluginSkillLinks(cwd);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_BROKEN_LINK');
  });
});
