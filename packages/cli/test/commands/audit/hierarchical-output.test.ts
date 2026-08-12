import * as os from 'node:os';

import { countBySeverity, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import type { ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { describe, expect, it } from 'vitest';

import { buildHierarchicalOutput } from '../../../src/commands/audit/hierarchical-output.js';

// Constants for test data
const RESOURCE_TYPE_SKILL = 'agent-skill';
const SEVERITY_ERROR = 'error';
const SEVERITY_WARNING = 'warning';
const TEST_ERROR_CODE = 'TEST_ERROR';
const TEST_ERROR_MESSAGE = 'Test error';
const TEST_WARNING_CODE = 'TEST_WARNING';
const TEST_WARNING_MESSAGE = 'Test warning';
const SEVERITY_INFO = 'info';
const TEST_INFO_CODE = 'TEST_INFO';
const TEST_INFO_MESSAGE = 'Test info';
const SHARED_SKILL_NAME = 'shared-name';

/**
 * Build a one-issue result.
 *
 * `severity` is a SEPARATE parameter from `status` on purpose. This factory used
 * to take `status: 'error' | 'warning'` and derive the issue severity from it,
 * which made an info-only result — status `success`, one `info` issue —
 * structurally inexpressible. That is exactly the case `hierarchical-output`
 * drops on the floor, so a fixture that cannot build it cannot catch it.
 */
function createTestResult(
  path: string,
  status: ValidationResult['status'],
  issueCode: string,
  issueMessage: string,
  severity: 'error' | 'warning' | 'info' = status === 'error' ? SEVERITY_ERROR : SEVERITY_WARNING,
): ValidationResult {
  const issues = [{ code: issueCode, message: issueMessage, severity }] as unknown as ValidationIssue[];
  return {
    path,
    status,
    resourceType: RESOURCE_TYPE_SKILL,
    issues,
    issueCounts: countBySeverity(issues),
  } as unknown as ValidationResult;
}

/** A result with NO findings at all — the only thing a terse report may drop. */
function createCleanResult(path: string): ValidationResult {
  return {
    path,
    status: 'success',
    resourceType: RESOURCE_TYPE_SKILL,
    issues: [],
    issueCounts: countBySeverity([]),
  } as unknown as ValidationResult;
}

/** A one-error result — the shape most of the cache/grouping cases need. */
function createErrorResult(path: string): ValidationResult {
  return createTestResult(path, 'error', TEST_ERROR_CODE, TEST_ERROR_MESSAGE);
}

const homeDir = os.homedir();
// The run root a `--user` audit states once: paths below it are relative to it.
const runRoot = `${homeDir}/.claude`;
const CACHE_VERSION = '1.2.3';

/** Claude Code's real installed layout, with its extra `plugins/` segment. */
function marketplaceSkillPath(marketplace: string, plugin: string, skill: string): string {
  return `${runRoot}/plugins/marketplaces/${marketplace}/plugins/${plugin}/skills/${skill}/SKILL.md`;
}

/** Claude Code's cache layout, which interposes a version directory. */
function cachedSkillPath(marketplace: string, plugin: string, skill: string, version = CACHE_VERSION): string {
  return `${runRoot}/plugins/cache/${marketplace}/${plugin}/${version}/skills/${skill}/SKILL.md`;
}

describe('buildHierarchicalOutput', () => {

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
        TEST_WARNING_MESSAGE
      ),
    ];

    const output = buildHierarchicalOutput(results, false, runRoot);

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

    const output = buildHierarchicalOutput(results, false, runRoot);

    expect(output.standalonePlugins).toHaveLength(1);
    expect(output.standalonePlugins[0]?.name).toBe('standalone-plugin');
    expect(output.standalonePlugins[0]?.skills).toHaveLength(1);
    expect(output.standalonePlugins[0]?.skills[0]?.name).toBe('skill1');
  });

  it('should handle standalone skills (no plugin)', () => {
    const results: ValidationResult[] = [
      createTestResult(
        `${homeDir}/.claude/plugins/standalone-skill/SKILL.md`,
        'warning',
        TEST_WARNING_CODE,
        'Test warning',
      ),
    ];

    const output = buildHierarchicalOutput(results, false, runRoot);

    expect(output.standaloneSkills).toHaveLength(1);
    expect(output.standaloneSkills[0]?.name).toBe('standalone-skill');
    // Status is upgraded to 'error' due to misconfiguration detection
    expect(output.standaloneSkills[0]?.status).toBe('error');
    // Should have original warning + misconfiguration error
    expect(output.standaloneSkills[0]?.issues).toHaveLength(2);
    expect(output.standaloneSkills[0]?.issues[1]?.code).toBe('SKILL_MISCONFIGURED_LOCATION');
  });

  it('reports every path relative to the run root, not as an absolute or ~-abbreviated path', () => {
    const results: ValidationResult[] = [
      createTestResult(
        `${homeDir}/.claude/plugins/marketplaces/marketplace1/plugin1/skills/skill1/SKILL.md`,
        'error',
        TEST_ERROR_CODE,
        TEST_ERROR_MESSAGE
      ),
    ];

    const output = buildHierarchicalOutput(results, false, runRoot);

    const skill = output.marketplaces[0]?.plugins[0]?.skills[0];
    expect(skill?.path).toBe('plugins/marketplaces/marketplace1/plugin1/skills/skill1/SKILL.md');
  });

  it('anchors the misconfigured-location finding at the run root too', () => {
    const results: ValidationResult[] = [
      createTestResult(
        `${homeDir}/.claude/plugins/standalone-skill/SKILL.md`,
        'warning',
        TEST_WARNING_CODE,
        TEST_WARNING_MESSAGE
      ),
    ];

    const output = buildHierarchicalOutput(results, false, runRoot);

    const misconfig = output.standaloneSkills[0]?.issues.find(
      (i) => i.code === 'SKILL_MISCONFIGURED_LOCATION',
    );
    expect(misconfig?.location).toBe('plugins/standalone-skill/SKILL.md');
  });

  // ── "nothing to show" must mean "no findings", never "status success" ──────
  //
  // An info-only result IS `success` — the status names the worst ACTIONABLE
  // severity. Keying the terse filter on the status therefore silently deletes
  // every info finding in the report while the summary keeps counting them.

  it('renders a skill whose only findings are info, even in terse (non-verbose) mode', () => {
    const results: ValidationResult[] = [
      createTestResult(
        marketplaceSkillPath('marketplace1', 'plugin1', 'skill1'),
        'success',
        TEST_INFO_CODE,
        TEST_INFO_MESSAGE,
        SEVERITY_INFO,
      ),
    ];

    const output = buildHierarchicalOutput(results, false, runRoot);

    const skill = output.marketplaces[0]?.plugins[0]?.skills[0];
    expect(skill?.name).toBe('skill1');
    expect(skill?.status).toBe('success');
    expect(skill?.issues).toHaveLength(1);
    expect(skill?.issues[0]?.severity).toBe(SEVERITY_INFO);
  });

  it('still drops a result with zero findings in terse mode', () => {
    const results = [createCleanResult(marketplaceSkillPath('marketplace1', 'plugin1', 'clean'))];

    expect(buildHierarchicalOutput(results, false, runRoot).marketplaces).toHaveLength(0);
    expect(buildHierarchicalOutput(results, true, runRoot).marketplaces).toHaveLength(1);
  });

  // ── Grouping must name the plugin, not a fixed path segment ───────────────
  //
  // Claude Code's real installed layout carries an extra `plugins/` segment
  // between the marketplace and the plugin. Reading the plugin as
  // "two after `marketplaces`" names every group `plugins`.

  it('names the marketplace plugin group after the plugin directory in the real installed layout', () => {
    const results = [createErrorResult(marketplaceSkillPath('marketplace1', 'arc', 'skill1'))];

    const output = buildHierarchicalOutput(results, false, runRoot);

    expect(output.marketplaces[0]?.name).toBe('marketplace1');
    expect(output.marketplaces[0]?.plugins[0]?.name).toBe('arc');
  });

  it('names the cached plugin group after the plugin, not the version directory', () => {
    const results = [createErrorResult(cachedSkillPath('marketplace1', 'arc', 'skill1'))];

    const output = buildHierarchicalOutput(results, false, runRoot);

    expect(output.cachedPlugins).toHaveLength(1);
    expect(output.cachedPlugins[0]?.name).toBe('arc');
  });

  // ── Cache/source matching must not key on the bare skill name ─────────────
  //
  // Two marketplaces routinely ship a skill of the same name. A map keyed by
  // bare name keeps only the last one, so a cached copy is compared against a
  // stranger: identical copies read as `stale`, and genuinely drifted ones can
  // read as `fresh` and vanish.

  it('matches a cached skill against the source in its OWN marketplace, not a same-named stranger', () => {
    const results = [
      // marketplace1/arc ships `shared-name` WITH an error.
      createErrorResult(marketplaceSkillPath('marketplace1', 'arc', SHARED_SKILL_NAME)),
      // marketplace2/brc ships an unrelated skill that happens to share the name, clean.
      createCleanResult(marketplaceSkillPath('marketplace2', 'brc', SHARED_SKILL_NAME)),
      // The cache copy of marketplace1/arc — byte-for-byte the same findings as its source.
      createErrorResult(cachedSkillPath('marketplace1', 'arc', SHARED_SKILL_NAME)),
    ];

    const output = buildHierarchicalOutput(results, false, runRoot);

    // Fresh cache duplicate → suppressed entirely.
    expect(output.cachedPlugins).toHaveLength(0);
  });

  it('still surfaces a cached copy that genuinely differs from its own source as stale', () => {
    const results = [
      createCleanResult(marketplaceSkillPath('marketplace1', 'arc', 'skill1')),
      createErrorResult(cachedSkillPath('marketplace1', 'arc', 'skill1')),
    ];

    const output = buildHierarchicalOutput(results, false, runRoot);

    expect(output.cachedPlugins).toHaveLength(1);
    expect(output.cachedPlugins[0]?.skills[0]?.cacheStatus).toBe('stale');
  });

  it('reports a cached skill with no matching source as orphaned', () => {
    const results = [createErrorResult(cachedSkillPath('marketplace1', 'gone', 'skill1', '9.9.9'))];

    const output = buildHierarchicalOutput(results, false, runRoot);

    expect(output.cachedPlugins[0]?.skills[0]?.cacheStatus).toBe('orphaned');
  });
});
