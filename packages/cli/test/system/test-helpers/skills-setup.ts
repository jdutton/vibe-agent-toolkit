/* eslint-disable security/detect-non-literal-fs-filename */
// Test helpers legitimately use dynamic paths

/**
 * Skills test setup helpers for system tests
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';

import type { CliResult } from './cli-runner.js';
import { createTestTempDir } from './project-setup.js';

/**
 * Set up test suite for skills install command tests
 * Creates temp directories and provides consistent setup/cleanup
 *
 * @param testPrefix - Prefix for temp directory name
 * @returns Suite object with tempDir, projectDir, skillsDir, binPath, and lifecycle methods
 */
export function setupInstallTestSuite(testPrefix: string): {
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
    binPath: safePath.join(process.cwd(), 'packages', 'cli', 'dist', 'bin.js'),
    beforeEach: () => {
      suite.tempDir = createTestTempDir(testPrefix);
      suite.projectDir = safePath.join(suite.tempDir, 'project');
      suite.skillsDir = safePath.join(suite.projectDir, '.claude', 'skills');
      fs.mkdirSync(suite.skillsDir, { recursive: true });
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
  targetPath: string
): { result: CliResult; parsed: Record<string, unknown> } {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Test helper
  const result = spawnSync('node', [binPath, 'skills', command, targetPath], {
    encoding: 'utf-8',
  });

  const parsed = yaml.load(result.stdout) as Record<string, unknown>;
  return { result, parsed };
}

/**
 * Create a test project with package.json containing vat.skills[] metadata
 * and optionally create built skill directories under dist/skills/
 *
 * In the new API, vat.skills is a flat string array (just names).
 *
 * Shared between skills-install-dev and skills-uninstall system tests
 */
export function setupDevTestProject(
  baseDir: string,
  name: string,
  skills: Array<{ name: string; built: boolean }>
): string {
  const projectDir = safePath.join(baseDir, name);
  mkdirSyncReal(projectDir, { recursive: true });

  fs.writeFileSync(
    safePath.join(projectDir, 'package.json'),
    JSON.stringify({
      name: '@test/my-package',
      version: '1.0.0',
      vat: { version: '1.0', type: 'agent-bundle', skills: skills.map(s => s.name) },
    })
  );

  for (const skill of skills) {
    if (skill.built) {
      const skillDir = safePath.join(projectDir, 'dist', 'skills', skill.name);
      mkdirSyncReal(skillDir, { recursive: true });
      fs.writeFileSync(safePath.join(skillDir, 'SKILL.md'), `# ${skill.name}\nTest skill content`);
    }
  }

  return projectDir;
}

/**
 * Create an installed skill directory (non-symlink) for uninstall testing
 */
export function createInstalledSkillDir(skillsDir: string, skillName: string): void {
  const skillPath = safePath.join(skillsDir, skillName);
  mkdirSyncReal(skillPath, { recursive: true });
  fs.writeFileSync(safePath.join(skillPath, 'SKILL.md'), `# ${skillName}\nTest skill content`);
}
