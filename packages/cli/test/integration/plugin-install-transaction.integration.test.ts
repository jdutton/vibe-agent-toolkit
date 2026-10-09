/**
 * `vat claude plugin install` as ONE transaction, in process on a real filesystem: the
 * marketplace copy, each plugin's cache, the registry and everything `vat.replaces` removes
 * change together or not at all, and `--dry-run` prints the plan it would apply.
 *
 * The cases and the in-process driver are the fault matrix's (`fault-matrix/cases`,
 * `fault-matrix/drive.ts`); each test here aims one fault where the matrix's selection
 * would not reliably land, and states the user-visible end state.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { diffSnapshots, type FaultRule, installFaultFs, snapshotTree, tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pluginInstallCase } from '../fault-matrix/cases/install-family.js';
import { writeTree } from '../fault-matrix/cases/tree-files.js';
import { makeCaseRoot, runVerb, type CaseRoot, type VerbCase } from '../fault-matrix/drive.js';
import type { VerbOutcome } from '../fault-matrix/invariants.js';
import { writeZipFixture } from '../helpers/zip-fixtures.js';

const scratch = tempDirTracker('vat-plugin-install-txn-');
afterEach(() => {
  vi.unstubAllEnvs();
  scratch.cleanupAll();
});

const claude = (r: CaseRoot): string => safePath.join(r.home, '.claude');
const plugins = (r: CaseRoot): string => safePath.join(claude(r), 'plugins');

/** Build the case's fixture in a fresh root, then run it with `faults` injected under the root. */
async function runWith(c: VerbCase, faults: readonly FaultRule[] = [], extraArgv: readonly string[] = []): Promise<{ r: CaseRoot; outcome: VerbOutcome; before: ReturnType<typeof snapshotTree> }> {
  const r = makeCaseRoot(scratch.create());
  c.fixture(r);
  mkdirSyncReal(claude(r), { recursive: true });
  const before = snapshotTree(claude(r));
  const session = installFaultFs({ within: r.root, faults, rewrites: c.statRewrites?.(r) ?? [] });
  try {
    const outcome = await runVerb({ ...c, argv: (root) => [...c.argv(root), ...extraArgv] }, r);
    await session.settled();
    return { r, outcome, before };
  } finally {
    session.restore();
  }
}

/** A rule failing the rename that puts a registry file's new bytes in place (`replaceFile` stages beside it). */
const registryWrite = (file: string, errno: FaultRule['errno']): FaultRule => ({ family: 'rename', path: (p) => p.includes(`/.${file}.vat-staged-`), errno });

describe('vat claude plugin install — one transaction', () => {
  it('--dry-run prints one plan line per change, vat.replaces included, and changes nothing', async () => {
    const { r, outcome, before } = await runWith(pluginInstallCase('local', 'replaces'), [], ['--dry-run']);

    expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
    const lines = outcome.stderr.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('[dry-run] '));
    expect(lines).toEqual([
      `[dry-run] replace marketplace fx-mp ${safePath.join(plugins(r), 'marketplaces', 'fx-mp')}`,
      `[dry-run] create cache of fx-plugin@fx-mp ${safePath.join(plugins(r), 'cache', 'fx-mp', 'fx-plugin', '1.0.0')}`,
      `[dry-run] remove cache of replaced fx-old-plugin@fx-mp ${safePath.join(plugins(r), 'cache', 'fx-mp', 'fx-old-plugin')}`,
      `[dry-run] remove legacy flat skill fx-legacy-skill ${safePath.join(claude(r), 'skills', 'fx-legacy-skill')}`,
    ]);
    expect(diffSnapshots(before, snapshotTree(claude(r)))).toEqual([]);
  });

  it('a registry write that fails puts back the marketplace, the cache, the replaced plugin and the legacy flat skill, byte for byte', async () => {
    const { r, outcome, before } = await runWith(pluginInstallCase('local', 'replaces'), [registryWrite('settings.json', 'EACCES')]);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'RUN_INCOMPLETE', claimsFinished: false });
    expect(diffSnapshots(before, snapshotTree(claude(r)))).toEqual([]);
  });

  it('a first install refused at its registry write leaves nothing under ~/.claude, not even the parents it made', async () => {
    const { r, outcome } = await runWith(pluginInstallCase('local', 'fresh'), [registryWrite('installed_plugins.json', 'ENOSPC')]);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'RUN_INCOMPLETE', claimsFinished: false });
    expect(existsSync(plugins(r))).toBe(false);
  });

  // Review Focus 1, end to end, on every host: `vat.replaces` names `FX-PLUGIN` and the package ships
  // `fx-plugin`, the two cache spellings one directory (simulated by the matrix variant's stat rewrite).
  // GOLDEN: the new plugin installed, and only the old key unregistered — never an install with nothing.
  it('replaces-case-alias GOLDEN: the new plugin installed into the one directory, the old key unregistered', async () => {
    const { r, outcome } = await runWith(pluginInstallCase('local', 'replaces-case-alias'));

    expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
    const installed = JSON.parse(readFileSync(safePath.join(plugins(r), 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, unknown> };
    expect(Object.keys(installed.plugins)).toEqual(['fx-plugin@fx-mp']);
    expect(existsSync(safePath.join(plugins(r), 'cache', 'fx-mp', 'fx-plugin', '1.0.0', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(safePath.join(plugins(r), 'marketplaces', 'fx-mp', 'plugins', 'fx-plugin', 'skills', 'fx-skill', 'SKILL.md'))).toBe(true);
  });

  // The registered defect: --dev rm -rf'd the installed marketplace, then rebuilt it in place.
  it('--dev re-install never deletes the installed marketplace first: a skill link the OS refuses leaves it whole', async ({ skip }) => {
    if (process.platform === 'win32') skip();
    const { r, outcome, before } = await runWith(pluginInstallCase('dev', 'force'), [{ family: 'create', op: 'symlink', path: (p) => p.includes('.vat-staged-'), errno: 'EDQUOT' }]);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'RUN_INCOMPLETE' });
    expect(diffSnapshots(before, snapshotTree(claude(r)))).toEqual([]);
  });

  it('--dev installs the marketplace with VAT\'s marker and links each skill to its build', async ({ skip }) => {
    if (process.platform === 'win32') skip();
    const { r, outcome } = await runWith(pluginInstallCase('dev', 'fresh'));

    expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
    const mp = safePath.join(plugins(r), 'marketplaces', 'fx-mp');
    expect(existsSync(safePath.join(mp, '.vat-marketplace'))).toBe(true);
    expect(lstatSync(safePath.join(mp, 'plugins', 'fx-plugin', 'skills', 'fx-skill')).isSymbolicLink()).toBe(true);
    expect(lstatSync(safePath.join(plugins(r), 'cache', 'fx-mp', 'fx-plugin', '1.0.0', 'skills', 'fx-skill')).isSymbolicLink()).toBe(true);
  });

  it('a replaced legacy flat skill the OS will not delete once the registry is written refuses RUN_INCOMPLETE, naming it, and lists what was installed', async () => {
    const parked = (p: string): boolean => p.includes('/.fx-legacy-skill.vat-staged-') && p.endsWith('.previous');
    const { r, outcome } = await runWith(pluginInstallCase('local', 'replaces'), [{ family: 'remove', path: parked, errno: 'EBUSY' }, { family: 'remove', path: parked, nth: 2, errno: 'EBUSY' }]);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'RUN_INCOMPLETE', claimsFinished: true });
    expect(outcome.message).toContain('.fx-legacy-skill.vat-staged-');
    const installed = JSON.parse(readFileSync(safePath.join(plugins(r), 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, unknown> };
    expect(Object.keys(installed.plugins)).toEqual(['fx-plugin@fx-mp']);
  });

  it('a $TMPDIR staging directory that will not go once the install is done is a warning naming it, not a refusal', async () => {
    const staging = (p: string): boolean => /\/vat-install-tgz-[^/]+$/.test(p);
    const { outcome } = await runWith(pluginInstallCase('tgz', 'fresh'), [{ family: 'remove', path: staging, errno: 'EBUSY' }, { family: 'remove', path: staging, nth: 2, errno: 'EBUSY' }, { family: 'remove', path: staging, nth: 3, errno: 'EBUSY' }]);

    expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
    expect(outcome.findings).toContainEqual(expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE' }));
    expect(outcome.warnings.join('\n')).toContain('vat-install-tgz-');
  });
});

describe('vat claude plugin install — skills lanes', () => {
  // The dry run did not extract, so a zip whose entries cannot coexist on disk passed it and the real run refused it.
  it('--dry-run refuses a zip the real run refuses (a file `a` beside a file `a/b`) as INPUT_UNREADABLE', async () => {
    const c = pluginInstallCase('local', 'fresh');
    const zipPath = (r: CaseRoot): string => safePath.join(r.root, 'input', 'clash.zip');
    const clash: VerbCase = {
      ...c,
      argv: (r) => ['install', zipPath(r)],
      fixture: (r) => {
        mkdirSyncReal(safePath.join(r.root, 'input'), { recursive: true });
        writeZipFixture(safePath.join(r.root, 'input'), 'clash.zip', [['a', Buffer.from('a\n')], ['a/b', Buffer.from('b\n')]]);
      },
    };

    const { r, outcome } = await runWith(clash, [], ['--dry-run']);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE' });
    expect(outcome.message).toContain(zipPath(r));
  });

  it('two declared skills, the second already installed without --force: USAGE_INVALID saying --force, and neither installed', async () => {
    const c = pluginInstallCase('local', 'fresh');
    const twoSkills: VerbCase = {
      ...c,
      argv: (r) => ['install', safePath.join(r.root, 'input', 'pkg')],
      fixture: (r) => {
        writeTree(safePath.join(r.root, 'input', 'pkg'), [
          ['package.json', JSON.stringify({ name: '@fx/two', version: '1.0.0', vat: { skills: ['alpha', 'beta'] } })],
          ['dist/skills/alpha/SKILL.md', '# alpha\n'],
          ['dist/skills/beta/SKILL.md', '# beta\n'],
        ]);
        writeTree(safePath.join(claude(r), 'skills', 'beta'), [['SKILL.md', '# already here\n']]);
      },
    };

    const { r, outcome } = await runWith(twoSkills);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'USAGE_INVALID', claimsFinished: false });
    expect(outcome.message).toContain('--force');
    expect(existsSync(safePath.join(claude(r), 'skills', 'alpha'))).toBe(false);
  });
});
