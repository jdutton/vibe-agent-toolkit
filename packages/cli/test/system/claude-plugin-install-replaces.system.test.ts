// Test files legitimately use dynamic file paths

/**
 * System tests for `vat claude plugin install` of a package that declares `vat.replaces`: what it
 * names is refused before anything changes, or replaced inside the install's one transaction.
 */

import * as fs from 'node:fs';
import { chmodSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, tmpdirFoldsCase } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirTracker, getBinPath, writeTestFile } from './test-common.js';
import {
  createInstallTestContext,
  expectInputRefusal,
  installedKeys,
  plantFile,
  PLUGINS_MARKETPLACES,
  reinstallOverLockedEntry,
  runPluginInstall,
  setupPluginTestProject,
  setupReplacesCase,
} from './test-helpers/plugin-install-setup.js';

describe('claude plugin install — vat.replaces (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-install-replaces-test-');

  afterEach(() => {
    cleanupTempDirs();
  });

  // `vat.replaces.plugins` was uninstalled BEFORE a bad `vat.replaces.flatSkills` entry was refused,
  // so the refused run had already removed the user's plugin and installed nothing in its place.
  it('refuses a vat.replaces.flatSkills entry that is not one path segment before uninstalling any replaced plugin', async () => {
    const { fakeHome, claudeDir, projectDir } = await setupReplacesCase(binPath, createTempDir, { plugins: ['old-plugin'], flatSkills: ['../victim'] });

    await expectInputRefusal(binPath, fakeHome, [projectDir], ['nothing was changed', 'vat.replaces.flatSkills']);
    expect(installedKeys(claudeDir)).toEqual(['old-plugin@r-market']);
    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'r-market', 'plugins', 'old-plugin', 'skills', 'old-skill', 'SKILL.md'))).toBe(true);
  });

  // `vat.replaces` was never shape-checked: a string `flatSkills` crashed (INTERNAL_ERROR), a
  // non-string entry crashed, and a string `plugins` was walked letter by letter — each letter
  // uninstalled as a plugin name.
  it.each([
    ['a string flatSkills', { flatSkills: 'legacy' }, 'vat.replaces.flatSkills'],
    ['a non-string flatSkills entry', { flatSkills: [123] }, 'vat.replaces.flatSkills.0'],
    ['a string plugins', { plugins: 'old-plugin' }, 'vat.replaces.plugins'],
    ['an unknown key', { flatskills: ['legacy'] }, 'flatskills'],
  ])('refuses %s as INPUT_UNREADABLE naming the field, before anything changes', async (_label, replaces, field) => {
    const { fakeHome, claudeDir, projectDir, legacySkill } = await setupReplacesCase(binPath, createTempDir, replaces, false);
    // `l`, `e`, `g`… are what a letter-by-letter walk of "legacy" removed.
    plantFile(safePath.join(claudeDir, 'skills', 'l', 'SKILL.md'), '# l\n');

    await expectInputRefusal(binPath, fakeHome, [projectDir], ['@test/my-plugin-pkg', field]);
    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES))).toBe(false);
    expect(fs.existsSync(legacySkill)).toBe(true);
    expect(fs.existsSync(safePath.join(claudeDir, 'skills', 'l', 'SKILL.md'))).toBe(true);
  });

  // The replaced plugin and the legacy flat skill were removed BEFORE the marketplace copy, so a
  // copy that then failed left the user with neither the old nor the new.
  it.skipIf(CANNOT_DENY_READS)('refuses a package it cannot read before removing what it replaces', async () => {
    const { fakeHome, claudeDir, marketplacesDir, projectDir, legacySkill } = await setupReplacesCase(
      binPath, createTempDir, { plugins: ['old-plugin'], flatSkills: ['legacy'] },
    );
    const unreadable = safePath.join(marketplacesDir, 'r-market', 'plugins', 'new-plugin', 'skills', 'new-skill', 'secret.md');
    plantFile(unreadable, 'x');
    chmodSync(unreadable, 0o000);
    try {
      await expectInputRefusal(binPath, fakeHome, [projectDir], ['secret.md']);
      expect(installedKeys(claudeDir)).toEqual(['old-plugin@r-market']);
      expect(fs.existsSync(legacySkill)).toBe(true);
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });

  // A legacy flat skill the OS would not let it remove was INTERNAL_ERROR, after the replaced
  // plugin was already uninstalled and before anything new was installed. Its removal is now part
  // of the install's one transaction: moved aside, then removed whatever its modes.
  it.skipIf(CANNOT_DENY_READS)('removes a legacy flat skill holding a read-only directory in the install\'s own transaction, exit 0', async () => {
    const { fakeHome, claudeDir, projectDir } = await setupReplacesCase(
      binPath, createTempDir, { plugins: ['old-plugin'], flatSkills: ['legacy'] },
    );

    const { status, report } = await reinstallOverLockedEntry(binPath, fakeHome, projectDir, {
      parentDir: safePath.join(claudeDir, 'skills'), entry: 'legacy', lockedRel: ['ro'],
    });

    expect(status, JSON.stringify(report)).toBe(0);
    expect(fs.readdirSync(safePath.join(claudeDir, 'skills'))).toEqual([]);
    expect(installedKeys(claudeDir)).toEqual(['new-plugin@r-market']);
    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'r-market', 'plugins', 'new-plugin', 'skills', 'new-skill', 'SKILL.md'))).toBe(true);
  });

  // `vat.replaces` runs after the install. A package renaming `Old` → `old` that replaces `Old`
  // then uninstalled `Old@mp` — on a case-insensitive filesystem the very directories it had just
  // installed — exit 0, status ok, registry dangling. Only a folding filesystem has the alias;
  // the uninstall's identity decision is pinned on every filesystem by a linked-marketplace unit test.
  it.skipIf(!tmpdirFoldsCase())('keeps the plugin it installed when vat.replaces names it in another letter case', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const v1 = setupPluginTestProject(tempDir, 'v1', 'case-market', [{ name: 'Old', skills: ['s1'] }]);
    await runPluginInstall(binPath, v1.projectDir, fakeHome);
    const v2 = setupPluginTestProject(tempDir, 'v2', 'case-market', [{ name: 'old', skills: ['s1'] }]);
    writeTestFile(safePath.join(v2.projectDir, 'package.json'), JSON.stringify({ name: '@test/my-plugin-pkg', version: '2.0.0', vat: { replaces: { plugins: ['Old'] } } }));

    await runPluginInstall(binPath, v2.projectDir, fakeHome);

    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'case-market', 'plugins', 'old', 'skills', 's1', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(safePath.join(claudeDir, 'plugins', 'cache', 'case-market', 'old', '2.0.0'))).toBe(true);
    expect(installedKeys(claudeDir)).toEqual(['old@case-market']);
  });
});
