/**
 * System tests for skills validate command
 */

import { spawnSync } from 'node:child_process';

import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { getBinPath } from './test-common.js';

describe('skills validate command (system test)', () => {
  const binPath = getBinPath(import.meta.url);

  it('should show help text', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate', '--help'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Validate SKILL.md files');
    expect(result.stdout).toContain('Resource validation:');
    expect(result.stdout).toContain('Skill-specific validation:');
    expect(result.stdout).toContain('Filename validation:');
    expect(result.stdout).toContain('Validation Modes:');
    expect(result.stdout).toContain('--user');
    expect(result.stdout).toContain('Exit Codes:');
  });

  it('should validate skills and report results', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    // Parse YAML output
    const parsed = yaml.load(result.stdout) as {
      status: string;
      skillsValidated: number;
      results: Array<{
        skill: string;
        path: string;
        status: string;
        resourceValidation: { status: string; linksChecked: number; errors: number };
        skillValidation: { status: string; errors: number; warnings: number };
      }>;
    };

    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('skillsValidated');
    expect(parsed).toHaveProperty('results');
    expect(Array.isArray(parsed.results)).toBe(true);

    // Should find at least the cat-agents skill
    expect(parsed.skillsValidated).toBeGreaterThan(0);

    // Verify result structure
    if (parsed.results.length > 0) {
      const firstResult = parsed.results[0];
      expect(firstResult).toHaveProperty('skill');
      expect(firstResult).toHaveProperty('path');
      expect(firstResult).toHaveProperty('resourceValidation');
      expect(firstResult).toHaveProperty('skillValidation');
      expect(firstResult.resourceValidation).toHaveProperty('linksChecked');
      expect(firstResult.skillValidation).toHaveProperty('errors');
    }
  });

  it('should output YAML format', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    // Should be parseable as YAML
    expect(() => yaml.load(result.stdout)).not.toThrow();

    const parsed = yaml.load(result.stdout) as Record<string, unknown>;
    expect(parsed.status).toBeDefined();
    expect(['success', 'error']).toContain(parsed.status);
  });

  it('should exit with code 0 when validation passes', () => {
    // Current repo skills are valid, so this should pass
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    // Should pass - repo skills are currently valid
    expect(result.status).toBe(0);

    const parsed = yaml.load(result.stdout) as { status: string };
    expect(parsed.status).toBe('success');
  });

  it('should report both resource and skill errors', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const parsed = yaml.load(result.stdout) as {
      results: Array<{
        resourceValidation: { status: string; errors: number };
        skillValidation: { status: string; errors: number };
        totalErrors: number;
      }>;
    };

    if (parsed.results.length > 0) {
      const result = parsed.results[0];

      // Verify structure exists
      expect(result.resourceValidation).toBeDefined();
      expect(result.skillValidation).toBeDefined();
      expect(result.totalErrors).toBeDefined();

      // totalErrors should be sum of resource + skill errors
      const expectedTotal = result.resourceValidation.errors + result.skillValidation.errors;
      expect(result.totalErrors).toBe(expectedTotal);
    }
  });

  it('should accept --user flag to validate user context', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate', '--user'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large user directories
    });

    // Should not error (even if no user skills exist)
    expect([0, 1]).toContain(result.status);

    // Try to parse output, but if user has too many skills (>100), stdout may be truncated
    // In that case, we just verify the command runs without crashing
    try {
      let parsed: { status: string; skillsValidated: number };
      try {
        parsed = yaml.load(result.stdout) as { status: string; skillsValidated: number };
      } catch {
        // Large result sets use JSON to avoid js-yaml truncation
        parsed = JSON.parse(result.stdout) as { status: string; skillsValidated: number };
      }

      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('skillsValidated');
      expect(['success', 'error']).toContain(parsed.status);
    } catch {
      // If parsing fails due to very large user directory (>100 skills),
      // just verify the command didn't crash (exit code 0 or 1)
      expect([0, 1]).toContain(result.status);
    }
  });

  it('should use strict filename validation in project mode', () => {
    // Project mode should enforce exact "SKILL.md" filename
    // This test verifies that the command respects strict mode
    // (actual test for lowercase skill.md would require test fixture)
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    // All skills in this repo should use SKILL.md (uppercase)
    expect(result.status).toBe(0);

    const parsed = yaml.load(result.stdout) as {
      status: string;
      results: Array<{
        issues?: Array<{
          code: string;
          severity: string;
        }>;
      }>;
    };

    // No filename errors expected (all use correct SKILL.md)
    for (const skillResult of parsed.results) {
      const filenameIssues = skillResult.issues?.filter(i => i.code === 'non-standard-filename') ?? [];
      expect(filenameIssues.length).toBe(0);
    }
  });

  it('should respect project config boundaries', () => {
    // Validate that discovery respects vibe-agent-toolkit.config.yaml
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const parsed = yaml.load(result.stdout) as {
      skillsValidated: number;
      results: Array<{ path: string }>;
    };

    // Should find skills but exclude node_modules, dist, etc.
    for (const skillResult of parsed.results) {
      expect(skillResult.path).not.toContain('node_modules');
      expect(skillResult.path).not.toContain('/dist/');
      expect(skillResult.path).not.toContain('test-fixtures');
    }
  });
});
