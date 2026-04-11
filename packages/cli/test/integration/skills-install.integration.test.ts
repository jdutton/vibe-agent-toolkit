/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installCommand } from '../../src/commands/skills/install.js';
import { captureStdout } from '../helpers/stdout-capture.js';

function createSkillDir(parent: string, name: string, description: string): string {
  const dir = safePath.join(parent, name);
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nTest skill body.\n`,
    'utf-8',
  );
  return dir;
}

/**
 * Create a two-skill dist/skills/ directory in tempDir with the given subdirName.
 * Returns { distSkills, projectDir }.
 */
function createMultiSkillProject(
  tempDir: string,
  subdirName: string,
): { distSkills: string; projectDir: string } {
  const distSkills = safePath.join(tempDir, subdirName);
  mkdirSyncReal(distSkills, { recursive: true });
  createSkillDir(distSkills, 'skill-one', 'First.');
  createSkillDir(distSkills, 'skill-two', 'Second.');

  const projectDir = safePath.join(tempDir, 'project');
  mkdirSyncReal(projectDir, { recursive: true });

  return { distSkills, projectDir };
}

/**
 * Install a skill once so subsequent tests can assert duplicate/overwrite behaviour.
 * Returns { skillSrc, projectDir }.
 */
async function setupInstalledSkill(
  tempDir: string,
): Promise<{ skillSrc: string; projectDir: string }> {
  const skillSrc = createSkillDir(tempDir, 'dup-skill', 'First.');
  const projectDir = safePath.join(tempDir, 'project');
  mkdirSyncReal(projectDir, { recursive: true });
  await installCommand(skillSrc, { target: 'claude', scope: 'project', cwd: projectDir });
  return { skillSrc, projectDir };
}

describe('vat skills install — local directory source', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-skills-install-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('installs a single skill from a local directory to the project scope', async () => {
    const skillSrc = createSkillDir(tempDir, 'hello-skill', 'Says hello to the user.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await installCommand(skillSrc, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
    });

    const installedSkillMd = safePath.join(projectDir, '.claude/skills/hello-skill/SKILL.md');
    expect(existsSync(installedSkillMd)).toBe(true);
    const content = await readFile(installedSkillMd, 'utf-8');
    expect(content).toContain('name: hello-skill');
  });

  it('fails pre-verification when SKILL.md is missing required frontmatter', async () => {
    const skillSrc = safePath.join(tempDir, 'broken-skill');
    mkdirSyncReal(skillSrc, { recursive: true });
    writeFileSync(safePath.join(skillSrc, 'SKILL.md'), '# broken\n\nNo frontmatter.\n', 'utf-8');

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await expect(
      installCommand(skillSrc, { target: 'claude', scope: 'project', cwd: projectDir }),
    ).rejects.toThrow(/validation failed/i);

    expect(existsSync(safePath.join(projectDir, '.claude/skills/broken-skill'))).toBe(false);
  });

  it('refuses to overwrite an existing skill without --force', async () => {
    const { skillSrc, projectDir } = await setupInstalledSkill(tempDir);

    await expect(
      installCommand(skillSrc, { target: 'claude', scope: 'project', cwd: projectDir }),
    ).rejects.toThrow(/already installed/i);
  });

  it('overwrites with --force', async () => {
    const { skillSrc, projectDir } = await setupInstalledSkill(tempDir);

    writeFileSync(
      safePath.join(skillSrc, 'SKILL.md'),
      `---\nname: dup-skill\ndescription: Second.\n---\n\n# dup-skill\n\nUpdated.\n`,
      'utf-8',
    );

    await installCommand(skillSrc, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
      force: true,
    });

    const content = await readFile(
      safePath.join(projectDir, '.claude/skills/dup-skill/SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('Updated');
  });

  it('dry-run writes nothing to the filesystem', async () => {
    const skillSrc = createSkillDir(tempDir, 'preview-skill', 'Preview.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await installCommand(skillSrc, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
      dryRun: true,
    });

    expect(existsSync(safePath.join(projectDir, '.claude/skills/preview-skill'))).toBe(false);
  });

  it('installs from a local ZIP file', async () => {
    const skillSrc = createSkillDir(tempDir, 'zipped-skill', 'From a zip.');
    const zipPath = safePath.join(tempDir, 'zipped-skill.zip');

    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addLocalFolder(skillSrc, 'zipped-skill');
    zip.writeZip(zipPath);

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await installCommand(zipPath, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
    });

    expect(existsSync(safePath.join(projectDir, '.claude/skills/zipped-skill/SKILL.md'))).toBe(true);
  });

  it('installs from an npm tarball (simulating npm: source)', async () => {
    // Build a synthetic npm package layout: package/dist/skills/my-skill/SKILL.md
    const pkgDir = safePath.join(tempDir, 'fake-npm-pkg', 'package');
    mkdirSyncReal(safePath.join(pkgDir, 'dist', 'skills'), { recursive: true });
    createSkillDir(safePath.join(pkgDir, 'dist', 'skills'), 'npm-skill', 'From npm.');
    writeFileSync(
      safePath.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'fake-pkg', version: '1.0.0' }),
      'utf-8',
    );

    const tarModule = await import('tar');
    const tarballPath = safePath.join(tempDir, 'fake-pkg-1.0.0.tgz');
    await tarModule.create(
      { file: tarballPath, cwd: safePath.join(tempDir, 'fake-npm-pkg'), gzip: true },
      ['package'],
    );

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await installCommand(tarballPath, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
    });

    expect(existsSync(safePath.join(projectDir, '.claude/skills/npm-skill/SKILL.md'))).toBe(true);
  });

  it('paths returned in output use forward slashes', async () => {
    const skillSrc = createSkillDir(tempDir, 'slash-skill', 'Forward slashes only.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    const captured: string[] = [];
    const restore = captureStdout(captured);

    try {
      await installCommand(skillSrc, {
        target: 'claude',
        scope: 'project',
        cwd: projectDir,
      });
    } finally {
      restore();
    }

    const output = captured.join('');
    const backslashMatches = output.match(/\\/g);
    expect(backslashMatches).toBeNull();
    expect(output).toContain('slash-skill');
  });

  it('discovers multiple skills from a dist/skills/ directory', async () => {
    const { distSkills, projectDir } = createMultiSkillProject(tempDir, 'multi-src');

    await installCommand(distSkills, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
    });

    expect(existsSync(safePath.join(projectDir, '.claude/skills/skill-one/SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(projectDir, '.claude/skills/skill-two/SKILL.md'))).toBe(true);
  });

  it('all-or-nothing: one broken skill in a batch blocks all installs', async () => {
    const distSkills = safePath.join(tempDir, 'mixed-src');
    mkdirSyncReal(distSkills, { recursive: true });
    createSkillDir(distSkills, 'good-skill', 'Good.');
    // broken-skill has SKILL.md with no frontmatter
    const brokenDir = safePath.join(distSkills, 'broken-skill');
    mkdirSyncReal(brokenDir, { recursive: true });
    writeFileSync(safePath.join(brokenDir, 'SKILL.md'), '# broken\n', 'utf-8');

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await expect(
      installCommand(distSkills, {
        target: 'claude',
        scope: 'project',
        cwd: projectDir,
      }),
    ).rejects.toThrow();

    // Neither skill should be installed
    expect(existsSync(safePath.join(projectDir, '.claude/skills/good-skill'))).toBe(false);
    expect(existsSync(safePath.join(projectDir, '.claude/skills/broken-skill'))).toBe(false);
  });

  it('rejects --name when multiple skills are discovered', async () => {
    const { distSkills, projectDir } = createMultiSkillProject(tempDir, 'multi-name-src');

    await expect(
      installCommand(distSkills, {
        target: 'claude',
        scope: 'project',
        cwd: projectDir,
        name: 'renamed',
      }),
    ).rejects.toThrow(/--name.*single-skill/);
  });

  it('rejects --name with path traversal characters', async () => {
    const skillSrc = createSkillDir(tempDir, 'traversal-skill', 'Traversal test.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await expect(
      installCommand(skillSrc, {
        target: 'claude',
        scope: 'project',
        cwd: projectDir,
        name: '../../etc',
      }),
    ).rejects.toThrow(/path separators/);
  });

  it('rejects --name containing forward slash', async () => {
    const skillSrc = createSkillDir(tempDir, 'slash-name-skill', 'Slash test.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await expect(
      installCommand(skillSrc, {
        target: 'claude',
        scope: 'project',
        cwd: projectDir,
        name: 'foo/bar',
      }),
    ).rejects.toThrow(/path separators/);
  });
});
