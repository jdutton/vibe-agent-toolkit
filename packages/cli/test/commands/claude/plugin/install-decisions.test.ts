/**
 * The decisions `vat claude plugin install` makes without touching a disk: which skills a
 * `--name` selects, which names a package may not carry, what a run reports and when it
 * records it, and what the decided plan says about a replaced plugin.
 */

import { describe, expect, it, vi } from 'vitest';

import { __internal, installFinished } from '../../../../src/commands/claude/plugin/install.js';
import { NOTHING_FINISHED } from '../../../../src/utils/document-writer.js';
import { fakeLogger, refusalOf } from '../../../helpers/refusal-of.js';

const {
  assertInstallTarget, assertPackagePluginNames, executeInstall, leftover, logInstallOutcome, newInstallRun, notPlugins,
  notPluginSkills, notSkills, outcomeOf, record, replacedOutcome, selectSkills, setSource, skillNameToFsPath,
} = __internal;

const runOf = (options: Record<string, unknown> = {}) => newInstallRun(options, fakeLogger() as never);
const SKILL = { name: 'alpha', installPath: '/home/u/.claude/skills/alpha', sourcePath: null };
const WARNING = { code: 'TREE_CLEANUP_INCOMPLETE', severity: 'warning', message: 'left behind', link: '/x' } as const;

describe('an install run', () => {
  it('starts with nothing done, a dry run only when asked', () => {
    expect(runOf()).toMatchObject({ dryRun: false, source: undefined, skills: [], issues: [], roots: { source: [], environment: [] } });
    expect(runOf({ dryRun: true }).dryRun).toBe(true);
  });

  it('has no outcome until a lane names its source, then reports exactly what was recorded', () => {
    const run = runOf();
    expect(outcomeOf(run)).toBeUndefined();

    setSource(run, 'my-pkg@1.0.0', 'npm');
    record(run, { changes: [], registry: null, replaced: [], skills: [SKILL], issues: [] }, [WARNING]);

    expect(outcomeOf(run)).toEqual({ source: 'my-pkg@1.0.0', sourceType: 'npm', symlink: false, skills: [SKILL], issues: [WARNING] });
  });

  it('a --dev lane marks its source as symlinked', () => {
    const run = runOf();
    setSource(run, '/proj', 'dev', true);
    expect(outcomeOf(run)?.symlink).toBe(true);
  });

  it('a leftover is logged as a warning and joins the run\'s findings', () => {
    const run = runOf();
    leftover(run, WARNING as never);
    expect(run.logger.warn).toHaveBeenCalledWith('   left behind');
    expect(run.issues).toEqual([WARNING]);
  });

  it('a refusal publishes what finished: nothing for an outcome with no skill and no finding', () => {
    const run = runOf();
    expect(installFinished(outcomeOf(run), false)).toBe(NOTHING_FINISHED);
    setSource(run, 's', 'local');
    expect(installFinished(outcomeOf(run), false)).toBe(NOTHING_FINISHED);
    record(run, { changes: [], registry: null, replaced: [], skills: [SKILL], issues: [] }, []);
    expect(installFinished(outcomeOf(run), true)).toMatchObject({ data: { source: 's', dryRun: true, skills: [SKILL] } });
  });
});

describe('selectSkills', () => {
  it('takes every declared skill without --name, and a copy the caller may change', () => {
    const declared = ['a', 'b'];
    const selected = selectSkills(declared, undefined, 'pkg');
    expect(selected).toEqual(['a', 'b']);
    expect(selected).not.toBe(declared);
  });

  it('takes the one --name names', () => {
    expect(selectSkills(['a', 'b'], 'b', 'pkg')).toEqual(['b']);
  });

  it('refuses a --name the package does not declare as the invocation\'s mistake, listing what it has', () => {
    const refusal = refusalOf(() => selectSkills(['a', 'b'], 'c', 'pkg'));
    expect(refusal.refusal).toBe('USAGE_INVALID');
    expect(refusal.message).toBe('Skill "c" not found in package pkg. Available: a, b');
  });
});

describe('assertInstallTarget', () => {
  it('accepts code', () => {
    expect(() => assertInstallTarget('code')).not.toThrow();
  });

  it.each([
    ['claude.ai', 'NOT_IMPLEMENTED'],
    ['cursor', 'USAGE_INVALID'],
  ])('refuses %s as %s', (target, code) => {
    expect(refusalOf(() => assertInstallTarget(target)).refusal).toBe(code);
  });
});

describe('assertPackagePluginNames', () => {
  const pkg = (replaces: Record<string, unknown>) => ({ name: '@scope/pkg', vat: { replaces } }) as never;

  it('refuses a replaced flat skill that is not one path segment as the package\'s content, before anything is listed', () => {
    const refusal = refusalOf(() => assertPackagePluginNames('/pkg/marketplaces', ['mp'], pkg({ flatSkills: ['../victim'] }), '1.0.0', 'source'));
    expect(refusal.refusal).toBe('INPUT_UNREADABLE');
    expect(refusal.message).toContain('"../victim"');
    expect(refusal.message).toContain('nothing was changed');
  });

  it('accepts a package with no marketplace and well-formed replaced names', () => {
    expect(() => assertPackagePluginNames('/pkg/marketplaces', [], pkg({ flatSkills: ['old-skill'], plugins: ['old'] }), '1.0.0', 'source')).not.toThrow();
  });
});

describe('--dev copy filters', () => {
  it('a plugin copy leaves out its skills directory and nothing else', () => {
    expect(['skills', 'commands', 'skills-extra', '.claude-plugin'].filter((entry) => notSkills(entry))).toEqual(['commands', 'skills-extra', '.claude-plugin']);
  });

  it('a marketplace copy leaves out its plugins directory and nothing else', () => {
    expect(['plugins', 'README.md', '.claude-plugin'].filter((entry) => notPlugins(entry))).toEqual(['README.md', '.claude-plugin']);
  });

  it('a marketplace read leaves out each plugin\'s skills directory, not a deeper or differently placed one', () => {
    const entries = ['plugins/p/skills', 'plugins/p/skills/a', 'plugins/p/commands', 'skills', 'plugins/p/q/skills'];
    expect(entries.filter((entry) => notPluginSkills(entry))).toEqual(['plugins/p/skills/a', 'plugins/p/commands', 'skills', 'plugins/p/q/skills']);
  });
});

describe('skillNameToFsPath', () => {
  it('turns every colon of a namespaced name into a double underscore', () => {
    expect(skillNameToFsPath('pkg:sub:leaf')).toBe('pkg__sub__leaf');
    expect(skillNameToFsPath('plain')).toBe('plain');
  });
});

describe('logInstallOutcome', () => {
  const outcome = (skills: number, symlink = false) => ({ source: 's', sourceType: 'local', symlink, skills: Array.from({ length: skills }, () => SKILL), issues: [] }) as never;
  const linesOf = (logger: ReturnType<typeof fakeLogger>): string[] => logger.info.mock.calls.map((call) => String(call[0]));

  it('a copy install says how many skills and how to see them', () => {
    const logger = fakeLogger();
    logInstallOutcome(outcome(2), false, logger as never);
    expect(linesOf(logger)[0]).toBe('\n✅ Installed 2 skill(s)');
    expect(linesOf(logger).join('\n')).toContain('vat claude plugin list');
  });

  it('an install of nothing does not tell the user to go and verify it', () => {
    const logger = fakeLogger();
    logInstallOutcome(outcome(0), false, logger as never);
    expect(linesOf(logger)).toEqual(['\n✅ Installed 0 skill(s)']);
  });

  it('a dry run says "would", for a copy and for a --dev link', () => {
    const copy = fakeLogger();
    logInstallOutcome(outcome(1), true, copy as never);
    expect(linesOf(copy)).toEqual(['\n✅ Dry-run complete: 1 skill(s) would be installed']);
    const dev = fakeLogger();
    logInstallOutcome(outcome(1, true), true, dev as never);
    expect(linesOf(dev)).toEqual(['\n✅ Dry-run complete: 1 skill(s) would be symlinked']);
  });

  it('a --dev install names the reload step', () => {
    const logger = fakeLogger();
    logInstallOutcome(outcome(3, true), false, logger as never);
    expect(linesOf(logger)).toEqual(['\n✅ Dev-installed 3 skill(s) via symlink', '   After rebuilding, run /reload-plugins in Claude Code']);
  });
});

describe('replacedOutcome', () => {
  const kept = (extra: Record<string, unknown> = {}) => ({ action: 'keep', existing: 'directory', reason: 'another plugin uses it', change: { dest: '/c/plugins/Old' }, ...extra });
  const planned = (replaced: unknown[]) => ({ changes: [], registry: null, replaced, skills: [], issues: [] }) as never;

  it('warns about a replaced plugin whose directory the plan keeps, naming the directory and why', () => {
    const run = runOf();
    const findings = replacedOutcome(run, planned([{ pluginKey: 'Old@mp', index: 0, reinstalled: false }]), { changes: [kept()] } as never);
    expect(run.logger.warn).toHaveBeenCalledWith('   Plugin "Old@mp" is removed from the registry, but /c/plugins/Old is kept (another plugin uses it)');
    expect(findings).toEqual([]);
  });

  it('says nothing for a key the package installs again, a directory that was absent, or one the plan removes', () => {
    const run = runOf();
    const plan = { changes: [kept(), kept({ existing: 'absent' }), { ...kept(), action: 'remove' }] } as never;
    replacedOutcome(run, planned([
      { pluginKey: 'a@mp', index: 0, reinstalled: true },
      { pluginKey: 'b@mp', index: 1, reinstalled: false },
      { pluginKey: 'c@mp', index: 2, reinstalled: false },
    ]), plan);
    expect(run.logger.warn).not.toHaveBeenCalled();
  });

  it('publishes a finding for a directory kept because a sibling could not be examined, linking the directory', () => {
    const findings = replacedOutcome(runOf(), planned([{ pluginKey: 'Old@mp', index: 0, reinstalled: true }]), { changes: [kept({ unexaminedSibling: '/c/plugins/new' })] } as never);
    expect(findings).toEqual([expect.objectContaining({ code: 'PLUGIN_KEPT_SIBLING_UNEXAMINED', severity: 'warning', link: '/c/plugins/Old' })]);
  });

  it('ignores a replaced entry whose change the plan does not hold', () => {
    const run = runOf();
    expect(replacedOutcome(run, planned([{ pluginKey: 'x@mp', index: 7, reinstalled: false }]), { changes: [] } as never)).toEqual([]);
    expect(run.logger.warn).not.toHaveBeenCalled();
  });
});

describe('executeInstall', () => {
  const plannedWith = (apply: () => Promise<void>) => ({ changes: [], registry: { apply }, replaced: [], skills: [SKILL], issues: [WARNING] }) as never;

  it('a dry run records what is planned and never writes the registry', async () => {
    const apply = vi.fn(async () => undefined);
    const run = runOf({ dryRun: true });
    await executeInstall(run, plannedWith(apply));
    expect(apply).not.toHaveBeenCalled();
    expect(run.skills).toEqual([SKILL]);
    expect(run.issues).toEqual([WARNING]);
  });

  it('a real run records its skills only once the registry edit has been applied', async () => {
    const run = runOf();
    let recordedAtApply: number | undefined;
    await executeInstall(run, plannedWith(async () => {
      recordedAtApply = run.skills.length;
    }));
    expect(recordedAtApply).toBe(0);
    expect(run.skills).toEqual([SKILL]);
  });

  it('a registry edit that throws leaves the run with nothing recorded', async () => {
    const run = runOf();
    const failure = new Error('registry refused');
    await expect(executeInstall(run, plannedWith(async () => {
      throw failure;
    }))).rejects.toBe(failure);
    expect(run.skills).toEqual([]);
  });
});
