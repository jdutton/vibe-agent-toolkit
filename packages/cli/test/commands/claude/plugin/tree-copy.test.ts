/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { treeCopyPlugin } from '../../../../src/commands/claude/plugin/tree-copy.js';
import { createTempDirTracker } from '../../../system/test-common.js';

describe('treeCopyPlugin', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-tree-copy-');
  let src: string;
  let dest: string;

  beforeEach(() => {
    const root = createTempDir();
    src = safePath.join(root, 'plugins', 'p1');
    dest = safePath.join(root, 'out', 'p1');
    mkdirSyncReal(src, { recursive: true });
    mkdirSyncReal(dest, { recursive: true });
  });

  afterEach(() => cleanupTempDirs());

  it('copies commands/, hooks/, agents/, .mcp.json, scripts/ into dest', async () => {
    await mkdir(safePath.join(src, 'commands'), { recursive: true });
    await writeFile(safePath.join(src, 'commands', 'hello.md'), '# hello');
    await mkdir(safePath.join(src, 'hooks'), { recursive: true });
    await writeFile(safePath.join(src, 'hooks', 'hooks.json'), '{"events":{}}');
    await mkdir(safePath.join(src, 'agents'), { recursive: true });
    await writeFile(safePath.join(src, 'agents', 'a1.md'), '# agent');
    await writeFile(safePath.join(src, '.mcp.json'), '{"mcpServers":{}}');
    await mkdir(safePath.join(src, 'scripts'), { recursive: true });
    await writeFile(safePath.join(src, 'scripts', 'tool.mjs'), 'export default 1;');

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'commands', 'hello.md'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'hooks', 'hooks.json'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'agents', 'a1.md'))).toBe(true);
    expect(existsSync(safePath.join(dest, '.mcp.json'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'scripts', 'tool.mjs'))).toBe(true);
  });

  it('excludes skills/ subtree from tree copy', async () => {
    await mkdir(safePath.join(src, 'skills', 's1'), { recursive: true });
    await writeFile(safePath.join(src, 'skills', 's1', 'SKILL.md'), '# skill');
    await treeCopyPlugin({ sourceDir: src, destDir: dest });
    expect(existsSync(safePath.join(dest, 'skills'))).toBe(false);
  });

  it('excludes .claude-plugin/ subtree (plugin.json is merged separately)', async () => {
    await mkdir(safePath.join(src, '.claude-plugin'), { recursive: true });
    await writeFile(safePath.join(src, '.claude-plugin', 'plugin.json'), '{"foo":1}');
    await treeCopyPlugin({ sourceDir: src, destDir: dest });
    expect(existsSync(safePath.join(dest, '.claude-plugin'))).toBe(false);
  });

  it('returns counts for commands, hooks, agents, mcp', async () => {
    await mkdir(safePath.join(src, 'commands'), { recursive: true });
    await writeFile(safePath.join(src, 'commands', 'a.md'), '');
    await writeFile(safePath.join(src, 'commands', 'b.md'), '');
    await mkdir(safePath.join(src, 'hooks'), { recursive: true });
    await writeFile(safePath.join(src, 'hooks', 'hooks.json'), '{}');
    await mkdir(safePath.join(src, 'agents'), { recursive: true });
    await writeFile(safePath.join(src, 'agents', 'x.md'), '');
    await writeFile(safePath.join(src, '.mcp.json'), '{}');

    const result = await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(result.commandsCopied).toBe(2);
    expect(result.hooksCopied).toBe(1);
    expect(result.agentsCopied).toBe(1);
    expect(result.mcpCopied).toBe(1);
  });

  it('returns 0 counts when plugin dir is bare (no assets)', async () => {
    const result = await treeCopyPlugin({ sourceDir: src, destDir: dest });
    expect(result).toEqual({
      commandsCopied: 0,
      hooksCopied: 0,
      agentsCopied: 0,
      mcpCopied: 0,
      filesCopied: 0,
    });
  });

  it('warns (but does not fail) when marketplace.json is present inside author .claude-plugin/', async () => {
    await mkdir(safePath.join(src, '.claude-plugin'), { recursive: true });
    await writeFile(safePath.join(src, '.claude-plugin', 'marketplace.json'), '{}');
    const warnings: string[] = [];
    await treeCopyPlugin({ sourceDir: src, destDir: dest, warn: (m) => warnings.push(m) });
    expect(warnings.some((w) => w.includes('marketplace.json'))).toBe(true);
  });
});
