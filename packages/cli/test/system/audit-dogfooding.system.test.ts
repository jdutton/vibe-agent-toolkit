/**
 * Task 7: Dogfooding System Tests
 *
 * Tests that audit command can successfully audit the vibe-agent-toolkit project itself.
 * This is "dogfooding" - using the tool on the project that builds it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCli,
  getBinPath,
} from './test-common.js';

/**
 * Helper to validate audit result expectations
 */
function expectSuccessfulAudit(result: ReturnType<typeof executeCli>): void {
  // Should succeed (exit 0) or fail gracefully
  expect([0, 1]).toContain(result.status);

  // Should produce structured output
  expect(result.stdout).toBeTruthy();

  // Should not crash with unhandled errors
  if (result.status === 2) {
    throw new Error(`Unexpected error: ${result.stderr}`);
  }
}

describe('Audit Dogfooding (system test)', () => {
  let binPath: string;
  let projectRoot: string;
  let tempDir: string;

  beforeAll(() => {
    binPath = getBinPath(import.meta.url);
    // Get project root (4 levels up from test/system/)
    projectRoot = new URL('../../../../', import.meta.url).pathname;
    tempDir = createTestTempDir('vat-audit-dogfood-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('should successfully audit vibe-agent-toolkit project root', () => {
    const result = executeCli(binPath, ['audit', projectRoot], {
      cwd: tempDir,
    });

    expectSuccessfulAudit(result);
  });

  it('should audit project with --recursive flag', () => {
    const result = executeCli(binPath, ['audit', projectRoot, '--recursive'], {
      cwd: tempDir,
    });

    expectSuccessfulAudit(result);
  });
});
