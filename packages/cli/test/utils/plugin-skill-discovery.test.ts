/* eslint-disable security/detect-non-literal-fs-filename */
import { writeFile } from 'node:fs/promises';

import { mkdirSyncReal, safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverPluginLocalSkills } from '../../src/commands/skills/plugin-skill-discovery.js';
import { createTempDirTracker } from '../system/test-common.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plocal-');

function fm(name: string): string {
  return `---\nname: ${name}\ndescription: A plugin-local skill used in test fixtures for validation.\n---\n\n# ${name}\n`;
}

describe('discoverPluginLocalSkills', () => {
  afterEach(() => cleanupTempDirs());

  it('finds SKILL.md under plugins/<name>/skills/**/', async () => {
    const root = createTempDir();
    mkdirSyncReal(safePath.join(root, 'plugins', 'p1', 'skills', 'helper'), { recursive: true });
    await writeFile(
      safePath.join(root, 'plugins', 'p1', 'skills', 'helper', 'SKILL.md'),
      fm('helper'),
    );

    const result = await discoverPluginLocalSkills({ projectRoot: root, pluginNames: ['p1'] });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('helper');
    expect(result[0]?.plugin).toBe('p1');
  });

  it('discovers skills even when the file is gitignored', async () => {
    const root = createTempDir();
    mkdirSyncReal(safePath.join(root, 'plugins', 'p1', 'skills', 'hidden'), { recursive: true });
    // Init git repo so respectGitignore takes effect via git ls-files.
    safeExecSync('git', ['init', '-q'], { cwd: root });
    safeExecSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    safeExecSync('git', ['config', 'user.name', 't'], { cwd: root });
    // Commit a visible file first so the repo is non-empty.
    await writeFile(safePath.join(root, 'README.md'), '# r');
    safeExecSync('git', ['add', '-A'], { cwd: root });
    safeExecSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
    // Now add the gitignored SKILL.md.
    await writeFile(safePath.join(root, '.gitignore'), 'plugins/p1/skills/hidden/\n');
    await writeFile(
      safePath.join(root, 'plugins', 'p1', 'skills', 'hidden', 'SKILL.md'),
      fm('hidden'),
    );

    const warnings: string[] = [];
    const result = await discoverPluginLocalSkills({
      projectRoot: root,
      pluginNames: ['p1'],
      warn: (m) => warnings.push(m),
    });
    expect(result).toHaveLength(1);
    expect(warnings.some((w) => w.includes('gitignore'))).toBe(true);
  });

  it('honors source override per plugin', async () => {
    const root = createTempDir();
    mkdirSyncReal(safePath.join(root, 'custom', 'path', 'skills', 's1'), { recursive: true });
    await writeFile(safePath.join(root, 'custom', 'path', 'skills', 's1', 'SKILL.md'), fm('s1'));

    const result = await discoverPluginLocalSkills({
      projectRoot: root,
      pluginNames: ['p1'],
      sourceOverrides: { p1: 'custom/path' },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.sourcePath).toContain('custom/path/skills/s1/SKILL.md');
  });

  it('returns empty array when plugin dir does not exist', async () => {
    const root = createTempDir();
    const result = await discoverPluginLocalSkills({
      projectRoot: root,
      pluginNames: ['missing'],
    });
    expect(result).toEqual([]);
  });

  it('dedupes when the same plugin name is listed twice', async () => {
    const root = createTempDir();
    mkdirSyncReal(safePath.join(root, 'plugins', 'p1', 'skills', 'shared'), { recursive: true });
    await writeFile(
      safePath.join(root, 'plugins', 'p1', 'skills', 'shared', 'SKILL.md'),
      fm('shared'),
    );
    const a = await discoverPluginLocalSkills({ projectRoot: root, pluginNames: ['p1', 'p1'] });
    expect(a.filter((s) => s.name === 'shared')).toHaveLength(1);
  });
});
