/* eslint-disable security/detect-non-literal-fs-filename */
// Test helpers legitimately use dynamic paths

/**
 * Test project setup helpers for system tests
 */

import * as fs from 'node:fs';


import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

/**
 * Create a temporary test project directory
 */
export function createTempProject(baseTempDir: string, name: string): string {
  const projectDir = safePath.join(baseTempDir, name);
  mkdirSyncReal(projectDir);
  return projectDir;
}

/**
 * Setup a project with .git and optional config
 */
function setupProjectRoot(projectDir: string, config?: string): void {
  // Create .git to mark as project root
  mkdirSyncReal(safePath.join(projectDir, '.git'));

  if (config) {
    fs.writeFileSync(safePath.join(projectDir, 'vibe-agent-toolkit.config.yaml'), config);
  }
}

/**
 * Common test project setup with docs directory
 */
export interface TestProjectOptions {
  name: string;
  config?: string;
  withDocs?: boolean;
}

export function setupTestProject(
  baseTempDir: string,
  options: TestProjectOptions
): string {
  const projectDir = createTempProject(baseTempDir, options.name);
  setupProjectRoot(projectDir, options.config);

  if (options.withDocs) {
    mkdirSyncReal(safePath.join(projectDir, 'docs'));
  }

  return projectDir;
}

/**
 * Create a temporary directory for tests
 */
export function createTestTempDir(prefix: string): string {
  return fs.mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
}
