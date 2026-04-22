/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
import { existsSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSkillMarkdown,
  createTempDirTracker,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const binPath = getBinPath(import.meta.url);
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-full-');

function buildFixture(tempDir: string): void {
  writeTestFile(
    safePath.join(tempDir, 'package.json'),
    JSON.stringify({ name: 't', version: '1.0.0' }),
  );

  const config = `version: 1
skills:
  include: ["skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test Org
        email: ops@test.example
      plugins:
        - name: full-plugin
          description: Plugin with every asset type
          skills: ["pool-a"]
          files:
            - source: dist/hooks/compiled-hook.mjs
              dest: hooks/compiled-hook.mjs
`;
  writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), config);

  mkdirSyncReal(safePath.join(tempDir, 'skills', 'pool-a'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'skills', 'pool-a', 'SKILL.md'),
    createSkillMarkdown('pool-a'),
  );

  const plugin = safePath.join(tempDir, 'plugins', 'full-plugin');
  mkdirSyncReal(safePath.join(plugin, 'commands'), { recursive: true });
  writeTestFile(safePath.join(plugin, 'commands', 'hello.md'), '---\n---\n# hello');
  mkdirSyncReal(safePath.join(plugin, 'hooks'), { recursive: true });
  writeTestFile(safePath.join(plugin, 'hooks', 'hooks.json'), '{"events":{}}');
  mkdirSyncReal(safePath.join(plugin, 'agents'), { recursive: true });
  writeTestFile(safePath.join(plugin, 'agents', 'reviewer.md'), '---\n---\n# reviewer');
  writeTestFile(safePath.join(plugin, '.mcp.json'), '{"mcpServers":{}}');
  mkdirSyncReal(safePath.join(plugin, 'scripts'), { recursive: true });
  writeTestFile(safePath.join(plugin, 'scripts', 'util.mjs'), 'export default 1;');
  mkdirSyncReal(safePath.join(plugin, 'skills', 'local-b'), { recursive: true });
  writeTestFile(
    safePath.join(plugin, 'skills', 'local-b', 'SKILL.md'),
    createSkillMarkdown('local-b'),
  );

  mkdirSyncReal(safePath.join(plugin, '.claude-plugin'), { recursive: true });
  writeTestFile(
    safePath.join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      keywords: ['alpha', 'beta'],
      homepage: 'https://example.test/',
      license: 'Apache-2.0',
      name: 'author-picked-name',
    }),
  );

  mkdirSyncReal(safePath.join(tempDir, 'dist', 'hooks'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'dist', 'hooks', 'compiled-hook.mjs'),
    'export default 2;',
  );
}

describe('vat claude plugin build (full plugin support)', () => {
  afterEach(() => cleanupTempDirs());

  it('produces a full plugin tree with commands, hooks, agents, mcp, scripts, pool+local skills, files[], merged plugin.json', () => {
    const tempDir = createTempDir();
    buildFixture(tempDir);

    const sb = executeCliAndParseYaml(binPath, ['skills', 'build'], { cwd: tempDir });
    expect(sb.result.status).toBe(0);

    const pb = executeCliAndParseYaml(binPath, ['claude', 'plugin', 'build'], { cwd: tempDir });
    expect(pb.result.status).toBe(0);

    const outDir = safePath.join(
      tempDir,
      'dist',
      '.claude',
      'plugins',
      'marketplaces',
      'mp1',
      'plugins',
      'full-plugin',
    );

    expect(existsSync(safePath.join(outDir, 'commands', 'hello.md'))).toBe(true);
    expect(existsSync(safePath.join(outDir, 'hooks', 'hooks.json'))).toBe(true);
    expect(existsSync(safePath.join(outDir, 'agents', 'reviewer.md'))).toBe(true);
    expect(existsSync(safePath.join(outDir, '.mcp.json'))).toBe(true);
    expect(existsSync(safePath.join(outDir, 'scripts', 'util.mjs'))).toBe(true);
    expect(existsSync(safePath.join(outDir, 'skills', 'pool-a', 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(outDir, 'skills', 'local-b', 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(outDir, 'hooks', 'compiled-hook.mjs'))).toBe(true);

    const pluginJson = JSON.parse(
      readFileSync(safePath.join(outDir, '.claude-plugin', 'plugin.json'), 'utf-8'),
    );
    expect(pluginJson.name).toBe('full-plugin');
    expect(pluginJson.version).toBe('1.0.0');
    expect(pluginJson.description).toBe('Plugin with every asset type');
    expect(pluginJson.keywords).toEqual(['alpha', 'beta']);
    expect(pluginJson.homepage).toBe('https://example.test/');
    expect(pluginJson.license).toBe('Apache-2.0');
    expect(pluginJson.author).toEqual({ name: 'Test Org', email: 'ops@test.example' });

    const parsed = pb.parsed as Record<string, unknown>;
    const mps = parsed['marketplaces'] as Array<Record<string, unknown>>;
    const plugins = mps[0]?.['plugins'] as Array<Record<string, unknown>>;
    expect(plugins[0]).toMatchObject({
      commandsCopied: 1,
      hooksCopied: 1,
      agentsCopied: 1,
      mcpCopied: 1,
    });
  });
});
