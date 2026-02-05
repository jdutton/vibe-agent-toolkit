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
});
