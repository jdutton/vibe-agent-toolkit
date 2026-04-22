/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
import { existsSync } from 'node:fs';

import { mkdirSyncReal, safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSkillMarkdown,
  createTempDirTracker,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const binPath = getBinPath(import.meta.url);
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-neg-');

function configMin(pluginYaml: string): string {
  return `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
${pluginYaml}
`;
}

/**
 * Seed a plugin-local skill under plugins/<name>/skills/<skill>/ so the
 * skill-stream has something to build. The plugin directory existing is what
 * makes the plugin non-empty.
 */
function seedPluginLocalSkill(tempDir: string, pluginName: string, skillName: string): void {
  writeTestFile(
    safePath.join(tempDir, 'package.json'),
    JSON.stringify({ name: 't', version: '0.0.1' }),
  );
  const skillDir = safePath.join(tempDir, 'plugins', pluginName, 'skills', skillName);
  mkdirSyncReal(skillDir, { recursive: true });
  writeTestFile(safePath.join(skillDir, 'SKILL.md'), createSkillMarkdown(skillName));
}

function writeConfigAndPkg(tempDir: string, configYaml: string): void {
  writeTestFile(
    safePath.join(tempDir, 'package.json'),
    JSON.stringify({ name: 't', version: '0.0.1' }),
  );
  writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), configYaml);
}

function runSkillsThenPluginBuild(tempDir: string): ReturnType<typeof executeCli> {
  executeCli(binPath, ['skills', 'build'], { cwd: tempDir });
  return executeCli(binPath, ['claude', 'plugin', 'build'], { cwd: tempDir });
}

/**
 * Seed a plugin-local skill for plugin `p1` and write the minimal config that
 * declares it. Shared setup for negative-path tests whose bodies diverge only
 * in what malformed artifact they place under `plugins/p1/`.
 */
function seedPluginP1WithMinimalConfig(tempDir: string): void {
  seedPluginLocalSkill(tempDir, 'p1', 'skill-a');
  writeTestFile(
    safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
    configMin('        - name: p1\n          skills: []\n'),
  );
}

describe('vat claude plugin build (negative paths)', () => {
  afterEach(() => cleanupTempDirs());

  it('errors on malformed hooks/hooks.json', () => {
    const tempDir = createTempDir();
    seedPluginP1WithMinimalConfig(tempDir);
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1', 'hooks'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'plugins', 'p1', 'hooks', 'hooks.json'), '{not json');

    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hooks.json');
  });

  it('errors on malformed .mcp.json', () => {
    const tempDir = createTempDir();
    seedPluginP1WithMinimalConfig(tempDir);
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'plugins', 'p1', '.mcp.json'), 'bogus');

    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.mcp.json');
  });

  it('errors when files[].source is missing', () => {
    const tempDir = createTempDir();
    seedPluginLocalSkill(tempDir, 'p1', 'skill-a');
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
        - name: p1
          skills: []
          files:
            - source: dist/missing.mjs
              dest: hooks/missing.mjs
`,
    );
    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dist/missing.mjs');
  });

  it('errors when the same plugin name is declared in two marketplaces', () => {
    const tempDir = createTempDir();
    seedPluginLocalSkill(tempDir, 'dup', 'skill-a');
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
        - name: dup
          skills: []
    mp2:
      owner:
        name: Test
      plugins:
        - name: dup
          skills: []
`,
    );
    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/declared more than once|globally unique/i);
  });

  it('errors when a plugin has no plugin dir and no files[] (empty-plugin guard)', () => {
    const tempDir = createTempDir();
    writeConfigAndPkg(tempDir, configMin('        - name: empty\n          skills: []\n'));
    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/has no content/i);
  });

  it('does not copy gitignored node_modules from plugins/<p>/', () => {
    const tempDir = createTempDir();
    seedPluginLocalSkill(tempDir, 'p1', 'skill-a');
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      configMin('        - name: p1\n          skills: []\n'),
    );
    safeExecSync('git', ['init', '-q'], { cwd: tempDir });
    safeExecSync('git', ['config', 'user.email', 't@t'], { cwd: tempDir });
    safeExecSync('git', ['config', 'user.name', 't'], { cwd: tempDir });
    writeTestFile(safePath.join(tempDir, '.gitignore'), 'plugins/p1/node_modules/\n');
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1', 'node_modules'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'plugins', 'p1', 'node_modules', 'junk.js'), '//');
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1', 'commands'), { recursive: true });
    writeTestFile(
      safePath.join(tempDir, 'plugins', 'p1', 'commands', 'ok.md'),
      '---\n---\n# ok',
    );
    safeExecSync('git', ['add', '-A'], { cwd: tempDir });
    safeExecSync('git', ['commit', '-q', '-m', 'init'], { cwd: tempDir });

    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).toBe(0);
    const out = safePath.join(
      tempDir,
      'dist',
      '.claude',
      'plugins',
      'marketplaces',
      'mp1',
      'plugins',
      'p1',
    );
    expect(existsSync(safePath.join(out, 'node_modules'))).toBe(false);
    expect(existsSync(safePath.join(out, 'commands', 'ok.md'))).toBe(true);
  });
});
