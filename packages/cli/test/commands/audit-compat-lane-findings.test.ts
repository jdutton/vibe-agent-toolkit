/**
 * What the `--compat` and `--settings` lanes of `vat audit` found, as FINDINGS — so the document's
 * status, its counts and its human channel are one answer. The lanes used to publish their
 * answers only as blocks under `data.files[]`: a plugin whose skill the org policy blocks was
 * `status: ok`, `findings: []`, beside a stderr line saying a conflict was found.
 */

import { describe, expect, it } from 'vitest';

import { compatLaneIssues, type CompatLaneAnswer } from '../../src/commands/audit/compat-lane-findings.js';

const PLUGIN = 'plugins/my-plugin';

const CONFLICT = {
  type: 'tool-blocked',
  detail: 'Tool "Bash" in skills/deploy/SKILL.md blocked by org policy (permissions.deny)',
  blockedBy: 'permissions.deny',
  value: 'Bash',
  settingsFile: '/etc/claude-code/managed-settings.json',
  settingsLevel: 'managed',
} as const;

/** A plugin the analyzer read whole, with nothing unchecked. */
const ANALYZED: CompatLaneAnswer['compatibility'] = { unchecked: [] };

/** A finding the document already carries: its code, and where. */
type Filed = readonly [code: string, location: string];

const issuesOf = (answer: CompatLaneAnswer, filed: readonly Filed[] = []): ReturnType<typeof compatLaneIssues> =>
  compatLaneIssues(PLUGIN, answer, filed.map(([code, location]) => ({ code, location })));

describe('compatLaneIssues', () => {
  it('says nothing for a plugin both lanes answered cleanly — and for one the settings lane was never asked about', () => {
    expect(issuesOf({ compatibility: ANALYZED, settings: { compatible: true, conflicts: [] } })).toEqual([]);
    expect(issuesOf({ compatibility: ANALYZED })).toEqual([]);
  });

  it('files each settings conflict as one finding on the plugin, naming the policy that blocks it', () => {
    const [issue, ...rest] = issuesOf({ compatibility: ANALYZED, settings: { compatible: false, conflicts: [CONFLICT, { ...CONFLICT, value: 'Edit', detail: 'Tool "Edit" in skills/deploy/SKILL.md blocked by org policy (permissions.deny)' }] } });

    expect(issue).toMatchObject({ code: 'SETTINGS_POLICY_CONFLICT', severity: 'warning', location: PLUGIN });
    expect(issue?.message).toContain(CONFLICT.detail);
    expect(issue?.message).toContain('/etc/claude-code/managed-settings.json');
    expect(issue?.message).toContain('managed');
    expect(rest.map((other) => other.code)).toEqual(['SETTINGS_POLICY_CONFLICT']);
  });

  it('files a plugin the analyzer could not run on as not checked, with the reason', () => {
    const issues = issuesOf({ compatibility: { analyzed: false, reason: 'EACCES: permission denied, scandir \'plugins/my-plugin\'' } });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'COMPAT_NOT_CHECKED', severity: 'warning', location: PLUGIN });
    expect(issues[0]?.message).toContain('EACCES: permission denied');
  });

  it('files a path either lane could not examine as not checked, once, at that path', () => {
    const unchecked = { path: 'plugins/my-plugin/hooks/hooks.json', reason: 'Unexpected token } in JSON' };
    const issues = issuesOf({
      compatibility: { unchecked: [unchecked] },
      settings: { compatible: false, conflicts: [], unchecked: [unchecked, { path: 'plugins/my-plugin/skills/odd', reason: 'not a mapping' }] },
    });

    expect(issues.map((issue) => [issue.code, issue.severity, issue.location])).toEqual([
      ['COMPAT_NOT_CHECKED', 'warning', 'plugins/my-plugin/hooks/hooks.json'],
      ['COMPAT_NOT_CHECKED', 'warning', 'plugins/my-plugin/skills/odd'],
    ]);
    expect(issues[0]?.message).toContain('Unexpected token');
  });

  const locked = { path: 'plugins/my-plugin/skills/locked/SKILL.md', reason: 'EACCES: permission denied' };
  const lockedAnswer: CompatLaneAnswer = { compatibility: { unchecked: [locked] }, settings: { compatible: false, conflicts: [], unchecked: [locked] } };

  // One refused path, one finding — however many lanes met it: the scan already filed this one.
  it.each(['SCAN_PATH_UNREADABLE', 'SKILL_MISSING_FRONTMATTER', 'COMPAT_NOT_CHECKED'])('adds nothing for an unchecked path the document already carries the refusal of, as %s', (code) => {
    expect(issuesOf(lockedAnswer, [[code, locked.path]])).toEqual([]);
    // The control: the same answer with nothing filed there is a finding.
    expect(issuesOf(lockedAnswer)).toHaveLength(1);
  });

  // The skip is for the SAME refusal, by its code — never for whatever else happens to be filed there.
  it('still files an unchecked path that carries only an unrelated finding', () => {
    const unrelated: readonly Filed[] = [['SKILL_DESCRIPTION_TOO_LONG', locked.path], ['CAPABILITY_LOCAL_SHELL', locked.path], ['SCAN_PATH_UNREADABLE', 'plugins/my-plugin/skills/another/SKILL.md']];

    expect(issuesOf(lockedAnswer, unrelated).map((issue) => [issue.code, issue.location])).toEqual([['COMPAT_NOT_CHECKED', locked.path]]);
  });

  it('still files the plugin as unchecked when the plugin\'s own row carries an unrelated finding', () => {
    const pluginWide: CompatLaneAnswer = { compatibility: ANALYZED, settings: { compatible: false, conflicts: [], unchecked: [{ path: PLUGIN, reason: 'the checker threw' }] } };

    expect(issuesOf(pluginWide, [['PLUGIN_MISSING_VERSION', PLUGIN]]).map((issue) => [issue.code, issue.location])).toEqual([['COMPAT_NOT_CHECKED', PLUGIN]]);
  });

  // Both lanes failing for the whole plugin is one refused path: one finding, with the analyzer's reason.
  it('files ONE finding on the plugin when both lanes could not run for it at all', () => {
    const issues = issuesOf({
      compatibility: { analyzed: false, reason: 'EACCES: permission denied, scandir' },
      settings: { compatible: false, conflicts: [], unchecked: [{ path: PLUGIN, reason: 'EACCES: permission denied, scandir' }] },
    });

    expect(issues.map((issue) => [issue.code, issue.location])).toEqual([['COMPAT_NOT_CHECKED', PLUGIN]]);
  });
});
