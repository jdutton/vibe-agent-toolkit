/* eslint-disable security/detect-non-literal-fs-filename -- Test code */
import { existsSync, cpSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { packageSkill } from '../../src/skill-packager.js';

const FIXTURE_DIR = safePath.join(import.meta.dirname, '..', 'fixtures', 'skill-files');

/**
 * Shared test setup for skill-files integration tests.
 *
 * Creates a temp directory seeded from the post-build fixture and a
 * package.json with "workspaces" so that findProjectRoot() anchors to
 * tempDir instead of walking up to the monorepo root.  This ensures
 * files[].source paths like "dist/bin/cli.mjs" resolve relative to
 * the temp dir rather than the workspace root.
 */
function setupSkillFilesTestDir(): { getTempDir: () => string } {
  let tempDir = '';

  beforeAll(async () => {
    tempDir = safePath.join(normalizedTmpdir(), `skill-files-integration-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    // Copy post-build fixture content into the temp dir
    cpSync(safePath.join(FIXTURE_DIR, 'post-build'), tempDir, { recursive: true });

    // Add a package.json with "workspaces" so findProjectRoot() stops here
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

const { getTempDir } = setupSkillFilesTestDir();

const FILES_ENTRY = [{ source: 'dist/bin/cli.mjs', dest: 'scripts/cli.mjs' }];

describe('skill files integration', () => {
  it('should copy files config source to dest in packaged output', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'skills', 'tool-a', 'SKILL.md');
    const outputPath = safePath.join(tempDir, 'out', 'tool-a');

    const result = await packageSkill(skillPath, {
      outputPath,
      files: FILES_ENTRY,
    });

    expect(existsSync(safePath.join(result.outputPath, 'scripts', 'cli.mjs'))).toBe(true);
  });

  it('should route auto-discovered .sh to scripts/', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'skills', 'tool-a', 'SKILL.md');
    const outputPath = safePath.join(tempDir, 'out', 'tool-a-routing');

    const result = await packageSkill(skillPath, {
      outputPath,
      files: FILES_ENTRY,
    });

    expect(existsSync(safePath.join(result.outputPath, 'scripts', 'helper.mjs'))).toBe(true);
  });

  it('should keep .md resources in resources/', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'skills', 'tool-a', 'SKILL.md');
    const outputPath = safePath.join(tempDir, 'out', 'tool-a-md');

    const result = await packageSkill(skillPath, {
      outputPath,
      files: FILES_ENTRY,
    });

    expect(existsSync(safePath.join(result.outputPath, 'resources', 'guide.md'))).toBe(true);
  });

  it('should fail build when files source does not exist', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'skills', 'tool-b', 'SKILL.md');
    const outputPath = safePath.join(tempDir, 'out', 'tool-b-missing');

    await expect(
      packageSkill(skillPath, {
        outputPath,
        linkFollowDepth: 0,
        files: [
          { source: 'nonexistent/cli.mjs', dest: 'scripts/cli.mjs' },
        ],
      })
    ).rejects.toThrow(/does not exist/i);
  });

  it('should handle same build artifact in multiple skills', async () => {
    const tempDir = getTempDir();

    const resultA = await packageSkill(
      safePath.join(tempDir, 'skills', 'tool-a', 'SKILL.md'),
      { outputPath: safePath.join(tempDir, 'out', 'multi-a'), files: FILES_ENTRY },
    );
    const resultB = await packageSkill(
      safePath.join(tempDir, 'skills', 'tool-b', 'SKILL.md'),
      { outputPath: safePath.join(tempDir, 'out', 'multi-b'), linkFollowDepth: 0, files: FILES_ENTRY },
    );

    expect(existsSync(safePath.join(resultA.outputPath, 'scripts', 'cli.mjs'))).toBe(true);
    expect(existsSync(safePath.join(resultB.outputPath, 'scripts', 'cli.mjs'))).toBe(true);
  });
});
