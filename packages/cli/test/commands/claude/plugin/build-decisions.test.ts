/**
 * The decisions `vat claude plugin build` makes from values alone: which pool skills a
 * selector takes, which plugin-local skills collide with them, and what the marketplaces
 * built so far amount to as a report — or as the finished work of a refusal.
 */

import { VatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { __internal, pluginBuildOutput } from '../../../../src/commands/claude/plugin/build.js';
import { NOTHING_FINISHED } from '../../../../src/utils/document-writer.js';

const {
  builtWork, marketplaceIssues, matchesSelector, pluginBuildData, reportPackagedSkillIssues, reportPluginIssues, resolveCollidingSkills,
  resolveMarketplaceAvailableSkills, resolvePluginSkills, SkillPackagingStop, unusedExcludeIssues, withPackagingStop,
} = __internal;

const issue = (code: string, severity: 'error' | 'warning' = 'warning') => ({ code, severity, message: `${code} message`, location: 'plugins/p' });
const plugin = (name: string, extra: Record<string, unknown> = {}) => ({ pluginName: name, pluginDir: `/proj/dist/.claude/plugins/marketplaces/mp/plugins/${name}`, skillsCopied: [], issues: [], ...extra });
const marketplace = (extra: Record<string, unknown> = {}) => ({ name: 'mp', plugins: [], externalPlugins: [], gate: undefined, residue: [], ...extra }) as never;
const local = (skillName: string, skillDirPath: string) => ({ skillName, skillDirPath, skillPath: `/proj/plugins/p/skills/${skillDirPath}/SKILL.md` });

describe('pluginBuildOutput', () => {
  it('is the one tree every marketplace is replaced under', () => {
    expect(pluginBuildOutput('/proj')).toBe('/proj/dist/.claude/plugins/marketplaces');
  });
});

describe('matchesSelector', () => {
  it.each([
    ['vat-audit', '*', true],
    ['vat-audit', 'vat-audit', true],
    ['vat-audit', 'vat-*', true],
    ['vat-audit', '*-audit', true],
    ['vat-audit', '*aud*', true],
    ['vat-audit', 'vat', false],
    ['my-vat-audit', 'vat-*', false],
    // Only `*` is a wildcard: every other character of a selector is itself, a `.` included.
    ['vatxaudit', 'vat.audit', false],
    ['vat.audit', 'vat.audit', true],
    ['vat-audit', 'vat-(audit|rag)', false],
    ['a+b', 'a+*', true],
  ])('%s against %s → %s', (name, selector, matched) => {
    expect(matchesSelector(name, selector)).toBe(matched);
  });
});

describe('resolveMarketplaceAvailableSkills', () => {
  const pool = ['vat-audit', 'vat-rag', 'cat-agents'];

  it('leaves the pool alone when the marketplace declares no filter, or "*"', () => {
    expect(resolveMarketplaceAvailableSkills({} as never, pool)).toBe(pool);
    expect(resolveMarketplaceAvailableSkills({ skills: '*' } as never, pool)).toBe(pool);
  });

  it('keeps each skill some selector matches, once, in selector order', () => {
    expect(resolveMarketplaceAvailableSkills({ skills: ['cat-*', 'vat-*', 'vat-audit'] } as never, pool)).toEqual(['cat-agents', 'vat-audit', 'vat-rag']);
  });

  it('a filter matching nothing leaves nothing', () => {
    expect(resolveMarketplaceAvailableSkills({ skills: ['nope'] } as never, pool)).toEqual([]);
  });
});

describe('resolvePluginSkills', () => {
  it('"*" takes everything the marketplace made available', () => {
    const available = ['a', 'b'];
    expect(resolvePluginSkills({ skills: '*' } as never, available)).toBe(available);
  });

  it('a colon-namespaced selector matches the fs-safe directory name the pool uses', () => {
    expect(resolvePluginSkills({ skills: ['pkg:sub'] } as never, ['pkg__sub', 'other'])).toEqual(['pkg__sub']);
  });

  it('a skill two selectors match is taken once', () => {
    expect(resolvePluginSkills({ skills: ['vat-*', 'vat-audit'] } as never, ['vat-audit', 'x'])).toEqual(['vat-audit']);
  });
});

describe('resolveCollidingSkills', () => {
  it('a plugin-local skill whose DECLARED name the pool selector also takes collides, wherever it is authored', () => {
    const nested = local('foo', 'group/foo');
    const result = resolveCollidingSkills([nested, local('bar', 'bar')], ['foo']);
    expect(result.colliding).toEqual([nested]);
    expect(result.packageable.map((skill) => skill.skillName)).toEqual(['bar']);
    expect(result.conflicts).toEqual([]);
  });

  it('a skill merely AUTHORED in a directory a pool skill copies into does not collide: it is a conflict nobody can win', () => {
    const squatter = local('bar', 'foo');
    const result = resolveCollidingSkills([squatter], ['foo']);
    expect(result.colliding).toEqual([]);
    expect(result.packageable).toEqual([squatter]);
    expect(result.conflicts).toEqual([{ skill: squatter, poolSkillFsPath: 'foo' }]);
  });

  it('a skill authored UNDER a pool skill\'s directory is a conflict too; a sibling sharing a prefix is not', () => {
    const under = local('deep', 'foo/deep');
    const sibling = local('other', 'foo-extra');
    const result = resolveCollidingSkills([under, sibling], ['foo']);
    expect(result.conflicts).toEqual([{ skill: under, poolSkillFsPath: 'foo' }]);
    expect(result.packageable).toEqual([under, sibling]);
  });

  it('compares a namespaced pool selection by its fs-safe name', () => {
    const colliding = local('pkg:sub', 'sub');
    expect(resolveCollidingSkills([colliding], ['pkg:sub']).colliding).toEqual([colliding]);
  });
});

describe('unusedExcludeIssues', () => {
  it('names each dead pattern at the plugin source, relative to the project', () => {
    const issues = unusedExcludeIssues(['**/*.tmp', 'drafts/**'], '/proj', '/proj/plugins/p');
    expect(issues.map((found) => found.code)).toEqual(['PLUGIN_EXCLUDE_PATTERN_UNUSED', 'PLUGIN_EXCLUDE_PATTERN_UNUSED']);
    expect(issues.map((found) => found.location)).toEqual(['plugins/p', 'plugins/p']);
    expect(issues[0]?.message).toContain("'**/*.tmp' under plugins/p");
  });

  it('is nothing when every pattern matched', () => {
    expect(unusedExcludeIssues([], '/proj', '/proj/plugins/p')).toEqual([]);
  });
});

describe('reportPluginIssues', () => {
  it('prints a heading and every finding, and nothing at all for a clean plugin', () => {
    const logger = { info: vi.fn() };
    reportPluginIssues([], logger as never);
    expect(logger.info).not.toHaveBeenCalled();

    reportPluginIssues(unusedExcludeIssues(['drafts/**'], '/proj', '/proj/plugins/p'), logger as never);
    const lines = logger.info.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toMatch(/^ {9}plugin: /);
    expect(lines.join('\n')).toContain('PLUGIN_EXCLUDE_PATTERN_UNUSED');
  });
});

describe('marketplaceIssues', () => {
  it('is every plugin\'s findings, then the gated plugin\'s, then what the plan could not remove', () => {
    const result = marketplace({
      plugins: [plugin('a', { issues: [issue('A')] }), plugin('b', { issues: [issue('B')] })],
      gate: { reason: 'plugin c failed', issues: [issue('C', 'error')] },
      residue: [issue('TREE_CLEANUP_INCOMPLETE')],
    });
    expect(marketplaceIssues(result).map((found) => found.code)).toEqual(['A', 'B', 'C', 'TREE_CLEANUP_INCOMPLETE']);
  });
});

describe('pluginBuildData', () => {
  it('counts a gated marketplace as not built, and carries the gate\'s reason on its row', () => {
    const data = pluginBuildData('/proj', [
      marketplace({ name: 'ok-mp', plugins: [plugin('a', { skillsCopied: ['s1', 's2'] })] }),
      marketplace({ name: 'gated-mp', gate: { reason: 'plugin b failed its checks', issues: [issue('X', 'error')] } }),
    ]);
    expect(data).toMatchObject({ marketplacesBuilt: 1, pluginsBuilt: 1, skillsPackaged: 2, pluginsReferenced: 0 });
    expect(data.marketplaces.map((row) => [row.name, row.status])).toEqual([['ok-mp', 'ok'], ['gated-mp', 'findings']]);
    expect(data.marketplaces[1]).toMatchObject({ reason: 'plugin b failed its checks' });
    expect(data.marketplaces[0]).not.toHaveProperty('reason');
  });

  it('publishes a plugin\'s output path relative to the project, and its skills', () => {
    const data = pluginBuildData('/proj', [marketplace({ plugins: [plugin('a', { skillsCopied: ['s1'] })] })]);
    expect(data.marketplaces[0]?.plugins).toEqual([{ name: 'a', outputPath: 'dist/.claude/plugins/marketplaces/mp/plugins/a', skills: ['s1'] }]);
  });

  it('a referenced plugin has a source and no output path; its version appears only when it has one', () => {
    const source = { source: 'github', repo: 'o/r' };
    const data = pluginBuildData('/proj', [marketplace({ externalPlugins: [
      { pluginName: 'ext', pluginVersion: undefined, source },
      { pluginName: 'pinned', pluginVersion: '2.0.0', source },
    ] })]);
    expect(data.pluginsReferenced).toBe(2);
    expect(data.marketplaces[0]?.externalPlugins).toEqual([{ name: 'ext', source }, { name: 'pinned', version: '2.0.0', source }]);
  });

  it('a marketplace whose only findings are a built plugin\'s warnings is "findings"', () => {
    const data = pluginBuildData('/proj', [marketplace({ plugins: [plugin('a', { issues: [issue('W')] })] })]);
    expect(data.marketplaces[0]?.status).toBe('findings');
    expect(data.marketplacesBuilt).toBe(1);
  });
});

describe('builtWork', () => {
  it('examines one per marketplace and flattens their findings', () => {
    const work = builtWork('/proj', [marketplace({ plugins: [plugin('a', { issues: [issue('W')] })] }), marketplace({ name: 'second' })]);
    expect(work.examined).toBe(2);
    expect(work.findings.map((found) => found.code)).toEqual(['W']);
    expect(work.data.marketplaces).toHaveLength(2);
  });
});

describe('withPackagingStop', () => {
  const cause = new VatError('SKILL_PACKAGING_INPUT_INVALID', 'files: source scripts/tool.py does not exist');

  it('leaves the finished work alone for any other error', () => {
    expect(withPackagingStop(NOTHING_FINISHED, new Error('disk full'), '/proj')).toBe(NOTHING_FINISHED);
  });

  it('adds the packaging finding at the refused skill, relative to the project', () => {
    const stop = new SkillPackagingStop(cause, '/proj/plugins/p/skills/s/SKILL.md');
    expect(stop.refusal).toBe('RUN_INCOMPLETE');
    expect(stop.message).toBe(cause.message);

    const finished = withPackagingStop({ examined: 1, findings: [], data: null }, stop, '/proj');
    expect(finished.examined).toBe(1);
    expect(finished.findings).toEqual([expect.objectContaining({ code: 'SKILL_PACKAGING_FAILED', location: 'plugins/p/skills/s/SKILL.md' })]);
  });

  it('omits the location for a skill outside the project, or when no project root is known', () => {
    const outside = withPackagingStop(NOTHING_FINISHED, new SkillPackagingStop(cause, '/elsewhere/SKILL.md'), '/proj');
    expect(outside.findings[0]).not.toHaveProperty('location');
    const rootless = withPackagingStop(NOTHING_FINISHED, new SkillPackagingStop(cause, '/proj/SKILL.md'), undefined);
    expect(rootless.findings[0]).not.toHaveProperty('location');
  });
});

describe('reportPackagedSkillIssues', () => {
  it('prints nothing and reports no skill with errors when nothing was packaged', () => {
    const logger = { info: vi.fn() };
    expect(reportPackagedSkillIssues([], logger as never, false)).toEqual({ withErrors: [], issues: [] });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('names a packaged skill the packager marked as having errors, prints its findings, and hands them back', () => {
    const broken = { severity: 'error', code: 'LINK_INTEGRITY_BROKEN', message: 'guide.md links to missing.md', location: 'skills/s/guide.md' };
    const logger = { info: vi.fn() };

    const { withErrors, issues } = reportPackagedSkillIssues([{ skillDirPath: 's', result: { postBuildIssues: [broken], hasErrors: true } }] as never, logger as never, false);

    expect(withErrors).toEqual(['s']);
    expect(issues).toEqual([broken]);
    expect(logger.info.mock.calls.map((call) => String(call[0])).join('\n')).toContain('LINK_INTEGRITY_BROKEN');
  });
});
