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


import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  getBinPath,
} from './test-common.js';
import { getTestFixturesPath } from './test-fixture-loader.js';
import { executeCli, parseYamlOutput } from './test-helpers/index.js';

describe('Audit User Plugins Fixture (system test)', () => {
  let binPath: string;
  let tempDir: string;
  let fixtureDir: string;

  beforeAll(async () => {
    binPath = getBinPath(import.meta.url);
    tempDir = createTestTempDir('vat-audit-user-plugins-');
    // Extract test fixtures from tarball (cross-platform)
    // NOTE: ZIP extraction is slower on Windows, increase timeout
    fixtureDir = await getTestFixturesPath();
  }, 30000); // 30 second timeout for fixture extraction on Windows

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  describe('Real-world fixture validation', () => {
    it('should scan entire fixture directory recursively', () => {
      // Recursive is the default — no flag needed
      const { stdout, status } = executeCli(binPath, [
        'audit',
        fixtureDir,
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
      // Recursive is the default — no flag needed
      const { stdout, status } = executeCli(binPath, [
        'audit',
        safePath.join(fixtureDir, 'marketplaces/anthropic-agent-skills'),
      ]);

      // Marketplace validation now works — should succeed
      expect(status).toBe(0);

      const output = parseYamlOutput(stdout);
      expect(output.status).toBe('success');

      const summary = output.summary as {
        filesScanned: number;
        success: number;
      };

      expect(summary.filesScanned).toBeGreaterThan(0);
      expect(summary.success).toBeGreaterThan(0);
    });

    it('should validate standard marketplace (claude-plugins-official)', () => {
      // Recursive is the default — no flag needed
      const { stdout, status } = executeCli(binPath, [
        'audit',
        safePath.join(fixtureDir, 'marketplaces/claude-plugins-official'),
      ]);

      // Marketplace validation now works — should succeed
      expect(status).toBe(0);

      const output = parseYamlOutput(stdout);

      // Should have scanned at least the marketplace manifest
      const summary = output.summary as {
        filesScanned: number;
        success: number;
      };

      expect(summary.filesScanned).toBeGreaterThan(0);
      expect(summary.success).toBeGreaterThan(0);
    });

    it('should validate cached plugins', () => {
      // Recursive is the default — no flag needed
      const { stdout } = executeCli(binPath, [
        'audit',
        safePath.join(fixtureDir, 'cache'),
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
      // Recursive is the default — no flag needed
      const { stdout } = executeCli(binPath, [
        'audit',
        fixtureDir,
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
