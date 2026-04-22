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
  include: ["skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
${pluginYaml}
`;
}

function seedMinimalPool(tempDir: string): void {
  writeTestFile(
    safePath.join(tempDir, 'package.json'),
    JSON.stringify({ name: 't', version: '0.0.1' }),
  );
  mkdirSyncReal(safePath.join(tempDir, 'skills', 'pool-a'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'skills', 'pool-a', 'SKILL.md'),
    createSkillMarkdown('pool-a'),
  );
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

describe('vat claude plugin build (negative paths)', () => {
  afterEach(() => cleanupTempDirs());

  it('errors when plugin dir is declared but missing AND no pool skills selected', () => {
    const tempDir = createTempDir();
    writeConfigAndPkg(tempDir, configMin('        - name: ghost\n'));
    const result = executeCli(binPath, ['claude', 'plugin', 'build'], { cwd: tempDir });
    expect(result.status).not.toBe(0);
  });

  it('errors on malformed hooks/hooks.json', () => {
    const tempDir = createTempDir();
    seedMinimalPool(tempDir);
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      configMin('        - name: p1\n          skills: ["pool-a"]\n'),
    );
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1', 'hooks'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'plugins', 'p1', 'hooks', 'hooks.json'), '{not json');

    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hooks.json');
  });

  it('errors on malformed .mcp.json', () => {
    const tempDir = createTempDir();
    seedMinimalPool(tempDir);
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      configMin('        - name: p1\n          skills: ["pool-a"]\n'),
    );
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'plugins', 'p1', '.mcp.json'), 'bogus');

    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.mcp.json');
  });

  it('errors when files[].source is missing', () => {
    const tempDir = createTempDir();
    seedMinimalPool(tempDir);
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      `version: 1
skills:
  include: ["skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
        - name: p1
          skills: ["pool-a"]
          files:
            - source: dist/missing.mjs
              dest: hooks/missing.mjs
`,
    );
    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dist/missing.mjs');
  });

  it('errors with resolution guidance on pool-vs-local name collision', () => {
    const tempDir = createTempDir();
    writeConfigAndPkg(tempDir, configMin('        - name: p1\n          skills: ["dup"]\n'));
    mkdirSyncReal(safePath.join(tempDir, 'skills', 'dup'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'skills', 'dup', 'SKILL.md'), createSkillMarkdown('dup'));
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1', 'skills', 'dup'), { recursive: true });
    writeTestFile(
      safePath.join(tempDir, 'plugins', 'p1', 'skills', 'dup', 'SKILL.md'),
      createSkillMarkdown('dup'),
    );

    const result = executeCli(binPath, ['skills', 'build'], { cwd: tempDir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/skills\/dup\/SKILL\.md/);
    expect(result.stderr).toMatch(/plugins\/p1\/skills\/dup\/SKILL\.md/);
  });

  it('errors when the same plugin name is declared in two marketplaces', () => {
    const tempDir = createTempDir();
    seedMinimalPool(tempDir);
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      `version: 1
skills:
  include: ["skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
        - name: dup
          skills: ["pool-a"]
    mp2:
      owner:
        name: Test
      plugins:
        - name: dup
          skills: ["pool-a"]
`,
    );
    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/declared more than once|globally unique/i);
  });

  it('errors when a plugin has no skills, no plugin dir, and no files[] (empty-plugin guard)', () => {
    const tempDir = createTempDir();
    writeConfigAndPkg(tempDir, configMin('        - name: empty\n'));
    const result = runSkillsThenPluginBuild(tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/has no content/i);
  });

  it('does not copy gitignored node_modules from plugins/<p>/', () => {
    const tempDir = createTempDir();
    seedMinimalPool(tempDir);
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      configMin('        - name: p1\n          skills: ["pool-a"]\n'),
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
