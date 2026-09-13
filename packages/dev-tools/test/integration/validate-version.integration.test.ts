 
// Test file - paths are controlled by test code, not user input

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CommandExecutionError, safeExecSync } from '@vibe-agent-toolkit/utils/process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createTestTempDir, cleanupTestTempDir, createMockPackageJson } from '../test-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function setupPackages(dir: string, versions: { pkg1: string; pkg2: string }): void {
  const packagesDir = safePath.join(dir, 'packages');
  mkdirSyncReal(packagesDir, { recursive: true });
  mkdirSyncReal(safePath.join(packagesDir, 'pkg1'), { recursive: true });
  mkdirSyncReal(safePath.join(packagesDir, 'pkg2'), { recursive: true });
  createMockPackageJson(safePath.join(packagesDir, 'pkg1'), { name: 'pkg1', version: versions.pkg1 });
  createMockPackageJson(safePath.join(packagesDir, 'pkg2'), { name: 'pkg2', version: versions.pkg2 });
}

describe('validate-version', () => {
  let tempDir: string;
  let validateVersionPath: string;

  beforeEach(() => {
    tempDir = createTestTempDir({ prefix: 'validate-version-' });
    // Resolve path relative to this test file: test/integration/ -> src/
    validateVersionPath = safePath.join(__dirname, '../../src/validate-version.ts');
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('should pass when all packages have same version', () => {
    setupPackages(tempDir, { pkg1: '0.1.0', pkg2: '0.1.0' });

    const result = safeExecSync('bunx', ['tsx', validateVersionPath, tempDir], { encoding: 'utf-8' });
    expect(result).toContain('✓ All');
    expect(result).toContain('0.1.0');
  });

  it('should fail when packages have different versions', () => {
    setupPackages(tempDir, { pkg1: '0.1.0', pkg2: '0.2.0' });

    expect(() => {
      safeExecSync('bunx', ['tsx', validateVersionPath, tempDir], { encoding: 'utf-8' });
    }).toThrow();
  });

  it('fails naming the manifest when a package.json is not JSON, rather than checking the rest', () => {
    // Two agreeing packages plus one whose manifest cannot be parsed: dropping
    // the third would report "all 2 packages agree" over a checkout with 3.
    setupPackages(tempDir, { pkg1: '0.1.0', pkg2: '0.1.0' });
    const brokenDir = safePath.join(tempDir, 'packages', 'pkg3');
    mkdirSyncReal(brokenDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own scratch dir
    writeFileSync(safePath.join(brokenDir, 'package.json'), '{ not json');

    let failure: unknown;
    try {
      safeExecSync('bunx', ['tsx', validateVersionPath, tempDir], { encoding: 'utf-8' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CommandExecutionError);
    const { stdout } = failure as CommandExecutionError;
    expect(String(stdout)).toContain('pkg3');
    expect(String(stdout)).toContain('package.json');
    expect(String(stdout)).not.toContain('✓ All');
  });
});
