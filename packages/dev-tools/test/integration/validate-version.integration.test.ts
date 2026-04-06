 
// Test file - paths are controlled by test code, not user input

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
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
});
