/**
 * System tests for skills validate command
 */

import { spawnSync } from 'node:child_process';

import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { getBinPath, getFixturePath } from './test-common.js';
import { executeSkillsCommandAndExpectYaml } from './test-helpers.js';

// Type for packaging validation result
interface PackagingValidationOutput {
  status: string;
  skillsValidated: number;
  results: Array<{
    skillName: string;
    status: string;
    allErrors: Array<unknown>;
    activeErrors: Array<unknown>;
    ignoredErrors: Array<unknown>;
    metadata: {
      skillLines: number;
      totalLines: number;
      fileCount: number;
      directFileCount: number;
      maxLinkDepth: number;
      excludedReferenceCount: number;
      excludedReferences?: Array<{
        path: string;
        reason: string;
        matchedPattern?: string;
      }>;
    };
  }>;
  durationSecs: number;
}

describe('skills validate command (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  // Use fixture with package.json that has vat.skills
  const fixtureDir = getFixturePath(import.meta.url, 'skills-minimal');

  it('should show help text', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate', '--help'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Validate skills for packaging');
    expect(result.stdout).toContain('Validation Checks:');
    expect(result.stdout).toContain('Required (non-overridable):');
    expect(result.stdout).toContain('Best practices (overridable):');
    expect(result.stdout).toContain('Validation Overrides:');
    expect(result.stdout).toContain('Exit Codes:');
  });

  it('should validate skills and report packaging validation results', () => {
    const { result, parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    expect(result.status).toBe(0);

    const typedParsed = parsed as unknown as PackagingValidationOutput;

    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('skillsValidated');
    expect(parsed).toHaveProperty('results');
    expect(parsed).toHaveProperty('durationSecs');
    expect(Array.isArray(typedParsed.results)).toBe(true);

    // Should find skills in fixture
    expect(typedParsed.skillsValidated).toBeGreaterThan(0);

    // Verify result structure
    if (typedParsed.results.length > 0) {
      const firstResult = typedParsed.results[0];
      expect(firstResult).toHaveProperty('skillName');
      expect(firstResult).toHaveProperty('status');
      expect(firstResult).toHaveProperty('activeErrors');
      expect(firstResult).toHaveProperty('metadata');
      expect(firstResult.metadata).toHaveProperty('skillLines');
      expect(firstResult.metadata).toHaveProperty('totalLines');
    }
  });

  it('should output YAML format', () => {
    const { result, parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    // Should be parseable as YAML
    expect(result.status).toBeDefined();
    expect(parsed.status).toBeDefined();
    expect(['success', 'error']).toContain(parsed.status);
  });

  it('should exit with proper status code', () => {
    // Note: Fixture may have validation errors, that's fine for testing structure
    const { parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    expect(parsed.status).toBeDefined();
    expect(['success', 'error']).toContain(parsed.status);
  });

  it('should report validation errors with proper structure', () => {
    const { parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    const typedParsed = parsed as unknown as PackagingValidationOutput;

    if (typedParsed.results.length > 0) {
      const skillResult = typedParsed.results[0];

      // Verify packaging validation structure
      expect(skillResult).toHaveProperty('skillName');
      expect(skillResult).toHaveProperty('allErrors');
      expect(skillResult).toHaveProperty('activeErrors');
      expect(skillResult).toHaveProperty('ignoredErrors');
      expect(skillResult).toHaveProperty('metadata');

      // Verify metadata structure (including new fields)
      expect(skillResult.metadata).toHaveProperty('skillLines');
      expect(skillResult.metadata).toHaveProperty('totalLines');
      expect(skillResult.metadata).toHaveProperty('fileCount');
      expect(skillResult.metadata).toHaveProperty('directFileCount');
      expect(skillResult.metadata).toHaveProperty('maxLinkDepth');
      expect(skillResult.metadata).toHaveProperty('excludedReferenceCount');
    }
  });

  it('should NOT include excludedReferences in default (non-verbose) output', () => {
    const { parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    const typedParsed = parsed as unknown as PackagingValidationOutput;

    // In non-verbose mode, excludedReferences should be stripped from metadata
    for (const result of typedParsed.results) {
      expect(result.metadata).not.toHaveProperty('excludedReferences');
      // But excludedReferenceCount should still be present
      expect(result.metadata).toHaveProperty('excludedReferenceCount');
    }
  });

  it('should include excludedReferences in verbose output', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate', fixtureDir, '--verbose'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const parsed = yaml.load(result.stdout) as PackagingValidationOutput;

    // In verbose mode, excludedReferences should be present in metadata
    for (const skillResult of parsed.results) {
      expect(skillResult.metadata).toHaveProperty('excludedReferences');
      expect(Array.isArray(skillResult.metadata.excludedReferences)).toBe(true);
    }
  });
});
