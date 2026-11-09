// Test helpers legitimately use dynamic paths

/**
 * Skills test setup helpers for system tests
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import * as yaml from 'yaml';

import { getBinPath , createTestTempDir } from '../test-common.js';

import type { CliResult } from './cli-runner.js';

/**
 * Set up test suite for skills install command tests
 * Creates temp directories and provides consistent setup/cleanup
 *
 * @param testPrefix - Prefix for temp directory name
 * @param testFileUrl - import.meta.url from the calling test file, used to resolve
 *   binPath relative to the test file's location (not process.cwd(), which varies
 *   depending on whether vitest is invoked from the monorepo root or the package dir)
 * @returns Suite object with tempDir, projectDir, skillsDir, binPath, and lifecycle methods
 */
export function setupInstallTestSuite(testPrefix: string, testFileUrl: string): {
  tempDir: string;
  projectDir: string;
  skillsDir: string;
  binPath: string;
  beforeEach: () => void;
  afterEach: () => void;
} {
  const suite = {
    tempDir: '',
    projectDir: '',
    skillsDir: '',
    binPath: getBinPath(testFileUrl),
    beforeEach: () => {
      suite.tempDir = createTestTempDir(testPrefix);
      suite.projectDir = safePath.join(suite.tempDir, 'project');
      suite.skillsDir = safePath.join(suite.projectDir, '.claude', 'skills');
      mkdirSyncReal(suite.skillsDir, { recursive: true });
    },
    afterEach: () => {
      if (suite.tempDir) {
        fs.rmSync(suite.tempDir, { recursive: true, force: true });
      }
    },
  };

  return suite;
}

/**
 * Execute skills command and verify YAML output is parseable
 * Eliminates duplication in skills test files
 *
 * @param binPath - Path to CLI binary
 * @param command - Command to run (e.g., 'list' or 'validate')
 * @param targetPath - Path to directory to scan
 * @returns Object with result and parsed output
 */
export function executeSkillsCommandAndExpectYaml(
  binPath: string,
  command: string,
  targetPath: string,
  extraArgs: readonly string[] = []
): { result: CliResult; parsed: Record<string, unknown> } {
  const result = spawnSync(NODE_EXECUTABLE, [binPath, 'skills', command, targetPath, ...extraArgs], {
    encoding: 'utf-8',
  });

  const parsed = yaml.parse(result.stdout) as Record<string, unknown>;
  return { result, parsed };
}

/**
 * Create an installed skill directory (non-symlink) for uninstall testing
 */
export function createInstalledSkillDir(skillsDir: string, skillName: string): void {
  const skillPath = safePath.join(skillsDir, skillName);
  mkdirSyncReal(skillPath, { recursive: true });
  fs.writeFileSync(safePath.join(skillPath, 'SKILL.md'), `# ${skillName}\nTest skill content`);
}
