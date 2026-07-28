/* eslint-disable security/detect-non-literal-fs-filename -- Test code */
import { existsSync, cpSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyFilesConfig, mergeFilesConfig } from '../../src/files-config.js';
import { packageSkill, type PackageSkillOptions } from '../../src/skill-packager.js';

const FIXTURE_DIR = safePath.join(import.meta.dirname, '..', 'fixtures', 'skill-files');

// Realistic files config: source uses dist/ (gitignored in real projects, simulated by test setup)
const CLI_FILES_ENTRY = [{ source: 'dist/bin/cli.mjs', dest: 'scripts/cli.mjs' }];

// Glob entry: all files under dist/packs/**/* rebased under packs/
const GLOB_FILES_ENTRY = { source: 'dist/packs/**/*', dest: 'packs' };

// Glob-linked file that tool-a's SKILL.md references; asserted preserved across tests.
const ALPHA_DATA_PATH = 'packs/alpha/data.json';

/**
 * Shared test setup: copies post-build fixture to a temp dir, then
 * simulates a project build step by copying the build artifact into
 * dist/bin/ (which would be gitignored in a real project).
 *
 * Writes both a `vibe-agent-toolkit.config.yaml` (so the canonical
 * findProjectRoot anchors to tempDir under the config-first ladder
 * introduced by plan 2026-05-17) and a package.json with "workspaces"
 * (preserved for any test logic that inspects npm-workspace metadata).
 */
function setupSkillFilesTestDir(): { getTempDir: () => string } {
  let tempDir = '';

  beforeAll(async () => {
    tempDir = safePath.join(normalizedTmpdir(), `skill-files-integration-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    cpSync(safePath.join(FIXTURE_DIR, 'post-build'), tempDir, { recursive: true });

    // Simulate build step: copy build artifact into dist/ (gitignored in real projects)
    const distBin = safePath.join(tempDir, 'dist', 'bin');
    await mkdir(distBin, { recursive: true });
    cpSync(
      safePath.join(FIXTURE_DIR, 'build-artifacts', 'bin', 'cli.mjs'),
      safePath.join(distBin, 'cli.mjs'),
    );

    // Simulate build step: copy packs artifact tree into dist/packs/ (gitignored in real projects)
    const distPacks = safePath.join(tempDir, 'dist', 'packs');
    await mkdir(distPacks, { recursive: true });
    cpSync(
      safePath.join(FIXTURE_DIR, 'build-artifacts', 'packs'),
      distPacks,
      { recursive: true },
    );

    await writeFile(
      safePath.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'skill-files-test', workspaces: ['skills/*'] }),
    );

    // Anchor canonical findProjectRoot at tempDir (plan 2026-05-17 narrowed
    // findProjectRoot to config-first, no longer consults npm workspaces).
    await writeFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      'version: 1\n',
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

describe('glob files entry integration', () => {
  /**
   * Package tool-a with both the CLI single-file entry and the glob packs entry.
   * tool-a's SKILL.md links to packs/alpha/data.json, which should be preserved.
   */
  it('should rebase glob-matched files under dest dir in packaged output', async () => {
    const tempDir = getTempDir();
    const result = await packageFixtureSkill(tempDir, 'tool-a', 'glob-tree-test', {
      files: [...CLI_FILES_ENTRY, GLOB_FILES_ENTRY],
    });

    // Rebased tree: both alpha and beta files appear under packs/
    expect(existsSync(safePath.join(result.outputPath, 'packs', 'alpha', 'data.json'))).toBe(true);
    expect(existsSync(safePath.join(result.outputPath, 'packs', 'beta', 'data.json'))).toBe(true);
  });

  it('should preserve content of glob-copied files byte-for-byte', async () => {
    const tempDir = getTempDir();
    const result = await packageFixtureSkill(tempDir, 'tool-a', 'glob-content-test', {
      files: [...CLI_FILES_ENTRY, GLOB_FILES_ENTRY],
    });

    const srcAlpha = readFileSync(safePath.join(tempDir, 'dist', 'packs', 'alpha', 'data.json'), 'utf-8');
    const dstAlpha = readFileSync(safePath.join(result.outputPath, 'packs', 'alpha', 'data.json'), 'utf-8');
    expect(dstAlpha).toBe(srcAlpha);

    const srcBeta = readFileSync(safePath.join(tempDir, 'dist', 'packs', 'beta', 'data.json'), 'utf-8');
    const dstBeta = readFileSync(safePath.join(result.outputPath, 'packs', 'beta', 'data.json'), 'utf-8');
    expect(dstBeta).toBe(srcBeta);
  });

  it('should preserve link to glob-dest file in packaged SKILL.md (not stripped to ())', async () => {
    const tempDir = getTempDir();
    const result = await packageFixtureSkill(tempDir, 'tool-a', 'glob-link-test', {
      files: [...CLI_FILES_ENTRY, GLOB_FILES_ENTRY],
    });

    const packedSkill = readFileSync(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    // The link to packs/alpha/data.json must NOT be stripped to ()
    expect(packedSkill).not.toContain('()\n');
    expect(packedSkill).toContain(ALPHA_DATA_PATH);
  });

  it('should not emit PACKAGED_UNREFERENCED issue for glob-linked file', async () => {
    const tempDir = getTempDir();
    const result = await packageFixtureSkill(tempDir, 'tool-a', 'glob-no-unreferenced-test', {
      files: [...CLI_FILES_ENTRY, GLOB_FILES_ENTRY],
    });

    // Sanity: the link IS genuinely preserved (so the assertion below passes for
    // the RIGHT reason — not because the array happens to be empty/undefined).
    const packedSkill = readFileSync(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(packedSkill).toContain(ALPHA_DATA_PATH);

    // No post-build issue flagging packs/alpha/data.json as unreferenced or broken.
    // For PACKAGED_UNREFERENCED_FILE the path lives in `location`; for
    // PACKAGED_BROKEN_LINK the source file is in `location` and the href in `message`.
    // Check both fields so either shape is caught.
    const issues = result.postBuildIssues ?? [];
    const unreferencedIssues = issues.filter((issue: ValidationIssue) =>
      (issue.code === 'PACKAGED_UNREFERENCED_FILE' || issue.code === 'PACKAGED_BROKEN_LINK') &&
      (toForwardSlash(issue.location ?? '').includes(ALPHA_DATA_PATH) ||
        toForwardSlash(issue.message).includes(ALPHA_DATA_PATH))
    );
    expect(unreferencedIssues).toHaveLength(0);
  });

  /**
   * Direct-primitive coverage for the `files:` glob expansion: mergeFilesConfig +
   * applyFilesConfig, exercised without going through skill-packager. Plugin-local
   * skills now route through `packageSkill` like every other skill (the old
   * verbatim tree-copy path and its `applyTreeCopiedSkillFiles` re-application are
   * gone), so this asserts the shared primitive rather than a second build path.
   */
  it('should rebase glob tree via applyFilesConfig (plugin-build path simulation)', async () => {
    const tempDir = getTempDir();

    // Simulate what build.ts does: mergeFilesConfig then applyFilesConfig
    const filesConfig = mergeFilesConfig(undefined, [GLOB_FILES_ENTRY]);
    const skillOutputDir = safePath.join(tempDir, 'out', 'plugin-build-sim', 'skills', 'tool-a');
    await mkdir(skillOutputDir, { recursive: true });

    const dests = await applyFilesConfig({
      filesConfig,
      projectRoot: tempDir,
      skillOutputDir,
    });

    // Should have copied both packs files
    expect(dests).toContain(toForwardSlash('packs/alpha/data.json'));
    expect(dests).toContain(toForwardSlash('packs/beta/data.json'));

    // Files must exist at the rebased dest paths
    expect(existsSync(safePath.join(skillOutputDir, 'packs', 'alpha', 'data.json'))).toBe(true);
    expect(existsSync(safePath.join(skillOutputDir, 'packs', 'beta', 'data.json'))).toBe(true);
  });
});
