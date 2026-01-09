/**
 * System tests for audit command with real user plugin fixture
 *
 * Tests against a snapshot of actual user ~/.claude/plugins directory.
 * These tests verify the audit command can handle real-world plugin structures,
 * including singleton marketplaces, standard marketplaces, and cached plugins.
 *
 * Note: These tests use flat output mode (standard audit), not hierarchical output.
 * Hierarchical output is only enabled with --user flag which targets ~/.claude/plugins.
 *
 * Test fixtures are stored as a compressed tarball and extracted on-demand to avoid
 * SonarQube analyzing third-party code as production code.
 */

import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCli,
  getBinPath,
} from './test-common.js';
import { getTestFixturesPath } from './test-fixture-loader.js';
import { parseYamlOutput } from './test-helpers.js';

describe('Audit User Plugins Fixture (system test)', () => {
  let binPath: string;
  let tempDir: string;
  let fixtureDir: string;

  // Constants
  const RECURSIVE_FLAG = '--recursive';

  beforeAll(async () => {
    binPath = getBinPath(import.meta.url);
    tempDir = createTestTempDir('vat-audit-user-plugins-');
    // Extract test fixtures from tarball (cross-platform)
    fixtureDir = await getTestFixturesPath();
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  describe('Real-world fixture validation', () => {
    it('should scan entire fixture directory recursively', () => {
      const { stdout, status } = executeCli(binPath, [
        'audit',
        fixtureDir,
        RECURSIVE_FLAG,
      ]);

      // Fixture contains validation errors, should exit with error code
      expect(status).toBe(1);

      // Parse YAML output
      const output = parseYamlOutput(stdout);

      // Verify flat output structure (not hierarchical)
      expect(output).toHaveProperty('status');
      expect(output).toHaveProperty('summary');
      expect(output).toHaveProperty('issues');
      expect(output).toHaveProperty('duration');
      expect(output).toHaveProperty('files');

      const summary = output.summary as {
        filesScanned: number;
        success: number;
        warnings: number;
        errors: number;
      };

      // Should have scanned files
      expect(summary.filesScanned).toBeGreaterThan(0);

      // Should have some errors (fixture contains skills with validation issues)
      expect(summary.errors).toBeGreaterThan(0);

      // Should have some successes too
      expect(summary.success).toBeGreaterThan(0);
    });

    it('should validate singleton marketplace (anthropic-agent-skills)', () => {
      const { stdout, status } = executeCli(binPath, [
        'audit',
        join(fixtureDir, 'marketplaces/anthropic-agent-skills'),
        RECURSIVE_FLAG,
      ]);

      // anthropic-agent-skills has all valid skills, should succeed
      expect(status).toBe(0);

      const output = parseYamlOutput(stdout);
      expect(output.status).toBe('success');

      const summary = output.summary as {
        filesScanned: number;
        success: number;
        errors: number;
      };

      // All skills should be successful
      expect(summary.success).toBeGreaterThan(0);
      expect(summary.errors).toBe(0);
    });

    it('should validate standard marketplace (claude-plugins-official)', () => {
      const { stdout, status } = executeCli(binPath, [
        'audit',
        join(fixtureDir, 'marketplaces/claude-plugins-official'),
        RECURSIVE_FLAG,
      ]);

      // Should complete scan successfully (exit 0)
      expect(status).toBe(0);

      const output = parseYamlOutput(stdout);

      // Should have scanned at least the marketplace manifest
      const summary = output.summary as {
        filesScanned: number;
      };

      expect(summary.filesScanned).toBeGreaterThan(0);
    });

    it('should validate cached plugins', () => {
      const { stdout } = executeCli(binPath, [
        'audit',
        join(fixtureDir, 'cache'),
        RECURSIVE_FLAG,
      ]);

      const output = parseYamlOutput(stdout);

      const summary = output.summary as {
        filesScanned: number;
      };

      // Should have scanned skills from cache
      expect(summary.filesScanned).toBeGreaterThan(0);
    });
  });

  describe('Summary statistics', () => {
    it('should provide accurate file counts and scan statistics', () => {
      const { stdout } = executeCli(binPath, [
        'audit',
        fixtureDir,
        RECURSIVE_FLAG,
      ]);

      const output = parseYamlOutput(stdout);

      const summary = output.summary as {
        filesScanned: number;
        success: number;
        warnings: number;
        errors: number;
      };

      // Should report files scanned
      expect(summary.filesScanned).toBeGreaterThan(0);

      // Sanity check: success + warnings + errors should equal filesScanned
      expect(summary.filesScanned).toBe(
        summary.success + summary.warnings + summary.errors
      );
    });
  });
});
