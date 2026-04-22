/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { applyPluginFiles } from '../../../../src/commands/claude/plugin/plugin-files.js';
import { createTempDirTracker } from '../../../system/test-common.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-files-');

async function setupStub(): Promise<{ root: string; out: string }> {
  const root = createTempDir();
  const out = safePath.join(root, 'out', 'p1');
  mkdirSyncReal(out, { recursive: true });
  await writeFile(safePath.join(root, 'src.bin'), '');
  return { root, out };
}

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
