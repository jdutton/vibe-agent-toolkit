/* eslint-disable sonarjs/no-duplicate-string */
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirTracker, executeCli, getBinPath, writeTestFile } from './test-common.js';

const binPath = getBinPath(import.meta.url);
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-audit-full-');

function seedPlugin(tempDir: string): string {
  const pluginRoot = safePath.join(
    tempDir,
    'dist',
    '.claude',
    'plugins',
    'marketplaces',
    'm',
    'plugins',
    'p1',
  );
  mkdirSyncReal(safePath.join(pluginRoot, '.claude-plugin'), { recursive: true });
  writeTestFile(
    safePath.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'p1', version: '1.0.0', author: { name: 'T' } }),
  );
  return pluginRoot;
}

describe('vat audit (parse-only checks for full-plugin assets)', () => {
  afterEach(() => cleanupTempDirs());

  it('reports an error when a built plugin ships malformed hooks.json', async () => {
    const tempDir = createTempDir();
    const pluginRoot = seedPlugin(tempDir);
    mkdirSyncReal(safePath.join(pluginRoot, 'hooks'), { recursive: true });
    writeTestFile(safePath.join(pluginRoot, 'hooks', 'hooks.json'), '{not json');

    const result = await executeCli(binPath, ['audit', pluginRoot], { cwd: tempDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hooks.json');
    expect(result.stdout).toMatch(/severity:\s*error/);
  });

  it('reports an error when .mcp.json is malformed', async () => {
    const tempDir = createTempDir();
    const pluginRoot = seedPlugin(tempDir);
    writeTestFile(safePath.join(pluginRoot, '.mcp.json'), 'bogus');

    const result = await executeCli(binPath, ['audit', pluginRoot], { cwd: tempDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.mcp.json');
    expect(result.stdout).toMatch(/severity:\s*error/);
  });

  it('passes when commands/*.md and agents/*.md exist and JSON files parse', async () => {
    const tempDir = createTempDir();
    const pluginRoot = seedPlugin(tempDir);
    mkdirSyncReal(safePath.join(pluginRoot, 'commands'), { recursive: true });
    writeTestFile(safePath.join(pluginRoot, 'commands', 'hello.md'), '---\n---\n# hi');
    mkdirSyncReal(safePath.join(pluginRoot, 'agents'), { recursive: true });
    writeTestFile(safePath.join(pluginRoot, 'agents', 'a.md'), '---\n---\n# a');
    mkdirSyncReal(safePath.join(pluginRoot, 'hooks'), { recursive: true });
    writeTestFile(safePath.join(pluginRoot, 'hooks', 'hooks.json'), '{"events":{}}');
    writeTestFile(safePath.join(pluginRoot, '.mcp.json'), '{"mcpServers":{}}');

    const result = await executeCli(binPath, ['audit', pluginRoot], { cwd: tempDir });
    expect(result.status).toBe(0);
  });
});
