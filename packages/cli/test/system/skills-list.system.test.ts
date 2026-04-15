/**
 * System tests for skills list command
 *
 * These tests dogfood the real project scan (scanning the monorepo from cwd).
 * To avoid redundant ~15s scans, the default and verbose commands are each run
 * once in beforeAll and shared across assertions.
 *
 * For fast, deterministic, fixture-based tests see skills-list-fixture.system.test.ts.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';

import { getBinPath } from './test-common.js';

interface SkillEntry {
  name: string;
  path: string;
  valid: boolean;
  warning?: string;
}

interface SkillsListOutput {
  status: string;
  context: string;
  skillsFound: number;
  skills: SkillEntry[];
}

describe('skills list command (system test)', () => {
  const binPath = getBinPath(import.meta.url);

  // Shared results from beforeAll — avoids 4 redundant full-project scans
  let defaultResult: SpawnSyncReturns<string>;
  let defaultParsed: SkillsListOutput;
  let verboseResult: SpawnSyncReturns<string>;

  beforeAll(() => {
    // Run the default scan once (~15-20s) and share across tests
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    defaultResult = spawnSync('node', [binPath, 'skills', 'list'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
    defaultParsed = yaml.load(defaultResult.stdout) as SkillsListOutput;

    // Run the verbose scan once
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    verboseResult = spawnSync('node', [binPath, 'skills', 'list', '--verbose'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
  }, 60_000); // Two full-project scans (~15-20s each)

  it('should show help text', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'list', '--help'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('List skills in project or user installation');
    expect(result.stdout).toContain('--user');
    expect(result.stdout).toContain('Project mode');
    expect(result.stdout).toContain('User mode');
    expect(result.stdout).toContain('Validation Status:');
    expect(result.stdout).toContain('Exit Codes:');
  });

  it('should list project skills by default', () => {
    expect(defaultResult.status).toBe(0);
    expect(defaultParsed).toHaveProperty('status', 'success');
    expect(defaultParsed).toHaveProperty('context', 'project');
    expect(defaultParsed).toHaveProperty('skillsFound');
    expect(defaultParsed).toHaveProperty('skills');
    expect(Array.isArray(defaultParsed.skills)).toBe(true);

    // Should find at least the cat-agents skill
    expect(defaultParsed.skillsFound).toBeGreaterThan(0);

    // Verify result structure
    if (defaultParsed.skills.length > 0) {
      const firstSkill = defaultParsed.skills[0];
      expect(firstSkill).toHaveProperty('name');
      expect(firstSkill).toHaveProperty('path');
      expect(firstSkill).toHaveProperty('valid');
      expect(typeof firstSkill.valid).toBe('boolean');
    }
  });

  it('should output YAML format', () => {
    expect(defaultResult.status).toBe(0);
    expect(defaultParsed.status).toBe('success');
    expect(['project', 'user']).toContain(defaultParsed.context);
  });

  it('should show validation warnings for non-standard filenames', () => {
    // Check if any skills have warnings (they should all be valid in this repo)
    for (const skill of defaultParsed.skills) {
      if (!skill.valid) {
        expect(skill.warning).toBeDefined();
        expect(typeof skill.warning).toBe('string');
      }
    }
  });

  it('should show verbose output with --verbose flag', () => {
    expect(verboseResult.status).toBe(0);

    // Verbose output goes to stderr
    expect(verboseResult.stderr).toContain('Path:');
  });

  it('should list skills at specific path', () => {
    const catAgentsPath = safePath.join(process.cwd(), 'packages/vat-example-cat-agents');
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'list', catAgentsPath], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const parsed = yaml.load(result.stdout) as SkillsListOutput;

    // Debug output if test fails
    if (result.status !== 0) {
      console.log('stdout:', result.stdout);
      console.log('stderr:', result.stderr);
    }

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.context).toBe('project');

    // Should find the skills
    expect(parsed.skillsFound).toBeGreaterThan(0);
    // The skill directory is named "skills", not "cat"
    expect(parsed.skills.some(s => s.name === 'skills')).toBe(true);
  });

  it('should exit with code 0 even with warnings', () => {
    // List command should always succeed (warnings don't fail)
    expect(defaultResult.status).toBe(0);
    expect(defaultParsed.status).toBe('success');
  });
});
