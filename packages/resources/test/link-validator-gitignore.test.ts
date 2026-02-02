/**
 * Tests for git-ignore safety in link validation.
 *
 * Tests Phase 3 functionality:
 * - Non-ignored files cannot link to ignored files (error)
 * - Ignored files CAN link to ignored files (no error)
 * - Ignored files CAN link to non-ignored files (no error)
 * - External resources (outside project) skip git-ignore checks
 * - Project boundary detection with symlinks
 */

import fs from 'node:fs';
import path from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateLink } from '../src/link-validator.js';
import type { HeadingNode } from '../src/types.js';
import { isWithinProject } from '../src/utils.js';

import { createGitRepo, createLink, setupTempDirTestSuite } from './test-helpers.js';

const suite = setupTempDirTestSuite('link-validator-gitignore-');

describe('isWithinProject', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should return true for file within project', () => {
    const projectRoot = suite.tempDir;
    const filePath = path.join(projectRoot, 'docs', 'guide.md');

    expect(isWithinProject(filePath, projectRoot)).toBe(true);
  });

  it('should return false for file outside project', () => {
    const projectRoot = suite.tempDir;
    const filePath = path.join(normalizedTmpdir(), 'external', 'data.md');

    expect(isWithinProject(filePath, projectRoot)).toBe(false);
  });

  it('should return true for file at project root', () => {
    const projectRoot = suite.tempDir;
    const filePath = path.join(projectRoot, 'README.md');

    expect(isWithinProject(filePath, projectRoot)).toBe(true);
  });

  it('should handle non-existent files within project', () => {
    const projectRoot = suite.tempDir;
    const filePath = path.join(projectRoot, 'nonexistent.md');

    expect(isWithinProject(filePath, projectRoot)).toBe(true);
  });

  it('should prevent false positives with similar paths', () => {
    const projectRoot = suite.tempDir;
    // Create a path that starts with project root but is not inside it
    const parentDir = path.dirname(projectRoot);
    const similarPath = projectRoot + '-other';
    const filePath = path.join(parentDir, path.basename(similarPath), 'file.md');

    expect(isWithinProject(filePath, projectRoot)).toBe(false);
  });
});

describe('validateLink - git-ignore safety', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  /**
   * Helper to validate a link with git-ignore checking
   */
  async function validateWithGitIgnoreCheck(
    sourceFile: string,
    linkHref: string,
    projectRoot: string
  ) {
    const link = createLink('local_file', linkHref, 'Test link', 2);
    const headingsMap = new Map<string, HeadingNode[]>();

    return await validateLink(link, sourceFile, headingsMap, {
      projectRoot,
      skipGitIgnoreCheck: false,
    });
  }

  /**
   * Setup a test project with git and gitignore
   */
  async function setupGitProject(): Promise<{
    projectRoot: string;
    sourceFile: string;
    ignoredFile: string;
    nonIgnoredFile: string;
  }> {
    const projectRoot = suite.tempDir;

    // Initialize git repo properly (git check-ignore needs a real repo)
    createGitRepo(projectRoot);

    // Create .gitignore
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- projectRoot is from temp dir
    fs.writeFileSync(
      path.join(projectRoot, '.gitignore'),
      '# Test gitignore\nignored/\n*.secret\n'
    );

    // Create directory structure
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- projectRoot is from temp dir
    fs.mkdirSync(path.join(projectRoot, 'docs'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- projectRoot is from temp dir
    fs.mkdirSync(path.join(projectRoot, 'ignored'));

    // Create files
    const sourceFile = path.join(projectRoot, 'docs', 'guide.md');
    const ignoredFile = path.join(projectRoot, 'ignored', 'secret.md');
    const nonIgnoredFile = path.join(projectRoot, 'docs', 'public.md');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are from temp dir
    fs.writeFileSync(sourceFile, '# Guide\n[Link](../ignored/secret.md)\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are from temp dir
    fs.writeFileSync(ignoredFile, '# Secret\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are from temp dir
    fs.writeFileSync(nonIgnoredFile, '# Public\n');

    return { projectRoot, sourceFile, ignoredFile, nonIgnoredFile };
  }

  it('should error when non-ignored file links to ignored file', async () => {
    const { projectRoot, sourceFile, ignoredFile } = await setupGitProject();

    const result = await validateWithGitIgnoreCheck(sourceFile, '../ignored/secret.md', projectRoot);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('link_to_gitignored');
    expect(result?.message).toContain('gitignored');
    expect(result?.message).toContain(ignoredFile);
    expect(result?.suggestion).toBeDefined();
  });

  it('should allow ignored file to link to another ignored file', async () => {
    await setupGitProject();
    const projectRoot = suite.tempDir;

    // Create another ignored file
    const anotherIgnoredFile = path.join(projectRoot, 'ignored', 'other.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is from temp dir
    fs.writeFileSync(anotherIgnoredFile, '# Other Secret\n');

    // Create a source file that is also ignored
    const ignoredSourceFile = path.join(projectRoot, 'ignored', 'index.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is from temp dir
    fs.writeFileSync(ignoredSourceFile, '# Index\n[Link](./secret.md)\n');

    const result = await validateWithGitIgnoreCheck(ignoredSourceFile, './secret.md', projectRoot);

    // Should be valid (ignored → ignored is allowed)
    expect(result).toBeNull();
  });

  it('should allow ignored file to link to non-ignored file', async () => {
    await setupGitProject();
    const projectRoot = suite.tempDir;

    // Create ignored source file
    const ignoredSourceFile = path.join(projectRoot, 'ignored', 'index.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is from temp dir
    fs.writeFileSync(ignoredSourceFile, '# Index\n[Link](../docs/public.md)\n');

    const result = await validateWithGitIgnoreCheck(ignoredSourceFile, '../docs/public.md', projectRoot);

    // Should be valid (ignored → non-ignored is allowed)
    expect(result).toBeNull();
  });

  it('should skip git-ignore check for external resources', async () => {
    const { projectRoot, sourceFile } = await setupGitProject();

    // Create an external file (outside project)
    const externalDir = path.join(normalizedTmpdir(), 'external-project');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is from temp dir
    fs.mkdirSync(externalDir);
    const externalFile = path.join(externalDir, 'external.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is from temp dir
    fs.writeFileSync(externalFile, '# External\n');

    const result = await validateWithGitIgnoreCheck(sourceFile, externalFile, projectRoot);

    // Should be valid (external resources skip git-ignore checks)
    expect(result).toBeNull();

    // Cleanup
    fs.rmSync(externalDir, { recursive: true, force: true });
  });

  it('should validate non-ignored file to non-ignored file normally', async () => {
    const { projectRoot, sourceFile } = await setupGitProject();

    const result = await validateWithGitIgnoreCheck(sourceFile, './public.md', projectRoot);

    // Should be valid (non-ignored → non-ignored is normal operation)
    expect(result).toBeNull();
  });

  it('should handle files matching gitignore patterns', async () => {
    const { projectRoot, sourceFile } = await setupGitProject();

    // Create a file matching *.secret pattern
    const secretFile = path.join(projectRoot, 'docs', 'password.secret');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is from temp dir
    fs.writeFileSync(secretFile, 'secret-data\n');

    const result = await validateWithGitIgnoreCheck(sourceFile, './password.secret', projectRoot);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('link_to_gitignored');
  });
});
