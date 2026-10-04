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
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { SKILLS_LIST_REPORT_SCHEMA, type SkillsListData } from '../../src/commands/skills/list-schema.js';

import { getBinPath, getMonorepoRoot } from './test-common.js';

/** The listing's `data`, from an `ok` report the registry schema accepts. */
function listingOf(stdout: string): SkillsListData {
  const report = SKILLS_LIST_REPORT_SCHEMA.parse(yaml.parse(stdout));
  // A directory this repo's scan could not list would make the count a floor, not the answer.
  expect(report.status, stdout).toBe('ok');
  if (report.data === null) throw new Error(`skills list published no data: ${stdout}`);
  return report.data;
}

describe('skills list command (system test)', () => {
  const binPath = getBinPath(import.meta.url);

  // Shared results from beforeAll — avoids 4 redundant full-project scans
  let defaultResult: SpawnSyncReturns<string>;
  let defaultParsed: SkillsListData;
  let verboseResult: SpawnSyncReturns<string>;

  beforeAll(() => {
    // Run the default scan once (~15-20s) and share across tests
    defaultResult = spawnSync(NODE_EXECUTABLE, [binPath, 'skills', 'list'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
    defaultParsed = listingOf(defaultResult.stdout);

    // Run the verbose scan once
    verboseResult = spawnSync(NODE_EXECUTABLE, [binPath, 'skills', 'list', '--verbose'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
  }, 60_000); // Two full-project scans (~15-20s each)

  it('should show help text', () => {
    const result = spawnSync(NODE_EXECUTABLE, [binPath, 'skills', 'list', '--help'], {
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
    expect(defaultParsed).toHaveProperty('context', 'project');
    expect(Array.isArray(defaultParsed.skills)).toBe(true);

    // Should find at least the cat-agents skill
    expect(defaultParsed.skills.length).toBeGreaterThan(0);

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
    // Resolved relative to this test file (not process.cwd()) so it works whether
    // vitest is invoked from the monorepo root or from packages/cli directly.
    const catAgentsPath = safePath.join(getMonorepoRoot(import.meta.url), 'packages/vat-example-cat-agents');
    const result = spawnSync(NODE_EXECUTABLE, [binPath, 'skills', 'list', catAgentsPath], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    expect(result.status, result.stderr).toBe(0);
    const parsed = listingOf(result.stdout);
    expect(parsed.context).toBe('project');

    // Should find the skills
    expect(parsed.skills.length).toBeGreaterThan(0);
    // The skill is authored at `resources/skills/SKILL.md` — a directory leaf of
    // "skills" — but declares itself `vat-example-cat-agents`, which is also the
    // output directory `vat skills build` gives it. List reports the declared
    // name so it agrees with the build and with what install would install.
    expect(parsed.skills.some(s => s.name === 'vat-example-cat-agents')).toBe(true);
    expect(parsed.skills.some(s => s.name === 'skills')).toBe(false);
  });

  it('should exit with code 0 even with warnings', () => {
    // List command should always succeed (warnings don't fail)
    expect(defaultResult.status).toBe(0);
  });
});
