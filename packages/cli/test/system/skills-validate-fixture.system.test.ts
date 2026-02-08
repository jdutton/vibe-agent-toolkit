/**
 * Fixture-based system tests for skills validate command
 * Uses committed test fixture instead of scanning entire project directory
 * Fast and deterministic on all platforms including Windows
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { getBinPath } from './test-common.js';
import { executeSkillsCommandAndExpectYaml } from './test-helpers.js';

describe('skills validate command - fixture tests (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  // Use committed fixture instead of creating files at runtime (faster on Windows)
  const fixtureDir = path.join(process.cwd(), 'packages/cli/test/fixtures/skills-minimal');

  it('should validate skills in fixture directory', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate', fixtureDir], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const parsed = yaml.load(result.stdout) as {
      status: string;
      skillsValidated: number;
      results: Array<{
        skill: string;
        status: string;
        resourceValidation: { status: string };
        skillValidation: { status: string };
      }>;
    };

    expect(parsed.status).toBe('success');
    expect(parsed.skillsValidated).toBe(2);
    expect(parsed.results).toHaveLength(2);

    // All skills should be valid
    for (const skillResult of parsed.results) {
      expect(skillResult.status).toBe('success');
      expect(skillResult.resourceValidation.status).toBe('success');
      expect(skillResult.skillValidation.status).toBe('success');
    }
  });

  it('should output YAML format for fixture validation', () => {
    const { result, parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should validate with exit code 0 when all valid', () => {
    const { result, parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });
});
