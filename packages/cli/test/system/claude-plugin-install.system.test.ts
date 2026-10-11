// Test files legitimately use dynamic file paths

/**
 * System tests for `vat claude plugin install` command.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { chmodSync } from 'node:fs';


import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, resolveExecutable } from '@vibe-agent-toolkit/utils/testing';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

import { tarballOf } from '../helpers/tarball.js';

import {
  createTempDirTracker,
  executeCliAndParseYaml,
  fakeHomeEnv,
  getBinPath,
  writeTestFile,
} from './test-common.js';
import {
  createInstallTestContext,
  expectInputRefusal,
  plantFile,
  PLUGINS_MARKETPLACES,
  reinstallOverLockedEntry,
  runInstall,
  runPluginInstall,
  setupPluginTestProject,
} from './test-helpers/plugin-install-setup.js';

const TEMP_DIR_PREFIX = 'vat-plugin-install-test-';

const MULTI_MARKET = 'multi-market';
const SKILL_ALPHA = 'skill-alpha';
const SKILL_BETA = 'skill-beta';

describe('claude plugin install command (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('installs from local directory with plugin tree', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'pkg-local', 'test-market', [
      { name: 'my-skill' },
    ]);

    await runPluginInstall(binPath, projectDir, fakeHome);

    expect(
      fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'test-market', 'plugins', 'my-skill'))
    ).toBe(true);

    const installed = JSON.parse(
      fs.readFileSync(safePath.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8')
    ) as { plugins: Record<string, unknown> };
    expect(Object.keys(installed.plugins)).toContain('my-skill@test-market');
  });

  it('refuses --target claude.ai as NOT_IMPLEMENTED, exit 2', async () => {
    const tempDir = createTempDir();

    const { status, report } = await runInstall(binPath, safePath.join(tempDir, 'home'), ['npm:@test/fake', '--target', 'claude.ai']);

    // The command cannot do what was asked; it is not a finding about a skill.
    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'NOT_IMPLEMENTED' } });
  });

  it('refuses an unknown --target as USAGE_INVALID, exit 2', async () => {
    const tempDir = createTempDir();

    const { status, report } = await runInstall(binPath, safePath.join(tempDir, 'home'), ['npm:@test/fake', '--target', 'bogus']);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
  });

  it('refuses a missing source as USAGE_INVALID, never INTERNAL_ERROR', async () => {
    const tempDir = createTempDir();

    const { status, report } = await runInstall(binPath, safePath.join(tempDir, 'home'), []);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
  });

  it('refuses a source path that names nothing as USAGE_INVALID', async () => {
    const tempDir = createTempDir();

    const { status, report } = await runInstall(binPath, safePath.join(tempDir, 'home'), [safePath.join(tempDir, 'never-created')]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
  });

  // One transaction: a later skill that refuses means none is installed — the report used to list
  // skill 1 as on disk while the run refused on skill 2.
  it('installs no skill when a later one refuses, and says to pass --force', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const packageDir = safePath.join(tempDir, 'two-skills');
    plantFile(safePath.join(packageDir, 'package.json'), JSON.stringify({ name: '@test/two', version: '1.0.0', vat: { skills: [SKILL_ALPHA, SKILL_BETA] } }));
    for (const skill of [SKILL_ALPHA, SKILL_BETA]) plantFile(safePath.join(packageDir, 'dist', 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
    // Skill 2 of 2 is already installed and --force is not passed.
    plantFile(safePath.join(claudeDir, 'skills', SKILL_BETA, 'SKILL.md'), '# already here\n');

    const { status, report } = await runInstall(binPath, fakeHome, [packageDir]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' }, data: null });
    expect(report.error?.message).toContain('--force');
    expect(fs.existsSync(safePath.join(claudeDir, 'skills', SKILL_ALPHA))).toBe(false);
  });

  it('refuses a plugin it could not register as INPUT_UNREADABLE — never ok — before anything is copied', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir } = setupPluginTestProject(tempDir, 'unregistrable', 'reg-market', [{ name: 'reg-plugin', skills: ['reg-skill'] }]);
    // settings.json is present and not JSON: registration cannot enable the plugin.
    plantFile(safePath.join(claudeDir, 'settings.json'), '{ "enabledPlugins": ');

    const { status, report } = await runInstall(binPath, fakeHome, [projectDir]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
    expect(fs.readFileSync(safePath.join(claudeDir, 'settings.json'), 'utf-8')).toBe('{ "enabledPlugins": ');
    // The registry is read when the install is planned: nothing was copied, and the report says so.
    expect(report.data).toBeNull();
    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES))).toBe(false);
  });

  // The skills directory is where the install WRITES (its destination, `-s`), not an input: a refused
  // examination of it is the run not finishing (the refusal table's destination row), never the input's.
  it.skipIf(CANNOT_DENY_READS)('refuses a skills directory it cannot examine as RUN_INCOMPLETE, never INTERNAL_ERROR', async () => {
    const { tempDir, fakeHome } = createInstallTestContext(createTempDir);
    const skillDir = safePath.join(tempDir, 'locked-target-skill');
    plantFile(safePath.join(skillDir, 'SKILL.md'), '---\nname: locked-target\ndescription: A skill.\n---\n\n# locked-target\n');
    const lockedSkillsDir = safePath.join(tempDir, 'locked-skills');
    mkdirSyncReal(lockedSkillsDir, { recursive: true });
    chmodSync(lockedSkillsDir, 0o000);
    try {
      const { status, report } = await runInstall(binPath, fakeHome, [skillDir, '-s', lockedSkillsDir]);

      expect(status).toBe(2);
      expect(report).toMatchObject({ status: 'error', error: { code: 'RUN_INCOMPLETE' }, data: null });
      expect(report.error?.message).toContain(lockedSkillsDir);
    } finally {
      chmodSync(lockedSkillsDir, 0o755);
    }
  });

  // The one special-file policy at the verb: a pipe in the package is the package's entry, refused
  // unopened before anything under ~/.claude changes. A copy of it would block until a writer appears.
  it.skipIf(process.platform === 'win32')('refuses a named pipe in the plugin tree as INPUT_UNREADABLE without blocking, changing nothing (mkfifo is POSIX-only)', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir, marketplacesDir } = setupPluginTestProject(tempDir, 'piped', 'fifo-market', [{ name: 'fifo-plugin', skills: ['fifo-skill'] }]);
    const fifo = safePath.join(marketplacesDir, 'fifo-market', 'plugins', 'fifo-plugin', 'skills', 'fifo-skill', 'zpipe');
    execFileSync(resolveExecutable('mkfifo'), [fifo]);
    // A run that blocked on the pipe is released after a while (opening read-write never blocks, and is a
    // writer), so a regression fails on the assertions below instead of hanging the suite.
    const release = setTimeout(() => fs.closeSync(fs.openSync(fifo, 'r+')), 5000);
    try {
      const { status, report } = await runInstall(binPath, fakeHome, [projectDir]);
      expect(status).toBe(2);
      expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
    } finally {
      clearTimeout(release);
    }
    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES))).toBe(false);
  });

  it('refuses a marketplace copy that failed as RUN_INCOMPLETE, never INTERNAL_ERROR', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir } = setupPluginTestProject(tempDir, 'uncopyable', 'copy-market', [{ name: 'copy-plugin', skills: ['copy-skill'] }]);
    // A FILE where the marketplaces directory must go: the copy cannot land.
    plantFile(safePath.join(claudeDir, PLUGINS_MARKETPLACES), 'not a directory');

    const { status, report } = await runInstall(binPath, fakeHome, [projectDir]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'RUN_INCOMPLETE' } });
  });

  it('publishes an ok report with no skills when --npm-postinstall is not a global npm install', async () => {
    const tempDir = createTempDir();
    const fakeHome = safePath.join(tempDir, 'home');
    mkdirSyncReal(fakeHome, { recursive: true });

    // Build env without npm_config_global so isGlobalNpmInstall() returns false
    const { status, output, report } = await runInstall(binPath, fakeHome, ['--npm-postinstall'], { npm_lifecycle_event: '', npm_command: '' });

    // A skip is an answer — an `npm install -g` must never fail on it.
    expect(status).toBe(0);
    expect(report).toMatchObject({ status: 'ok', examined: 1, data: { sourceType: 'npm-postinstall', skills: [] } });
    expect(output).toContain('Skipping');
  });

  it('installs multiple plugins from a single project directory', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'multi-pkg', MULTI_MARKET, [
      { name: SKILL_ALPHA },
      { name: SKILL_BETA },
    ]);

    await runPluginInstall(binPath, projectDir, fakeHome);

    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, MULTI_MARKET, 'plugins', SKILL_ALPHA))).toBe(true);
    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, MULTI_MARKET, 'plugins', SKILL_BETA))).toBe(true);
  });

  it('installs from npm tarball (.tgz) with plugin tree', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'pkg-tgz', 'tgz-market', [
      { name: 'tgz-skill' },
    ]);

    // Create tarball in npm pack format: all files under package/ prefix
    const tgzPath = safePath.join(tempDir, 'my-pkg-1.0.0.tgz');
    await tar.create({ gzip: true, file: tgzPath, cwd: projectDir, prefix: 'package' }, ['.']);

    await runPluginInstall(binPath, tgzPath, fakeHome);
    expect(
      fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'tgz-market', 'plugins', 'tgz-skill'))
    ).toBe(true);
  });

  it('reinstall overwrites existing plugin tree', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'overwrite-pkg', 'ow-market', [
      { name: 'ow-skill' },
    ]);

    // First install
    const first = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'install', projectDir], {
      env: fakeHomeEnv(fakeHome),
    });
    expect(first.result.status).toBe(0);

    // Modify the skill file so we can detect the overwrite
    const installedSkillDir = safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'ow-market', 'plugins', 'ow-skill');
    fs.writeFileSync(safePath.join(installedSkillDir, 'extra-sentinel.txt'), 'sentinel');

    // Second install (should overwrite — marketplace dir is rm-ed and re-copied)
    const second = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'install', projectDir], {
      env: fakeHomeEnv(fakeHome),
    });
    expect(second.result.status).toBe(0);

    // After reinstall the skill dir should exist but the sentinel should be gone
    expect(fs.existsSync(installedSkillDir)).toBe(true);
    expect(fs.existsSync(safePath.join(installedSkillDir, 'extra-sentinel.txt'))).toBe(false);
  });

  it('reports every installed skill when plugin has skills/ subdirectory', async () => {
    // Regression test: installPluginTreeAndExit previously passed [] to outputInstallSuccess
    // regardless of how many skills were actually copied, always reporting no installed skills.
    const { tempDir, fakeHome } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'pkg-skills-count', 'skills-market', [
      { name: 'my-plugin', skills: [SKILL_ALPHA, SKILL_BETA, 'skill-gamma'] },
    ]);

    const report = await runPluginInstall(binPath, projectDir, fakeHome);

    expect(report.data?.skills).toHaveLength(3);
    const skillNames = (report.data?.skills ?? []).map(s => s.name);
    expect(skillNames).toContain(SKILL_ALPHA);
    expect(skillNames).toContain(SKILL_BETA);
    expect(skillNames).toContain('skill-gamma');
  });

  it('installs a plain skill directory under its declared name, not the directory leaf', async () => {
    // The package.json branch of this same command installs each skill under
    // the name declared in `vat.skills`; the plain-directory branch used the
    // directory leaf, so one command answered "what is this skill called?" two
    // different ways depending on which branch it took.
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const skillDir = safePath.join(tempDir, 'checkout-folder');
    mkdirSyncReal(skillDir, { recursive: true });
    writeTestFile(
      safePath.join(skillDir, 'SKILL.md'),
      '---\nname: declared-skill\ndescription: Declares a name unlike its folder.\n---\n\n# declared-skill\n',
    );

    const report = await runPluginInstall(binPath, skillDir, fakeHome);

    expect(report.data?.skills[0]?.name).toBe('declared-skill');
    expect(fs.existsSync(safePath.join(claudeDir, 'skills', 'declared-skill', 'SKILL.md'))).toBe(
      true,
    );
    expect(fs.existsSync(safePath.join(claudeDir, 'skills', 'checkout-folder'))).toBe(false);
  });

  // A directory with no plugin tree, no package.json and no SKILL.md is not a skill: it used to
  // be copied whole into ~/.claude/skills and reported installed (`vat skills install` refuses it).
  it('refuses a plain directory with no SKILL.md as USAGE_INVALID, installing nothing', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const docsDir = safePath.join(tempDir, 'docs');
    plantFile(safePath.join(docsDir, 'README.md'), '# not a skill\n');

    const { status, report } = await runInstall(binPath, fakeHome, [docsDir]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
    expect(report.error?.message).toContain('No SKILL.md');
    expect(report.error?.message).toContain(docsDir);
    expect(fs.existsSync(safePath.join(claudeDir, 'skills', 'docs'))).toBe(false);
  });

  // `new AdmZip()` threw uncoded (INTERNAL_ERROR) — and only AFTER --force had removed the skill
  // it was about to replace.
  it('refuses a .zip that is not a zip as INPUT_UNREADABLE, naming it, and keeps the skill --force would replace', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const notZip = safePath.join(tempDir, 'bad-skill.zip');
    writeTestFile(notZip, 'hi\n');
    const existing = safePath.join(claudeDir, 'skills', 'bad-skill', 'SKILL.md');
    plantFile(existing, '# keep me\n');

    const { status, report } = await runInstall(binPath, fakeHome, [notZip, '--force']);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
    expect(report.error?.message).toContain(notZip);
    expect(fs.readFileSync(existing, 'utf-8')).toBe('# keep me\n');
  });

  // adm-zip reads only the central directory when it opens an archive; entry data is inflated
  // in `extractAllTo` — which ran AFTER --force had removed the skill, and threw uncoded.
  it('refuses a .zip whose entry data is corrupt as INPUT_UNREADABLE, and keeps the skill --force would replace', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# crc\n'.repeat(200)));
    const bytes = zip.toBuffer();
    // Inside the first entry's data: past its 30-byte local header and its name.
    const dataStart = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    for (const offset of [dataStart + 2, dataStart + 3]) bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;
    const corrupt = safePath.join(tempDir, 'crc.zip');
    fs.writeFileSync(corrupt, bytes);
    const existing = safePath.join(claudeDir, 'skills', 'crc', 'SKILL.md');
    plantFile(existing, '# previous\n');

    const { status, report } = await runInstall(binPath, fakeHome, [corrupt, '--force']);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
    expect(report.error?.message).toContain(corrupt);
    expect(fs.readFileSync(existing, 'utf-8')).toBe('# previous\n');
  });


  // The package's `plugins/` directory was listed raw — twice, before the readable-source check
  // could run — so one the OS would not list surfaced as INTERNAL_ERROR, not the input's refusal.
  it.skipIf(CANNOT_DENY_READS).each([
    ['copy', (projectDir: string) => [projectDir]],
    ['--dev', (projectDir: string) => ['--dev', '--cwd', projectDir]],
  ])('refuses a package whose plugins directory cannot be listed as INPUT_UNREADABLE (%s)', async (_lane, argsFor) => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir, marketplacesDir } = setupPluginTestProject(tempDir, 'locked-pkg', 'l-market', [{ name: 'l-plugin', skills: ['l-skill'] }]);
    const pluginsDir = safePath.join(marketplacesDir, 'l-market', 'plugins');
    chmodSync(pluginsDir, 0o000);
    try {
      await expectInputRefusal(binPath, fakeHome, argsFor(projectDir), [pluginsDir]);
      expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES))).toBe(false);
    } finally {
      chmodSync(pluginsDir, 0o755);
    }
  });

  // The pre-read inflates every entry, but a file `a` beside a file `a/b` fails only at
  // EXTRACTION — which ran in place, after --force had removed the skill being replaced.
  it('refuses a .zip that cannot be extracted as INPUT_UNREADABLE, and keeps the skill --force would replace', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const zip = new AdmZip();
    zip.addFile('a', Buffer.from('file a\n'));
    zip.addFile('a/b', Buffer.from('file a/b\n'));
    const clash = safePath.join(tempDir, 'clash.zip');
    zip.writeZip(clash);
    const existing = safePath.join(claudeDir, 'skills', 'clash', 'SKILL.md');
    plantFile(existing, '# precious\n');

    await expectInputRefusal(binPath, fakeHome, [clash, '--force'], [clash]);
    expect(fs.readdirSync(safePath.join(claudeDir, 'skills', 'clash'))).toEqual(['SKILL.md']);
    expect(fs.readFileSync(existing, 'utf-8')).toBe('# precious\n');
  });

  // node-tar turns an entry it cannot write into a WARNING and resolves: a `.tgz` holding a file
  // `a` beside a file `a/b` installed without `a/b`, exit 0. A tarball it cannot read at all
  // escaped uncoded. Both are the archive's, refused before --force removes anything.
  it.each([
    ['holds a file `a` beside a file `a/b`', [['package/a', 'A'], ['package/a/b', 'B']]],
    ['is not a tarball', undefined],
  ] as const)('refuses a .tgz that %s as INPUT_UNREADABLE, naming it, and keeps the skill --force would replace', async (_label, clash) => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const archive = safePath.join(tempDir, 't-pkg-1.0.0.tgz');
    fs.writeFileSync(archive, clash === undefined ? 'not a tarball, only text\n' : tarballOf([
      ['package/package.json', JSON.stringify({ name: '@test/t-pkg', version: '1.0.0', vat: { skills: ['t-skill'] } })],
      ['package/dist/skills/t-skill/SKILL.md', '# replacement\n'],
      ...clash,
    ]));
    const existing = safePath.join(claudeDir, 'skills', 't-skill', 'SKILL.md');
    plantFile(existing, '# precious\n');

    await expectInputRefusal(binPath, fakeHome, [archive, '--force'], [archive]);
    expect(fs.readFileSync(existing, 'utf-8')).toBe('# precious\n');
  });

  // VAT's own staging directory could not be made: `mkdtemp` sat outside the extraction's catch, so
  // an unwritable or full $TMPDIR was INTERNAL_ERROR — and inside it, it would have blamed the archive.
  it.skipIf(CANNOT_DENY_READS)('reports a staging directory it cannot create as RUN_INCOMPLETE, and keeps the skill --force would replace', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# good\n'));
    const good = safePath.join(tempDir, 'good.zip');
    zip.writeZip(good);
    const existing = safePath.join(claudeDir, 'skills', 'good', 'SKILL.md');
    plantFile(existing, '# precious\n');
    const lockedTmp = safePath.join(tempDir, 'locked-tmp');
    mkdirSyncReal(lockedTmp);
    chmodSync(lockedTmp, 0o555);
    try {
      const { status, report } = await runInstall(binPath, fakeHome, [good, '--force'], { TMPDIR: lockedTmp, TEMP: lockedTmp, TMP: lockedTmp });

      expect(status).toBe(2);
      expect(report).toMatchObject({ status: 'error', error: { code: 'RUN_INCOMPLETE' } });
      expect(report.error?.message).toContain(lockedTmp);
      expect(fs.readFileSync(existing, 'utf-8')).toBe('# precious\n');
    } finally {
      chmodSync(lockedTmp, 0o755);
    }
  });

  // The marketplace copy was rm -rf, mkdir, copy: one entry the OS would not let it remove
  // failed the run with the user's marketplace already half-deleted (its manifest gone). A
  // read-only directory in the previous tree (an older build's copy of a read-only plugin) is now
  // made writable and removed with it: the replace is whole, and nothing is left beside it.
  it.skipIf(CANNOT_DENY_READS)('replaces an installed marketplace holding a read-only directory whole, by staging and swapping, leaving nothing beside it', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir } = setupPluginTestProject(tempDir, 'swap-pkg', 's-market', [{ name: 's-plugin', skills: ['s-skill'] }]);
    plantFile(safePath.join(projectDir, 'dist', '.claude', 'plugins', 'marketplaces', 's-market', '.claude-plugin', 'marketplace.json'), '{}');
    await runPluginInstall(binPath, projectDir, fakeHome);
    const marketplacesDir = safePath.join(claudeDir, PLUGINS_MARKETPLACES);

    const { status, report } = await reinstallOverLockedEntry(binPath, fakeHome, projectDir, {
      parentDir: marketplacesDir, entry: 's-market', lockedRel: ['plugins', 's-plugin', 'ro'],
    });

    expect(status, JSON.stringify(report)).toBe(0);
    expect(fs.existsSync(safePath.join(marketplacesDir, 's-market', '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(fs.existsSync(safePath.join(marketplacesDir, 's-market', 'plugins', 's-plugin', 'ro'))).toBe(false);
    expect(report.findings).toEqual([]);
    expect(fs.readdirSync(marketplacesDir)).toEqual(['s-market']);
  });

  // The version (and plugin/marketplace names) come from the PACKAGE: one that cannot name a
  // directory under ~/.claude is the input's fault, and is refused before the marketplace copy
  // replaces what the previous install left — which used to happen first, leaving a half-replaced tree.
  it.each([
    ['a version that climbs out of the cache', '../../../../victim'],
    ['a dot-led version inventory would hide', '.1'],
  ])('refuses a package with %s as INPUT_UNREADABLE, before changing anything', async (_label, badVersion) => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir } = setupPluginTestProject(tempDir, 'good-pkg', 'v-market', [{ name: 'v-plugin', skills: ['v-skill'] }]);
    await runPluginInstall(binPath, projectDir, fakeHome);
    const installedSkill = safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'v-market', 'plugins', 'v-plugin', 'skills', 'v-skill', 'SKILL.md');
    const before = fs.readFileSync(installedSkill, 'utf-8');
    const hostile = setupPluginTestProject(tempDir, 'hostile-pkg', 'v-market', [{ name: 'v-plugin', skills: ['v-skill'] }]);
    writeTestFile(safePath.join(hostile.projectDir, 'package.json'), JSON.stringify({ name: '@test/my-plugin-pkg', version: badVersion }));
    writeTestFile(safePath.join(hostile.marketplacesDir, 'v-market', 'plugins', 'v-plugin', 'skills', 'v-skill', 'SKILL.md'), '# hostile body');

    const { status, report } = await runInstall(binPath, fakeHome, [hostile.projectDir]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
    expect(fs.readFileSync(installedSkill, 'utf-8')).toBe(before);
    expect(fs.existsSync(safePath.join(tempDir, 'victim'))).toBe(false);
  });

  // An older build copied a read-only plugin's modes into the cache: a previous version its owner
  // could not empty used to be left beside the new one. It is now made writable and removed. (A leftover
  // the OS truly refuses is a TREE_CLEANUP_INCOMPLETE warning: the tree-change applier's tests inject one.)
  it.skipIf(CANNOT_DENY_READS)('replaces a previous cache holding a read-only directory whole, exit 0, with nothing left beside it', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir } = setupPluginTestProject(tempDir, 'cleanup-pkg', 'c-market', [{ name: 'c-plugin', skills: ['c-skill'] }]);
    await runPluginInstall(binPath, projectDir, fakeHome);
    const versionsDir = safePath.join(claudeDir, 'plugins', 'cache', 'c-market', 'c-plugin');

    const { status, report } = await reinstallOverLockedEntry(binPath, fakeHome, projectDir, {
      parentDir: versionsDir, entry: '1.2.3', lockedRel: ['locked'],
    });

    expect(status, JSON.stringify(report)).toBe(0);
    expect(report.findings).toEqual([]);
    expect(fs.readdirSync(versionsDir)).toEqual(['1.2.3']);
  });

  // A plugin directory the package ships read-only (here through a link, so the cache copy reads
  // the 0555 directory itself): the install used to abort the process (SIGABRT, no report).
  it.skipIf(CANNOT_DENY_READS)('installs a read-only plugin directory, exit 0, and leaves no staging directory', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir, marketplacesDir } = setupPluginTestProject(tempDir, 'ro-pkg', 'ro-market', [{ name: 'ro-plugin', skills: ['ro-skill'] }]);
    const pluginLink = safePath.join(marketplacesDir, 'ro-market', 'plugins', 'ro-plugin');
    const readOnly = safePath.join(tempDir, 'ro-source');
    fs.renameSync(pluginLink, readOnly);
    createSymlink(cap, readOnly, pluginLink, 'dir');
    chmodSync(readOnly, 0o555);
    const versionsDir = safePath.join(claudeDir, 'plugins', 'cache', 'ro-market', 'ro-plugin');
    try {
      const { status, report } = await runInstall(binPath, fakeHome, [projectDir]);

      expect(status, JSON.stringify(report)).toBe(0);
      expect(fs.readdirSync(versionsDir)).toEqual(['1.2.3']);
    } finally {
      chmodSync(readOnly, 0o755);
      if (fs.existsSync(versionsDir)) {
        for (const entry of fs.readdirSync(versionsDir)) chmodSync(safePath.join(versionsDir, entry), 0o755);
      }
    }
  });
});
