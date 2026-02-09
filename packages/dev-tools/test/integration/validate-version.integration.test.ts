 
// Test file - paths are controlled by test code, not user input

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, safeExecSync } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createTestTempDir, cleanupTestTempDir, createMockPackageJson } from '../test-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('validate-version', () => {
  let tempDir: string;
  let validateVersionPath: string;

  beforeEach(() => {
    tempDir = createTestTempDir({ prefix: 'validate-version-' });
    // Resolve path relative to this test file: test/integration/ -> src/
    validateVersionPath = join(__dirname, '../../src/validate-version.ts');
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  function setupPackages(versions: { pkg1: string; pkg2: string }): void {
    const packagesDir = join(tempDir, 'packages');
    mkdirSyncReal(packagesDir, { recursive: true });
    mkdirSyncReal(join(packagesDir, 'pkg1'), { recursive: true });
    mkdirSyncReal(join(packagesDir, 'pkg2'), { recursive: true });
    createMockPackageJson(join(packagesDir, 'pkg1'), { name: 'pkg1', version: versions.pkg1 });
    createMockPackageJson(join(packagesDir, 'pkg2'), { name: 'pkg2', version: versions.pkg2 });
  }

  it('should pass when all packages have same version', () => {
    setupPackages({ pkg1: '0.1.0', pkg2: '0.1.0' });

    const result = safeExecSync('bunx', ['tsx', validateVersionPath, tempDir], { encoding: 'utf-8' });
    expect(result).toContain('✓ All');
    expect(result).toContain('0.1.0');
  });

  it('should fail when packages have different versions', () => {
    setupPackages({ pkg1: '0.1.0', pkg2: '0.2.0' });

    expect(() => {
      safeExecSync('bunx', ['tsx', validateVersionPath, tempDir], { encoding: 'utf-8' });
    }).toThrow();
  });
});
