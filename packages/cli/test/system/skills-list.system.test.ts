/**
 * System tests for skills list command
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { getBinPath } from './test-common.js';

/**
 * Helper to run skills list command and parse YAML output
 */
function runListCommand(args: string[] = []): {
  result: ReturnType<typeof spawnSync>;
  parsed: Record<string, unknown>;
} {
  const binPath = getBinPath(import.meta.url);
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
  const result = spawnSync('node', [binPath, 'skills', 'list', ...args], {
    encoding: 'utf-8',
    cwd: process.cwd(),
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(result.stdout) as Record<string, unknown>;
  } catch (error) {
    // If parsing fails, log the error and return empty object
    console.error('Failed to parse YAML:', error);
    console.error('stdout:', result.stdout);
    console.error('stderr:', result.stderr);
    parsed = {};
  }
  return { result, parsed };
}

describe('skills list command (system test)', () => {
  const binPath = getBinPath(import.meta.url);

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
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'list'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    // Parse YAML output
    const parsed = yaml.load(result.stdout) as {
      status: string;
      context: string;
      skillsFound: number;
      skills: Array<{
        name: string;
        path: string;
        valid: boolean;
        warning?: string;
      }>;
    };

    expect(result.status).toBe(0);
    expect(parsed).toHaveProperty('status', 'success');
    expect(parsed).toHaveProperty('context', 'project');
    expect(parsed).toHaveProperty('skillsFound');
    expect(parsed).toHaveProperty('skills');
    expect(Array.isArray(parsed.skills)).toBe(true);

    // Should find at least the cat-agents skill
    expect(parsed.skillsFound).toBeGreaterThan(0);

    // Verify result structure
    if (parsed.skills.length > 0) {
      const firstSkill = parsed.skills[0];
      expect(firstSkill).toHaveProperty('name');
      expect(firstSkill).toHaveProperty('path');
      expect(firstSkill).toHaveProperty('valid');
      expect(typeof firstSkill.valid).toBe('boolean');
    }
  });

  it('should output YAML format', () => {
    const { result, parsed } = runListCommand();

    // Should be parseable as YAML (runListCommand already does this)
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(['project', 'user']).toContain(parsed.context);
  });

  it('should show validation warnings for non-standard filenames', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'list'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const parsed = yaml.load(result.stdout) as {
      skills: Array<{
        name: string;
        valid: boolean;
        warning?: string;
      }>;
    };

    // Check if any skills have warnings (they should all be valid in this repo)
    for (const skill of parsed.skills) {
      if (!skill.valid) {
        expect(skill.warning).toBeDefined();
        expect(typeof skill.warning).toBe('string');
      }
    }
  });

  it('should show verbose output with --verbose flag', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'list', '--verbose'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    expect(result.status).toBe(0);

    // Verbose output goes to stderr
    expect(result.stderr).toContain('Path:');
  });

  it('should list skills at specific path', () => {
    const catAgentsPath = path.join(process.cwd(), 'packages/vat-example-cat-agents');
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'list', catAgentsPath], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const parsed = yaml.load(result.stdout) as {
      status: string;
      context: string;
      skillsFound: number;
      skills: Array<{
        name: string;
      }>;
    };

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
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'list'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    expect(result.status).toBe(0);

    const parsed = yaml.load(result.stdout) as { status: string };
    expect(parsed.status).toBe('success');
  });
});
