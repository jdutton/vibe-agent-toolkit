/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
import { existsSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirTracker, executeCliAndParseYaml, getBinPath, writeTestFile } from './test-common.js';

const binPath = getBinPath(import.meta.url);
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-full-');

function buildFixture(tempDir: string, pluginSkills: string[] = []): void {
  writeTestFile(
    safePath.join(tempDir, 'package.json'),
    JSON.stringify({ name: 't', version: '1.0.0' }),
  );

  const config = `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
  config:
    local-b:
      files:
        - source: dist/gen/engine.mjs
          dest: lib/engine.mjs
claude:
  marketplaces:
    mp1:
      owner:
        name: Test Org
        email: ops@test.example
      plugins:
        - name: full-plugin
          description: Plugin with every asset type
          skills: ${pluginSkills.length > 0 ? `[${pluginSkills.join(', ')}]` : '[]'}
          files:
            - source: dist/hooks/compiled-hook.mjs
              dest: hooks/compiled-hook.mjs
`;
  writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), config);

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
  // Links the build-injected bundle (a files:-declared dest) so it is referenced
  // and resolves via the deferred-artifact path rather than as a broken link.
  writeTestFile(
    safePath.join(plugin, 'skills', 'local-b', 'SKILL.md'),
    `---
name: local-b
description: local-b - comprehensive test skill for validation and packaging coverage
version: 1.0.0
---

# local-b

Uses the bundled [engine](lib/engine.mjs).
`,
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

  // A build-injected artifact for the tree-copied skill local-b: declared via
  // skill-level files: (source lives outside the skill dir, never in skill
  // source). The plugin selects no pool skills, so local-b reaches the plugin
  // ONLY via verbatim tree-copy — the path that must now apply skill-level files:.
  mkdirSyncReal(safePath.join(tempDir, 'dist', 'gen'), { recursive: true });
  writeTestFile(safePath.join(tempDir, 'dist', 'gen', 'engine.mjs'), 'export const engine = 3;');
}

// Run `vat skills build` then `vat claude plugin build` for a prepared temp
// project, asserting both exit 0, and return the parsed plugin-build result.
async function buildSkillsThenPlugin(
  tempDir: string,
): ReturnType<typeof executeCliAndParseYaml> {
  const sb = await executeCliAndParseYaml(binPath, ['skills', 'build'], { cwd: tempDir });
  expect(sb.result.status).toBe(0);

  const pb = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'build'], { cwd: tempDir });
  expect(pb.result.status).toBe(0);
  return pb;
}

describe('vat claude plugin build (full plugin support)', () => {
  afterEach(() => cleanupTempDirs());

  it('produces a full plugin tree with commands, hooks, agents, mcp, scripts, plugin-local skills, files[], merged plugin.json', async () => {
    const tempDir = createTempDir();
    buildFixture(tempDir);

    const pb = await buildSkillsThenPlugin(tempDir);

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
    expect(existsSync(safePath.join(outDir, 'skills', 'local-b', 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(outDir, 'hooks', 'compiled-hook.mjs'))).toBe(true);
    // The tree-copied skill's build-injected files: bundle landed in the
    // distributed tree (skill-level files: applied in the plugin build path).
    const engineOut = safePath.join(outDir, 'skills', 'local-b', 'lib', 'engine.mjs');
    expect(existsSync(engineOut)).toBe(true);
    expect(readFileSync(engineOut, 'utf-8')).toBe('export const engine = 3;');

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

    const mps = pb.parsed['marketplaces'] as Array<Record<string, unknown>>;
    const plugins = mps[0]?.['plugins'] as Array<Record<string, unknown>>;
    expect(plugins[0]).toMatchObject({
      commandsCopied: 1,
      hooksCopied: 1,
      agentsCopied: 1,
      mcpCopied: 1,
    });
  });

  it('resolves a skill claimed by both the pool selector and the plugin-local skills/ tree to the single pool-packaged copy (collision referee)', async () => {
    const tempDir = createTempDir();
    buildFixture(tempDir, ['local-b']);

    const pb = await buildSkillsThenPlugin(tempDir);

    const outDir = safePath.join(
      tempDir, 'dist', '.claude', 'plugins', 'marketplaces', 'mp1', 'plugins', 'full-plugin',
    );

    // Single packaged copy — the bundled files: artifact only exists at the
    // pool-packaged location, never re-applied by a (now-excluded) tree-copy.
    expect(existsSync(safePath.join(outDir, 'skills', 'local-b', 'SKILL.md'))).toBe(true);
    const engineOut = safePath.join(outDir, 'skills', 'local-b', 'lib', 'engine.mjs');
    expect(existsSync(engineOut)).toBe(true);
    expect(readFileSync(engineOut, 'utf-8')).toBe('export const engine = 3;');

    const mps = pb.parsed['marketplaces'] as Array<Record<string, unknown>>;
    const plugins = mps[0]?.['plugins'] as Array<Record<string, unknown>>;
    // local-b now arrives via the pool selector, not the tree-copy.
    expect(plugins[0]?.['skills']).toEqual(['local-b']);
    // The tree-copy's files: re-application is excluded for a colliding skill
    // — its files: config was already applied by `vat skills build` and is
    // baked into the pool copy that Phase 3 copies in.
    expect(plugins[0]?.['localSkillsPackaged']).toBe(0);

    // A collision warning naming the skill was printed to stderr (build progress).
    expect(pb.result.stderr).toContain('local-b');
    expect(pb.result.stderr.toLowerCase()).toContain('warning');
  });

  it('excludes a colon-bearing skill name from tree-copy using its fs-safe on-disk directory name', async () => {
    const tempDir = createTempDir();
    writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
claude:
  marketplaces:
    mp2:
      owner:
        name: Test Org
      plugins:
        - name: colon-plugin
          skills: ["foo:bar"]
`,
    );

    // Authors name the on-disk source directory with the fs-safe form —
    // colons are invalid in Windows directory names — so this is the only
    // literal directory a real author could create for skill name "foo:bar".
    const skillDir = safePath.join(tempDir, 'plugins', 'colon-plugin', 'skills', 'foo__bar');
    mkdirSyncReal(skillDir, { recursive: true });
    writeTestFile(
      safePath.join(skillDir, 'SKILL.md'),
      '---\nname: foo:bar\ndescription: colon-bearing skill name for fs-safe enumeration testing\n---\n\n# foo:bar\n',
    );

    const pb = await buildSkillsThenPlugin(tempDir);

    const mps = pb.parsed['marketplaces'] as Array<Record<string, unknown>>;
    const plugins = mps[0]?.['plugins'] as Array<Record<string, unknown>>;
    // The sole plugin-source file (skills/foo__bar/SKILL.md) was excluded
    // from tree-copy — proving the fs-safe form matched and the collision
    // was detected, not just coincidentally overlapping.
    expect(plugins[0]?.['treeFilesCopied']).toBe(0);
    expect(plugins[0]?.['skills']).toEqual(['foo__bar']);

    const outDir = safePath.join(
      tempDir, 'dist', '.claude', 'plugins', 'marketplaces', 'mp2', 'plugins', 'colon-plugin',
    );
    expect(existsSync(safePath.join(outDir, 'skills', 'foo__bar', 'SKILL.md'))).toBe(true);
  });
});
