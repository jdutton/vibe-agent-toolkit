/* eslint-disable security/detect-non-literal-fs-filename -- Test code */
import { existsSync, cpSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { packageSkill, type PackageSkillOptions } from '../../src/skill-packager.js';

const FIXTURE_DIR = safePath.join(import.meta.dirname, '..', 'fixtures', 'skill-files');
const CLI_FILES_ENTRY = [{ source: 'build-output/bin/cli.mjs', dest: 'scripts/cli.mjs' }];

/**
 * Shared test setup: copies post-build fixture to a temp dir with a
 * package.json so findProjectRoot() anchors there.
 */
function setupSkillFilesTestDir(): { getTempDir: () => string } {
  let tempDir = '';

  beforeAll(async () => {
    tempDir = safePath.join(normalizedTmpdir(), `skill-files-integration-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    cpSync(safePath.join(FIXTURE_DIR, 'post-build'), tempDir, { recursive: true });
    await writeFile(
      safePath.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'skill-files-test', workspaces: ['skills/*'] }),
    );
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  return { getTempDir: () => tempDir };
}

/** Package a skill from the fixture with a unique output dir name */
async function packageFixtureSkill(
  tempDir: string,
  skillName: string,
  outputSuffix: string,
  overrides: Partial<PackageSkillOptions> = {},
) {
  return packageSkill(
    safePath.join(tempDir, 'skills', skillName, 'SKILL.md'),
    {
      outputPath: safePath.join(tempDir, 'out', outputSuffix),
      files: CLI_FILES_ENTRY,
      ...overrides,
    },
  );
}

const { getTempDir } = setupSkillFilesTestDir();

describe('skill files integration', () => {
  it('should copy files config source to dest in packaged output', async () => {
    const result = await packageFixtureSkill(getTempDir(), 'tool-a', 'copy-test');
    expect(existsSync(safePath.join(result.outputPath, 'scripts', 'cli.mjs'))).toBe(true);
  });

  it('should route auto-discovered .mjs to scripts/', async () => {
    const result = await packageFixtureSkill(getTempDir(), 'tool-a', 'routing-test');
    expect(existsSync(safePath.join(result.outputPath, 'scripts', 'helper.mjs'))).toBe(true);
  });

  it('should keep .md resources in resources/', async () => {
    const result = await packageFixtureSkill(getTempDir(), 'tool-a', 'md-test');
    expect(existsSync(safePath.join(result.outputPath, 'resources', 'guide.md'))).toBe(true);
  });

  it('should fail build when files source does not exist', async () => {
    await expect(
      packageFixtureSkill(getTempDir(), 'tool-b', 'missing-test', {
        linkFollowDepth: 0,
        files: [{ source: 'nonexistent/cli.mjs', dest: 'scripts/cli.mjs' }],
      })
    ).rejects.toThrow(/does not exist/i);
  });

  it('should handle same build artifact in multiple skills', async () => {
    const tempDir = getTempDir();
    const resultA = await packageFixtureSkill(tempDir, 'tool-a', 'multi-a');
    const resultB = await packageFixtureSkill(tempDir, 'tool-b', 'multi-b', { linkFollowDepth: 0 });

    expect(existsSync(safePath.join(resultA.outputPath, 'scripts', 'cli.mjs'))).toBe(true);
    expect(existsSync(safePath.join(resultB.outputPath, 'scripts', 'cli.mjs'))).toBe(true);
  });
});
