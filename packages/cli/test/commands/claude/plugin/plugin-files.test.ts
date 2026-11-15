import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { applyPluginFiles, pluginFilesDest } from '../../../../src/commands/claude/plugin/plugin-files.js';
import { createTempDirTracker } from '../../../system/test-common.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-files-');

async function setupStub(): Promise<{ root: string; out: string }> {
  const root = createTempDir();
  const out = safePath.join(root, 'out', 'p1');
  mkdirSyncReal(out, { recursive: true });
  await writeFile(safePath.join(root, 'src.bin'), '');
  return { root, out };
}

/** The refusal `pluginFilesDest` raises for `dest`; a dest it accepts is reported as `landed`. */
function refused(dest: string): { refusal?: unknown; message?: string; landed?: string } {
  try {
    return { landed: pluginFilesDest(dest) };
  } catch (error) {
    return { refusal: (error as { refusal?: unknown }).refusal, message: (error as Error).message };
  }
}

describe('pluginFilesDest — where a files[].dest lands, not how it is spelled', () => {
  it.each([
    ['hooks/h.mjs', 'hooks/h.mjs'],
    ['./hooks//h.mjs', 'hooks/h.mjs'],
    [String.raw`hooks\h.mjs`, 'hooks/h.mjs'],
    ['a/b/../c.md', 'a/c.md'],
    ['skills-extra/x.md', 'skills-extra/x.md'],
    ['docs/skills/x.md', 'docs/skills/x.md'],
    ['.claude-plugin/extra.json', '.claude-plugin/extra.json'],
    ['.claude-plugin/plugin.jsonx', '.claude-plugin/plugin.jsonx'],
    ['skillsı/x.md', 'skillsı/x.md'],
    ['Hooks/H.mjs', 'Hooks/H.mjs'],
  ])('%s lands at %s', (dest, landed) => {
    expect(pluginFilesDest(dest)).toBe(landed);
  });

  it.each([
    'skills', 'skills/x.md', './skills/x.md', 'docs/../skills/x.md', String.raw`.\skills\x.md`,
    // One name where the filesystem folds it: letter case, Unicode form (a fullwidth `s`, U+FF53),
    // and the trailing dots and spaces Windows drops.
    'Skills/x.md', 'SKILLS/x.md', `${String.fromCodePoint(0xff53)}kills/x.md`, 'skills./x.md', 'skills /x.md', 'skills. ./x.md',
    // NTFS: the directory by its stream name, and a dotless `ı` (U+0131), which it upper-cases to `I`.
    'skills::$INDEX_ALLOCATION/x.md', `sk${String.fromCodePoint(0x131)}lls/x.md`,
    // Cut at the `:` on every host, so a POSIX directory really named `skills:notes` is refused too.
    'skills:notes/x.md',
  ])('%s is inside skills/', (dest) => {
    expect(refused(dest)).toMatchObject({ refusal: 'CONFIG_INVALID', message: expect.stringContaining(`"${dest}" resolves inside skills/`) as unknown });
  });

  it.each(['.claude-plugin/plugin.json', './.claude-plugin/plugin.json', '.claude-plugin/x/../plugin.json', '.Claude-Plugin/PLUGIN.json', '.claude-plugin/plugin.json.', '.claude-plugin/plugin.json/x', '.claude-plugin:x/plugin.json'])(
    '%s is the generated plugin.json',
    (dest) => {
      expect(refused(dest)).toMatchObject({ refusal: 'CONFIG_INVALID', message: expect.stringContaining(`"${dest}" targets plugin.json`) as unknown });
    },
  );

  it.each(['..', '../x', 'a/../../x', '.', './', 'a/..'])('%s is outside the plugin output dir (or the dir itself)', (dest) => {
    expect(refused(dest)).toMatchObject({ refusal: 'CONFIG_INVALID', message: expect.stringContaining('outside plugin output dir') as unknown });
  });

  it.each(['/abs/x', String.raw`\abs\x`, 'C:/x', String.raw`c:\x`, 'C:x'])('%s is absolute', (dest) => {
    expect(refused(dest)).toMatchObject({ refusal: 'CONFIG_INVALID', message: expect.stringContaining('must be relative') as unknown });
  });
});

describe('applyPluginFiles', () => {
  afterEach(() => cleanupTempDirs());

  it('copies source->dest relative to projectRoot and pluginOutputDir', async () => {
    const root = createTempDir();
    const out = safePath.join(root, 'out', 'p1');
    mkdirSyncReal(out, { recursive: true });
    await mkdir(safePath.join(root, 'dist', 'hooks'), { recursive: true });
    await writeFile(safePath.join(root, 'dist', 'hooks', 'h.mjs'), 'export default 1;');

    await applyPluginFiles({
      projectRoot: root,
      pluginOutputDir: out,
      entries: [{ source: 'dist/hooks/h.mjs', dest: 'hooks/h.mjs' }],
    });

    expect(existsSync(safePath.join(out, 'hooks', 'h.mjs'))).toBe(true);
    const content = await readFile(safePath.join(out, 'hooks', 'h.mjs'), 'utf-8');
    expect(content).toBe('export default 1;');
  });

  it('auto-creates parent directories in dest', async () => {
    const root = createTempDir();
    const out = safePath.join(root, 'out', 'p1');
    mkdirSyncReal(out, { recursive: true });
    await writeFile(safePath.join(root, 'art.bin'), 'x');
    await applyPluginFiles({
      projectRoot: root,
      pluginOutputDir: out,
      entries: [{ source: 'art.bin', dest: 'deep/nested/art.bin' }],
    });
    expect(existsSync(safePath.join(out, 'deep', 'nested', 'art.bin'))).toBe(true);
  });

  it('throws when files[].source does not exist', async () => {
    const { root, out } = await setupStub();
    await expect(
      applyPluginFiles({
        projectRoot: root,
        pluginOutputDir: out,
        entries: [{ source: 'missing/file.mjs', dest: 'hooks/h.mjs' }],
      }),
    ).rejects.toThrow(/missing\/file\.mjs/);
  });

  // The throw above becomes a build failure on machine-readable stdout, so the
  // path it resolves is the project's own coordinate, never the machine's.
  it('states the missing source project-relative, not absolute', async () => {
    const { root, out } = await setupStub();
    const error = await applyPluginFiles({
      projectRoot: root,
      pluginOutputDir: out,
      entries: [{ source: 'missing/file.mjs', dest: 'hooks/h.mjs' }],
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(error?.message).toContain('resolved to missing/file.mjs');
    expect(error?.message).not.toContain(root);
  });

  it('rejects dest that escapes the plugin output dir (..)', async () => {
    const { root, out } = await setupStub();
    await expect(
      applyPluginFiles({
        projectRoot: root,
        pluginOutputDir: out,
        entries: [{ source: 'src.bin', dest: '../escape.bin' }],
      }),
    ).rejects.toThrow(/path traversal|outside/i);
  });

  it('rejects dest that resolves inside skills/', async () => {
    const { root, out } = await setupStub();
    await expect(
      applyPluginFiles({
        projectRoot: root,
        pluginOutputDir: out,
        entries: [{ source: 'src.bin', dest: 'skills/inject.md' }],
      }),
    ).rejects.toThrow(/skills\//);
  });

  // Decided by where the dest lands, never by how it is spelled: `./skills/x` and — on a volume
  // that folds case — `Skills/x` are the same place `skills/x` is.
  it.each(['./skills/inject.md', 'skills/./a/../inject.md', 'Skills/inject.md', 'SKILLS', 'docs/../skills/inject.md'])(
    'rejects dest %s as inside skills/, writing nothing',
    async (dest) => {
      const { root, out } = await setupStub();
      await expect(applyPluginFiles({ projectRoot: root, pluginOutputDir: out, entries: [{ source: 'src.bin', dest }] }))
        .rejects.toMatchObject({ refusal: 'CONFIG_INVALID', message: expect.stringMatching(/inside skills\//) as unknown });
      expect(readdirSync(out)).toEqual([]);
    },
  );

  it.each(['./.claude-plugin/plugin.json', '.claude-plugin/./plugin.json', '.Claude-Plugin/Plugin.JSON'])(
    'rejects dest %s as the generated plugin.json, writing nothing',
    async (dest) => {
      const { root, out } = await setupStub();
      await expect(applyPluginFiles({ projectRoot: root, pluginOutputDir: out, entries: [{ source: 'src.bin', dest }] }))
        .rejects.toMatchObject({ refusal: 'CONFIG_INVALID', message: expect.stringMatching(/targets plugin\.json/) as unknown });
      expect(readdirSync(out)).toEqual([]);
    },
  );

  it('rejects dest that targets .claude-plugin/plugin.json', async () => {
    const { root, out } = await setupStub();
    await expect(
      applyPluginFiles({
        projectRoot: root,
        pluginOutputDir: out,
        entries: [{ source: 'src.bin', dest: '.claude-plugin/plugin.json' }],
      }),
    ).rejects.toThrow(/plugin\.json/);
  });

  it('logs info-level message when an entry overwrites an existing dest', async () => {
    const root = createTempDir();
    const out = safePath.join(root, 'out', 'p1');
    mkdirSyncReal(out, { recursive: true });
    await mkdir(safePath.join(out, 'hooks'), { recursive: true });
    await writeFile(safePath.join(out, 'hooks', 'h.mjs'), 'OLD');
    await writeFile(safePath.join(root, 'src.bin'), 'NEW');

    const infos: string[] = [];
    await applyPluginFiles({
      projectRoot: root,
      pluginOutputDir: out,
      entries: [{ source: 'src.bin', dest: 'hooks/h.mjs' }],
      info: (m) => infos.push(m),
    });
    const final = await readFile(safePath.join(out, 'hooks', 'h.mjs'), 'utf-8');
    expect(final).toBe('NEW');
    expect(infos.some((m) => m.includes('hooks/h.mjs'))).toBe(true);
  });
});
