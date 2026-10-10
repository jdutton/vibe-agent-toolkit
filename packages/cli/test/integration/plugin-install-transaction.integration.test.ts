/**
 * `vat claude plugin install` as ONE transaction, in process on a real filesystem: the
 * marketplace copy, each plugin's cache, the registry and everything `vat.replaces` removes
 * change together or not at all, and `--dry-run` prints the plan it would apply.
 *
 * The cases and the in-process driver are the fault matrix's (`fault-matrix/cases`,
 * `fault-matrix/drive.ts`); each test here aims one fault where the matrix's selection
 * would not reliably land, and states the user-visible end state.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { diffSnapshots, type FaultRule, installFaultFs, snapshotTree, tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pluginInstallCase } from '../fault-matrix/cases/install-family.js';
import { writeTree } from '../fault-matrix/cases/tree-files.js';
import { makeCaseRoot, runVerb, type CaseRoot, type VerbCase } from '../fault-matrix/drive.js';
import type { VerbOutcome } from '../fault-matrix/invariants.js';
import { tarballOf } from '../helpers/tarball.js';
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

/**
 * A rule failing VAT's write of a registry file: the exclusive open of the temp `replaceFile` stages
 * beside it. ⛔ The open, never the rename that follows: a rename refused `EACCES` is contention on
 * win32, where it is retried — one injected refusal would be a write that succeeds there.
 */
const registryWrite = (file: string, errno: FaultRule['errno']): FaultRule => ({ family: 'write', op: 'open', path: (p) => p.includes(`/.${file}.vat-staged-`), errno });

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

/** `c` installing the directory `input/pkg`, built by `files` on top of nothing; `extra` runs after the fixture. */
function installing(files: readonly (readonly [string, string])[], argvOf: (r: CaseRoot) => string[] = (r) => ['install', safePath.join(r.root, 'input', 'pkg')]): VerbCase {
  return {
    ...pluginInstallCase('local', 'fresh'),
    argv: argvOf,
    fixture: (r) => writeTree(safePath.join(r.root, 'input', 'pkg'), files.map(([path, content]) => [path, content])),
  };
}

const PLUGIN_TREE: readonly (readonly [string, string])[] = [
  ['dist/.claude/plugins/marketplaces/acme/.claude-plugin/marketplace.json', '{}'],
  ['dist/.claude/plugins/marketplaces/acme/plugins/a/.claude-plugin/plugin.json', '{"name":"a"}'],
];

// Ruling R1, end to end: what stands at ~/.claude/plugins/marketplaces/<name> is replaced only when VAT
// installed it from this very package.
describe('vat claude plugin install — a marketplace VAT did not install is never replaced', () => {
  const pkg = (name: string): readonly (readonly [string, string])[] => [['package.json', JSON.stringify({ name, version: '1.0.0' })], ...PLUGIN_TREE];
  /** A marketplace `acme` Claude Code added: a clone with the user's own file, no VAT marker, registered as a github source. */
  const withForeignAcme = (c: VerbCase): VerbCase => ({
    ...c,
    fixture: (r) => {
      c.fixture(r);
      writeTree(safePath.join(plugins(r), 'marketplaces', 'acme'), [['.git/HEAD', 'ref: refs/heads/main\n'], ['LOCAL-NOTES.md', 'mine'], ['plugins/user-plugin/x.md', 'x']]);
      writeTree(plugins(r), [['known_marketplaces.json', JSON.stringify({ acme: { source: { source: 'github', repo: 'o/r' }, installLocation: '', lastUpdated: '' } })]]);
    },
  });

  it('refuses USAGE_INVALID, naming the directory and --force, with nothing changed', async () => {
    const { r, outcome, before } = await runWith(withForeignAcme(installing(pkg('@fx/b'))));

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'USAGE_INVALID', claimsFinished: false });
    expect(outcome.message).toContain(safePath.join(plugins(r), 'marketplaces', 'acme'));
    expect(outcome.message).toContain('--force');
    expect(diffSnapshots(before, snapshotTree(claude(r)))).toEqual([]);
    expect(readFileSync(safePath.join(plugins(r), 'marketplaces', 'acme', 'LOCAL-NOTES.md'), 'utf8')).toBe('mine');
  });

  it('--force replaces it', async () => {
    const { r, outcome } = await runWith(withForeignAcme(installing(pkg('@fx/b'))), [], ['--force']);

    expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
    expect(existsSync(safePath.join(plugins(r), 'marketplaces', 'acme', 'LOCAL-NOTES.md'))).toBe(false);
    expect(readFileSync(safePath.join(plugins(r), 'marketplaces', 'acme', '.vat-marketplace'), 'utf8')).toContain('npm:@fx/b');
  });

  it('a second package shipping the same marketplace name is refused: the first package\'s install stays whole', async () => {
    const first = await runWith(installing(pkg('@fx/a')));
    expect(first.outcome.exitCode ?? 0, first.outcome.message).toBe(0);
    // ⛔ `runVerb` undoes the env stubs when it returns: HOME and the Claude directory are pointed at
    // the case root AGAIN before a second verb runs, or it would run against the ambient environment.
    const r = makeCaseRoot(first.r.root);
    expect(process.env['HOME']).toBe(r.home);
    writeTree(safePath.join(r.root, 'input', 'pkg'), [['package.json', JSON.stringify({ name: '@fx/b', version: '1.0.0' })]]);
    const before = snapshotTree(claude(r));

    const outcome = await runVerb(installing(pkg('@fx/b')), r);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'USAGE_INVALID' });
    expect(outcome.message).toContain('npm:@fx/a');
    expect(diffSnapshots(before, snapshotTree(claude(r)))).toEqual([]);
  });
});

describe('vat claude plugin install — what the package holds is the input, never VAT\'s defect', () => {
  // What `vat claude plugin build` leaves beside a marketplace when it is killed mid-swap.
  it('skips a tree-change leftover beside a marketplace: it is not a second marketplace', async () => {
    const residue = '.acme.vat-staged-deadbeef.previous';
    const files = [['package.json', JSON.stringify({ name: '@fx/a', version: '1.0.0' })], ...PLUGIN_TREE,
      [`dist/.claude/plugins/marketplaces/${residue}/plugins/a/.claude-plugin/plugin.json`, '{}']] as const;

    const { r, outcome } = await runWith(installing(files));

    expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
    expect(readdirSync(safePath.join(plugins(r), 'marketplaces'))).toEqual(['acme']);
    expect(Object.keys((JSON.parse(readFileSync(safePath.join(plugins(r), 'installed_plugins.json'), 'utf8')) as { plugins: object }).plugins)).toEqual(['a@acme']);
  });

  it.each([
    ['vat.skills naming one skill twice', { name: '@fx/a', version: '1.0.0', vat: { skills: ['a', 'a'] } }, 'vat.skills'],
    ['vat.skills that is a string', { name: '@fx/a', version: '1.0.0', vat: { skills: 'abc' } }, 'vat.skills'],
    ['a version that is a number', { name: '@fx/a', version: 1 }, 'version'],
    ['no name', { version: '1.0.0', vat: { skills: ['a'] } }, 'name'],
  ])('refuses package.json with %s as INPUT_UNREADABLE naming the field, nothing changed', async (_label, packageJson, field) => {
    const files = [['package.json', JSON.stringify(packageJson)], ...PLUGIN_TREE, ['dist/skills/a/SKILL.md', '# a\n']] as const;

    const { r, outcome, before } = await runWith(installing(files, (root) => ['install', safePath.join(root.root, 'input', 'pkg'), ...(field === 'version' ? [] : ['--user-install-without-plugin'])]));

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE', claimsFinished: false });
    expect(outcome.message).toContain(field);
    expect(diffSnapshots(before, snapshotTree(claude(r)))).toEqual([]);
  });

  it('refuses a .tgz that holds no package.json as the archive\'s (INPUT_UNREADABLE), not as VAT\'s scratch space vanishing', async () => {
    const tgz = (r: CaseRoot): string => safePath.join(r.root, 'input', 'bare-skill.tgz');
    const c: VerbCase = {
      ...pluginInstallCase('local', 'fresh'),
      argv: (r) => ['install', tgz(r)],
      fixture: (r) => {
        mkdirSyncReal(safePath.join(r.root, 'input'), { recursive: true });
        writeFileSync(tgz(r), tarballOf([['package/SKILL.md', '# bare\n']]));
      },
    };

    const { r, outcome } = await runWith(c);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE' });
    expect(outcome.message).toContain('package.json');
    expect(outcome.message).toContain(tgz(r));
    expect(outcome.message).not.toContain('scratch space');
  });

  it.each([
    ['holding no SKILL.md', [['readme.txt', 'hi\n']] as const, 'SKILL.md'],
    ['whose SKILL.md is one folder down (a zipped folder)', [['my-skill/SKILL.md', '---\nname: my-skill\ndescription: d\n---\n']] as const, 'my-skill'],
  ])('refuses a .zip %s: it would install as a skill Claude Code never loads', async (_label, entries, named) => {
    const c: VerbCase = {
      ...pluginInstallCase('local', 'fresh'),
      argv: (r) => ['install', safePath.join(r.root, 'input', 'junk.zip')],
      fixture: (r) => {
        mkdirSyncReal(safePath.join(r.root, 'input'), { recursive: true });
        writeZipFixture(safePath.join(r.root, 'input'), 'junk.zip', entries.map(([name, text]) => [name, Buffer.from(text)]));
      },
    };

    const { r, outcome } = await runWith(c);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE' });
    expect(outcome.message).toContain(named);
    expect(existsSync(safePath.join(claude(r), 'skills'))).toBe(false);
  });

  // Ruling R3 as a class: VAT's marker is written into a staged tree that holds whatever the package
  // shipped, links kept. A package shipping a link NAMED like the marker pointed it at the user's
  // settings — `../../../settings.json` from where the staged tree stands — and the marker was
  // written through it.
  it('refuses a package that ships a link named .vat-marketplace: INPUT_UNREADABLE naming it, the file it points at byte-identical, nothing installed', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const settings = '{"permissions":{"deny":["Bash(rm:*)"]}}';
    const base = installing([['package.json', JSON.stringify({ name: '@fx/a', version: '1.0.0' })], ...PLUGIN_TREE]);
    const c: VerbCase = {
      ...base,
      fixture: (r) => {
        base.fixture(r);
        writeTree(claude(r), [['settings.json', settings]]);
        createSymlink(cap, '../../../settings.json', safePath.join(r.root, 'input', 'pkg', 'dist', '.claude', 'plugins', 'marketplaces', 'acme', '.vat-marketplace'), 'file');
      },
    };

    const { r, outcome, before } = await runWith(c);

    expect(outcome, outcome.message).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE', claimsFinished: false });
    expect(outcome.message).toContain('.vat-marketplace');
    expect(readFileSync(safePath.join(claude(r), 'settings.json'), 'utf8')).toBe(settings);
    expect(diffSnapshots(before, snapshotTree(claude(r)))).toEqual([]);
  });

  it('installs a .zip under the name its SKILL.md declares, as a directory is', async () => {
    const c: VerbCase = {
      ...pluginInstallCase('local', 'fresh'),
      argv: (r) => ['install', safePath.join(r.root, 'input', 'download-123.zip')],
      fixture: (r) => {
        mkdirSyncReal(safePath.join(r.root, 'input'), { recursive: true });
        writeZipFixture(safePath.join(r.root, 'input'), 'download-123.zip', [['SKILL.md', Buffer.from('---\nname: real-name\ndescription: d\n---\n')]]);
      },
    };

    const { r, outcome } = await runWith(c);

    expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
    expect(readdirSync(safePath.join(claude(r), 'skills'))).toEqual(['real-name']);
  });
});
