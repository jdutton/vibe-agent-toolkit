/**
 * The reports `vat claude plugin list|install|uninstall` publish, built from
 * what each run did — pure, so the envelope each verb derives is pinned here
 * without spawning, and each one is checked against its registered schema.
 */

import { buildClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import { createRegistryIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { PLUGIN_INSTALL_REPORT_SCHEMA } from '../../../../src/commands/claude/plugin/install-schema.js';
import { buildPluginInstallReport, installFinished, type InstallOutcome } from '../../../../src/commands/claude/plugin/install.js';
import { PLUGIN_LIST_REPORT_SCHEMA } from '../../../../src/commands/claude/plugin/list-schema.js';
import { buildPluginListReport } from '../../../../src/commands/claude/plugin/list.js';
import { PLUGIN_UNINSTALL_REPORT_SCHEMA } from '../../../../src/commands/claude/plugin/uninstall-schema.js';
import { buildPluginUninstallReport } from '../../../../src/commands/claude/plugin/uninstall.js';

const PATHS = buildClaudeUserPaths('/home/u/.claude');
const PLUGIN_KEY = 'p@mp';

/** A copy install of one skill, with whatever findings the case needs. */
function installOutcome(overrides: Partial<InstallOutcome> = {}): InstallOutcome {
  return {
    source: 'local:/src/skill',
    sourceType: 'local',
    symlink: false,
    skills: [{ name: 'skill', installPath: '/home/u/.claude/skills/skill', sourcePath: null }],
    issues: [],
    ...overrides,
  };
}

describe('claude plugin list report', () => {
  it('counts both registries as examined, and an empty machine is ok', () => {
    const report = PLUGIN_LIST_REPORT_SCHEMA.parse(buildPluginListReport({ pluginRegistry: 0, legacySkillsDir: 0, plugins: [], legacySkills: [] }, PATHS, 1));

    expect(report).toMatchObject({ status: 'ok', examined: 2, findings: [] });
    expect(report.data).toStrictEqual({
      target: 'code',
      sources: { pluginRegistry: PATHS.installedPluginsPath, legacySkillsDir: PATHS.skillsDir },
      plugins: [],
      legacySkills: [],
    });
  });

  it('carries the listed plugins and legacy skills', () => {
    const plugin = { name: 'p', marketplace: 'mp', version: '1.0.0', installedAt: 'now', source: 'npm' as const };
    const legacy = { name: 'old', path: '/home/u/.claude/skills/old', type: 'directory' as const };

    const report = buildPluginListReport({ pluginRegistry: 1, legacySkillsDir: 1, plugins: [plugin], legacySkills: [legacy] }, PATHS, 1);

    expect(report.data).toMatchObject({ plugins: [plugin], legacySkills: [legacy] });
  });
});

describe('claude plugin install report', () => {
  it('is ok over one resolved source, with dryRun on the data', () => {
    const report = PLUGIN_INSTALL_REPORT_SCHEMA.parse(buildPluginInstallReport(installOutcome(), true, 1));

    expect(report).toMatchObject({ status: 'ok', examined: 1, gate: { strict: false } });
    expect(report.data).toMatchObject({ source: 'local:/src/skill', sourceType: 'local', dryRun: true, symlink: false });
  });

  it('is ok with no skills for a postinstall that skipped — never a zero-examined refusal', () => {
    const report = buildPluginInstallReport(installOutcome({ sourceType: 'npm-postinstall', skills: [] }), false, 1);

    expect(report).toMatchObject({ status: 'ok', examined: 1, findings: [], data: { skills: [] } });
  });

  it('publishes an unbuilt --dev skill as a warning finding', () => {
    const issue = createRegistryIssue('COMPONENT_DECLARED_BUT_MISSING', 'not built', { location: 'dist/skills/x' });

    const report = PLUGIN_INSTALL_REPORT_SCHEMA.parse(buildPluginInstallReport(installOutcome({ symlink: true, sourceType: 'dev', skills: [], issues: [issue] }), false, 1));

    expect(report.status).toBe('findings');
    expect(report.summary).toStrictEqual({ errors: 0, warnings: 1, info: 0 });
    expect(report.findings).toMatchObject([{ code: 'COMPONENT_DECLARED_BUT_MISSING', location: 'dist/skills/x' }]);
  });
});

describe('claude plugin install refusal — what finished', () => {
  it('is NOTHING_FINISHED before any lane named a source, or when nothing installed yet', () => {
    expect(installFinished(undefined, false)).toMatchObject({ examined: 0, data: null });
    expect(installFinished(installOutcome({ skills: [] }), false)).toMatchObject({ examined: 0, data: null });
  });

  it('carries every skill already installed, so a refusal on skill k still reports 1..k-1', () => {
    const finished = installFinished(installOutcome(), true);

    expect(finished.examined).toBe(1);
    expect(PLUGIN_INSTALL_REPORT_SCHEMA.parse({
      status: 'error', examined: 1, findings: [], summary: { errors: 0, warnings: 0, info: 0 },
      gate: { strict: false }, error: { code: 'USAGE_INVALID', message: 'x' }, data: finished.data,
    }).data?.skills).toStrictEqual(installOutcome().skills);
  });
});

describe('claude plugin uninstall report', () => {
  it('is ok when nothing was installed — one request, removed: false', () => {
    const report = PLUGIN_UNINSTALL_REPORT_SCHEMA.parse(buildPluginUninstallReport([{ key: PLUGIN_KEY, removed: false }], false, 1));

    expect(report).toMatchObject({ status: 'ok', examined: 1, data: { dryRun: false, plugins: [{ key: PLUGIN_KEY, removed: false }] } });
  });

  it('is ok with no plugins for an --all that matched none', () => {
    expect(buildPluginUninstallReport([], true, 1)).toMatchObject({ status: 'ok', examined: 1, data: { dryRun: true, plugins: [] } });
  });

  it('turns a half-removed plugin warning into PLUGIN_UNINSTALL_INCOMPLETE at the key, off the data', () => {
    const report = PLUGIN_UNINSTALL_REPORT_SCHEMA.parse(buildPluginUninstallReport([{ key: PLUGIN_KEY, removed: true, warning: 'not VAT\'s' }], false, 1));

    expect(report.status).toBe('findings');
    expect(report.findings).toMatchObject([{ code: 'PLUGIN_UNINSTALL_INCOMPLETE', severity: 'warning', location: PLUGIN_KEY, message: 'not VAT\'s' }]);
    expect(report.data?.plugins).toStrictEqual([{ key: PLUGIN_KEY, removed: true }]);
  });
});
