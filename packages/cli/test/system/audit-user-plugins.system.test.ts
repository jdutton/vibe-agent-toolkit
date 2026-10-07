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

import { AUDIT_REPORT_SCHEMA } from '../../src/commands/audit-schema.js';

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
    fixtureDir = getTestFixturesPath();
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

      // Exit 1: this tree has an error-severity finding.
      expect(status).toBe(1);

      // The report envelope, parsed by the verb's registered schema.
      const report = AUDIT_REPORT_SCHEMA.parse(parseYamlOutput(stdout));
      expect(report.status).toBe('findings');
      // A directory audit, not `--user`: no hierarchy.
      expect(report.data.hierarchical).toBeNull();

      // Should have scanned files
      expect(report.examined).toBeGreaterThan(0);

      // Should have some errors (fixture contains skills with validation issues)
      expect(report.data.counts.filesWithErrors).toBeGreaterThan(0);

      // Should have some successes too
      expect(report.data.counts.filesPassed).toBeGreaterThan(0);
    });

    it('should validate singleton marketplace (anthropic-agent-skills)', () => {
      // Recursive is the default — no flag needed
      const { stdout, status } = executeCli(binPath, [
        'audit',
        safePath.join(fixtureDir, 'marketplaces/anthropic-agent-skills'),
      ]);

      // Marketplace validation now works — should succeed
      expect(status).toBe(0);

      const report = AUDIT_REPORT_SCHEMA.parse(parseYamlOutput(stdout));
      // Nothing at error severity; any info or warning finding is still `findings`.
      expect(report.summary.errors).toBe(0);
      expect(report.examined).toBeGreaterThan(0);
      expect(report.data.counts.filesPassed).toBeGreaterThan(0);
    });

    it('should validate standard marketplace (claude-plugins-official)', () => {
      // Recursive is the default — no flag needed
      const { stdout, status } = executeCli(binPath, [
        'audit',
        safePath.join(fixtureDir, 'marketplaces/claude-plugins-official'),
      ]);

      // Exit 1: this tree has an error-severity finding.
      expect(status).toBe(1);

      const report = AUDIT_REPORT_SCHEMA.parse(parseYamlOutput(stdout));

      // Should have scanned at least the marketplace manifest
      expect(report.examined).toBeGreaterThan(0);
      expect(report.data.counts.filesPassed).toBeGreaterThan(0);
    });

    it('should validate cached plugins', () => {
      // Recursive is the default — no flag needed
      const { stdout } = executeCli(binPath, [
        'audit',
        safePath.join(fixtureDir, 'cache'),
      ]);

      // Should have scanned skills from cache
      expect(AUDIT_REPORT_SCHEMA.parse(parseYamlOutput(stdout)).examined).toBeGreaterThan(0);
    });
  });

  describe('Summary statistics', () => {
    it('should provide accurate file counts and scan statistics', () => {
      // Recursive is the default — no flag needed
      const { stdout } = executeCli(binPath, [
        'audit',
        fixtureDir,
      ]);

      const report = AUDIT_REPORT_SCHEMA.parse(parseYamlOutput(stdout));
      const { filesPassed, filesWithWarnings, filesWithErrors, pathsUnreadable } = report.data.counts;

      // Should report files scanned
      expect(report.examined).toBeGreaterThan(0);

      // Sanity check: passed + warnings + errors equals the files read, and
      // every row is a file read or a refused path.
      expect(report.examined).toBe(filesPassed + filesWithWarnings + filesWithErrors);
      expect(report.data.files).toHaveLength(report.examined + pathsUnreadable);
    });
  });
});
