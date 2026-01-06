import * as os from 'node:os';

import type { ValidationResult } from '@vibe-agent-toolkit/runtime-claude-skills';
import { describe, expect, it } from 'vitest';

import { buildHierarchicalOutput } from '../../../src/commands/audit/hierarchical-output.js';

// Constants for test data
const RESOURCE_TYPE_SKILL = 'claude-skill';
const SEVERITY_ERROR = 'error';
const SEVERITY_WARNING = 'warning';
const TEST_ERROR_CODE = 'TEST_ERROR';
const TEST_ERROR_MESSAGE = 'Test error';
const TEST_WARNING_CODE = 'TEST_WARNING';

// Helper to create test validation result
function createTestResult(path: string, status: 'error' | 'warning', issueCode: string, issueMessage: string): ValidationResult {
  return {
    path,
    status,
    resourceType: RESOURCE_TYPE_SKILL,
    issues: [{ code: issueCode, message: issueMessage, severity: status === 'error' ? SEVERITY_ERROR : SEVERITY_WARNING }],
  };
}

describe('buildHierarchicalOutput', () => {
  const homeDir = os.homedir();

  it('should group results by marketplace -> plugin -> skill hierarchy', () => {
    const results: ValidationResult[] = [
      createTestResult(
        `${homeDir}/.claude/plugins/marketplaces/marketplace1/plugin1/skills/skill1/SKILL.md`,
        'error',
        TEST_ERROR_CODE,
        TEST_ERROR_MESSAGE
      ),
      createTestResult(
        `${homeDir}/.claude/plugins/marketplaces/marketplace1/plugin1/skills/skill2/SKILL.md`,
        'warning',
        TEST_WARNING_CODE,
        'Test warning 2'
      ),
      createTestResult(
        `${homeDir}/.claude/plugins/marketplaces/marketplace1/plugin2/skills/skill3/SKILL.md`,
        'warning',
        TEST_WARNING_CODE,
        'Test warning'
      ),
    ];

    const output = buildHierarchicalOutput(results);

    expect(output.marketplaces).toHaveLength(1);
    expect(output.marketplaces[0]?.name).toBe('marketplace1');
    expect(output.marketplaces[0]?.plugins).toHaveLength(2);

    const plugin1 = output.marketplaces[0]?.plugins[0];
    expect(plugin1?.name).toBe('plugin1');
    expect(plugin1?.skills).toHaveLength(2);
    expect(plugin1?.skills[0]?.name).toBe('skill1');
    expect(plugin1?.skills[0]?.status).toBe('error');
    expect(plugin1?.skills[1]?.name).toBe('skill2');
    expect(plugin1?.skills[1]?.status).toBe('warning');

    const plugin2 = output.marketplaces[0]?.plugins[1];
    expect(plugin2?.name).toBe('plugin2');
    expect(plugin2?.skills).toHaveLength(1);
    expect(plugin2?.skills[0]?.name).toBe('skill3');
    expect(plugin2?.skills[0]?.status).toBe('warning');
  });

  it('should handle standalone plugins (no marketplace)', () => {
    const results: ValidationResult[] = [
      createTestResult(
        `${homeDir}/.claude/plugins/standalone-plugin/skills/skill1/SKILL.md`,
        'error',
        TEST_ERROR_CODE,
        TEST_ERROR_MESSAGE
      ),
    ];

    const output = buildHierarchicalOutput(results);

    expect(output.standalonePlugins).toHaveLength(1);
    expect(output.standalonePlugins[0]?.name).toBe('standalone-plugin');
    expect(output.standalonePlugins[0]?.skills).toHaveLength(1);
    expect(output.standalonePlugins[0]?.skills[0]?.name).toBe('skill1');
  });

  it('should handle standalone skills (no plugin)', () => {
    const results: ValidationResult[] = [
      {
        path: `${homeDir}/.claude/plugins/standalone-skill/SKILL.md`,
        status: 'warning',
        resourceType: RESOURCE_TYPE_SKILL,
        issues: [{ code: TEST_WARNING_CODE, message: 'Test warning', severity: SEVERITY_WARNING }],
      },
    ];

    const output = buildHierarchicalOutput(results);

    expect(output.standaloneSkills).toHaveLength(1);
    expect(output.standaloneSkills[0]?.name).toBe('standalone-skill');
    expect(output.standaloneSkills[0]?.status).toBe('warning');
  });

  it('should use ~ for home directory paths', () => {
    const results: ValidationResult[] = [
      createTestResult(
        `${homeDir}/.claude/plugins/marketplaces/marketplace1/plugin1/skills/skill1/SKILL.md`,
        'error',
        TEST_ERROR_CODE,
        TEST_ERROR_MESSAGE
      ),
    ];

    const output = buildHierarchicalOutput(results);

    const skill = output.marketplaces[0]?.plugins[0]?.skills[0];
    expect(skill?.path).toBe('~/.claude/plugins/marketplaces/marketplace1/plugin1/skills/skill1/SKILL.md');
  });
});
