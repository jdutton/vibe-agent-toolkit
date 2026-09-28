import * as os from 'node:os';

import { describeIssues, type ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { addMisconfigurationIssues, buildHierarchicalOutput } from '../../../src/commands/audit/hierarchical-output.js';

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
 * Build a one-issue result whose `status`/`summary` are DERIVED from that issue,
 * as every real producer does.
 *
 * Takes the issue's SEVERITY, not a status: the skill tree's status word is
 * derived from the issues, and an info-only result — which the terse filter
 * once dropped — is expressible only when severity is the input.
 */
function createTestResult(
  path: string,
  severity: 'error' | 'warning' | 'info',
  issueCode: string,
  issueMessage: string,
): ValidationResult {
  // `code` is a registry-typed union; these fixtures use synthetic codes.
  const issues = [{ code: issueCode, message: issueMessage, severity }] as unknown as ValidationIssue[];
  return resultOf(path, issues);
}

/** A result with NO findings at all — the only thing a terse report may drop. */
function createCleanResult(path: string): ValidationResult {
  return resultOf(path, []);
}

function resultOf(path: string, issues: ValidationIssue[]): ValidationResult {
  return {
    path,
    type: RESOURCE_TYPE_SKILL,
    ...describeIssues(issues, RESOURCE_TYPE_SKILL),
    issues,
  };
}

/** A one-error result — the shape most of the cache/grouping cases need. */
function createErrorResult(path: string): ValidationResult {
  return createTestResult(path, SEVERITY_ERROR, TEST_ERROR_CODE, TEST_ERROR_MESSAGE);
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
        SEVERITY_ERROR,
        TEST_ERROR_CODE,
        TEST_ERROR_MESSAGE
      ),
      createTestResult(
        `${homeDir}/.claude/plugins/marketplaces/marketplace1/plugin1/skills/skill2/SKILL.md`,
        SEVERITY_WARNING,
        TEST_WARNING_CODE,
        'Test warning 2'
      ),
      createTestResult(
        `${homeDir}/.claude/plugins/marketplaces/marketplace1/plugin2/skills/skill3/SKILL.md`,
        SEVERITY_WARNING,
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
    // The literal envelope vocabulary: the distribution is in `summary`.
    expect(plugin1?.skills[0]?.status).toBe('findings');
    expect(plugin1?.skills[0]?.summary).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(plugin1?.skills[1]?.name).toBe('skill2');
    expect(plugin1?.skills[1]?.summary).toEqual({ errors: 0, warnings: 1, info: 0 });

    const plugin2 = output.marketplaces[0]?.plugins[1];
    expect(plugin2?.name).toBe('plugin2');
    expect(plugin2?.skills).toHaveLength(1);
    expect(plugin2?.skills[0]?.name).toBe('skill3');
    expect(plugin2?.skills[0]?.summary).toEqual({ errors: 0, warnings: 1, info: 0 });
  });

  it('should handle standalone plugins (no marketplace)', () => {
    const results: ValidationResult[] = [
      createTestResult(
        `${homeDir}/.claude/plugins/standalone-plugin/skills/skill1/SKILL.md`,
        SEVERITY_ERROR,
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
        SEVERITY_WARNING,
        TEST_WARNING_CODE,
        'Test warning',
      ),
    ];

    // The misconfiguration finding joins the RESULTS first (the `--user` lane
    // does this), so the envelope counts it — then the hierarchy shows it.
    const withMisconfig = addMisconfigurationIssues(results, runRoot);
    const output = buildHierarchicalOutput(withMisconfig, false, runRoot);

    expect(output.standaloneSkills).toHaveLength(1);
    expect(output.standaloneSkills[0]?.name).toBe('standalone-skill');
    // Original warning + misconfiguration error
    expect(output.standaloneSkills[0]?.summary).toEqual({ errors: 1, warnings: 1, info: 0 });
    expect(withMisconfig[0]?.issues.map((i) => i.code)).toEqual([TEST_WARNING_CODE, 'SKILL_MISCONFIGURED_LOCATION']);
    expect(withMisconfig[0]?.summary).toEqual({ errors: 1, warnings: 1, info: 0 });
  });

  it('reports every path relative to the run root, not as an absolute or ~-abbreviated path', () => {
    const results: ValidationResult[] = [
      createTestResult(
        `${homeDir}/.claude/plugins/marketplaces/marketplace1/plugin1/skills/skill1/SKILL.md`,
        SEVERITY_ERROR,
        TEST_ERROR_CODE,
        TEST_ERROR_MESSAGE
      ),
    ];

    const output = buildHierarchicalOutput(results, false, runRoot);

    const skill = output.marketplaces[0]?.plugins[0]?.skills[0];
    expect(skill?.path).toBe('plugins/marketplaces/marketplace1/plugin1/skills/skill1/SKILL.md');
  });

  it('files the misconfigured-location finding on a SKILL only — a plugin directory under plugins/ is where it belongs', () => {
    const plugin: ValidationResult = { ...resultOf(`${homeDir}/.claude/plugins/some-plugin`, []), type: 'claude-plugin' };

    expect(addMisconfigurationIssues([plugin], runRoot)).toEqual([plugin]);
  });

  it('does not flag a skill-claude-plugin — a root SKILL.md beside its own plugin manifest', () => {
    const pluginDir = `${homeDir}/.claude/plugins/skill-plugin`;
    const skill = createTestResult(`${pluginDir}/SKILL.md`, SEVERITY_WARNING, TEST_WARNING_CODE, TEST_WARNING_MESSAGE);
    const plugin: ValidationResult = { ...resultOf(pluginDir, []), type: 'claude-plugin' };

    expect(addMisconfigurationIssues([skill, plugin], runRoot)).toEqual([skill, plugin]);
  });

  it('anchors the misconfigured-location finding at the run root too', () => {
    const results: ValidationResult[] = [
      createTestResult(
        `${homeDir}/.claude/plugins/standalone-skill/SKILL.md`,
        SEVERITY_WARNING,
        TEST_WARNING_CODE,
        TEST_WARNING_MESSAGE
      ),
    ];

    const misconfig = addMisconfigurationIssues(results, runRoot)[0]?.issues.find(
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
        SEVERITY_INFO,
        TEST_INFO_CODE,
        TEST_INFO_MESSAGE,
      ),
    ];

    const output = buildHierarchicalOutput(results, false, runRoot);

    const skill = output.marketplaces[0]?.plugins[0]?.skills[0];
    expect(skill?.name).toBe('skill1');
    expect(skill?.status).toBe('findings');
    expect(skill?.summary).toEqual({ errors: 0, warnings: 0, info: 1 });
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
