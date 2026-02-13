/**
 * Fixture-based system tests for skills list command
 * Uses committed test fixture instead of scanning entire project directory
 * Fast and deterministic on all platforms including Windows
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { getBinPath } from './test-common.js';
import { executeSkillsCommandAndExpectYaml } from './test-helpers/index.js';

describe('skills list command - fixture tests (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  // Use committed fixture instead of creating files at runtime (faster on Windows)
  const fixtureDir = path.join(process.cwd(), 'packages/cli/test/fixtures/skills-minimal');

  it('should list skills in fixture directory', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'list', fixtureDir], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const parsed = yaml.load(result.stdout) as {
      status: string;
      context: string;
      skillsFound: number;
      skills: Array<{ name: string; valid: boolean }>;
    };

    expect(parsed.status).toBe('success');
    expect(parsed.context).toBe('project');
    expect(parsed.skillsFound).toBe(2);
    expect(parsed.skills).toHaveLength(2);

    // All skills should be valid
    for (const skill of parsed.skills) {
      expect(skill.valid).toBe(true);
    }
  });

  it('should output YAML format for fixture', () => {
    const { result, parsed } = executeSkillsCommandAndExpectYaml(binPath, 'list', fixtureDir);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.context).toBe('project');
  });
});
