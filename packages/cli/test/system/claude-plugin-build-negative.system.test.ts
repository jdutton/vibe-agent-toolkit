import { chmodSync, existsSync } from 'node:fs';

import type { RefusalCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { PLUGIN_BUILD_REPORT_SCHEMA, type PluginBuildReport } from '../../src/commands/claude/plugin/build-schema.js';

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
  return `skills:
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

async function runSkillsThenPluginBuild(tempDir: string): ReturnType<typeof executeCli> {
  await executeCli(binPath, ['skills', 'build'], { cwd: tempDir });
  return executeCli(binPath, ['claude', 'plugin', 'build'], { cwd: tempDir });
}

/** The build's stdout, read through the published schema. */
function reportOf(stdout: string): PluginBuildReport {
  return PLUGIN_BUILD_REPORT_SCHEMA.parse(yaml.parse(stdout));
}

/** The build refused with `code`, exit 2 — a user's mistake, never INTERNAL_ERROR. */
function expectRefusal(result: Awaited<ReturnType<typeof executeCli>>, code: RefusalCode): void {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
  const report = reportOf(result.stdout);
  expect(report.status === 'error' ? report.error.code : report.status).toBe(code);
}

/** `git init` + commit, so the tree-copy sees the fixture's files. */
function commitAll(tempDir: string): void {
  runGitOrThrow(['init', '-q'], { cwd: tempDir });
  runGitOrThrow(['config', 'user.email', 't@t'], { cwd: tempDir });
  runGitOrThrow(['config', 'user.name', 't'], { cwd: tempDir });
  runGitOrThrow(['add', '-A'], { cwd: tempDir });
  runGitOrThrow(['commit', '-q', '-m', 'init'], { cwd: tempDir });
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

/** The two verbs that run the plugin build lane. */
const PLUGIN_BUILD_LANES: [string, string[]][] = [
  ['claude plugin build', ['claude', 'plugin', 'build']],
  ['build', ['build']],
];

/** The `files:` source plugin-local `skill-a` declares, relative to the project. */
const FILES_SOURCE = 'generated/payload.bin';

/** Plugin `p1` holding plugin-local `skill-a`, which declares {@link FILES_SOURCE} — never written here. */
function seedPluginLocalSkillWithFilesSource(tempDir: string): void {
  seedPluginLocalSkill(tempDir, 'p1', 'skill-a');
  mkdirSyncReal(safePath.join(tempDir, 'generated'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
    `skills:
  include: ["plugins/*/skills/**/SKILL.md"]
  defaults:
    publish: false
  config:
    skill-a:
      files:
        - source: ${FILES_SOURCE}
          dest: scripts/payload.bin
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
        - name: p1
          skills: []
`,
  );
}

/**
 * The run stopped (`RUN_INCOMPLETE`, exit 2) on one `SKILL_PACKAGING_FAILED` finding at `skill-a` — never `INTERNAL_ERROR`.
 *
 * @returns That finding's message
 */
function expectStoppedAtSkillA(result: Awaited<ReturnType<typeof executeCli>>): string {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
  const document = yaml.parse(result.stdout) as {
    error: { code: string };
    findings: Array<{ code: string; severity: string; location?: string; message: string }>;
    data?: { phases?: Array<{ name: string; error?: { code: string } }> };
  };
  expect(document.error.code).toBe('RUN_INCOMPLETE');
  expect(result.stdout).not.toContain('INTERNAL_ERROR');
  expect(document.findings.map(({ code, severity, location }) => ({ code, severity, location }))).toEqual([
    { code: 'SKILL_PACKAGING_FAILED', severity: 'error', location: 'plugins/p1/skills/skill-a/SKILL.md' },
  ]);
  const phases = document.data?.phases;
  if (phases !== undefined) expect(phases.find((phase) => phase.name === 'claude')?.error?.code).toBe('RUN_INCOMPLETE');
  return document.findings[0]?.message ?? '';
}

describe('vat claude plugin build (negative paths)', () => {
  afterEach(() => cleanupTempDirs());

  it('errors on malformed hooks/hooks.json', async () => {
    const tempDir = createTempDir();
    seedPluginP1WithMinimalConfig(tempDir);
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1', 'hooks'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'plugins', 'p1', 'hooks', 'hooks.json'), '{not json');

    const result = await runSkillsThenPluginBuild(tempDir);
    expectRefusal(result, 'INPUT_UNREADABLE');
    expect(result.stderr).toContain('hooks.json');
  });

  it('errors on malformed .mcp.json', async () => {
    const tempDir = createTempDir();
    seedPluginP1WithMinimalConfig(tempDir);
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'plugins', 'p1', '.mcp.json'), 'bogus');

    const result = await runSkillsThenPluginBuild(tempDir);
    expectRefusal(result, 'INPUT_UNREADABLE');
    expect(result.stderr).toContain('.mcp.json');
  });

  it('errors when files[].source is missing', async () => {
    const tempDir = createTempDir();
    seedPluginLocalSkill(tempDir, 'p1', 'skill-a');
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      `skills:
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
    const result = await runSkillsThenPluginBuild(tempDir);
    expectRefusal(result, 'INPUT_UNREADABLE');
    expect(result.stderr).toContain('dist/missing.mjs');
  });

  // The packager refusing a plugin-local skill's own content is the project's to
  // fix — the same `SKILL_PACKAGING_FAILED` finding on a stopped run that
  // `vat skill test run` and `vat agent build` publish for it, never a defect in VAT.
  it.each(PLUGIN_BUILD_LANES)('vat %s: a plugin-local skill whose files: source is missing stops the run, coded at the skill', async (_verb, args) => {
    const tempDir = createTempDir();
    seedPluginLocalSkillWithFilesSource(tempDir);

    expectStoppedAtSkillA(await executeCli(binPath, args, { cwd: tempDir }));
  });

  // The source is THERE and the OS will not read it: it passes the packager's
  // existence check and the copy is what fails, through `withFsAttribution`.
  it.skipIf(CANNOT_DENY_READS).each(PLUGIN_BUILD_LANES)('vat %s: a plugin-local skill whose files: source cannot be read stops the run, coded at the skill', async (_verb, args) => {
    const tempDir = createTempDir();
    seedPluginLocalSkillWithFilesSource(tempDir);
    const locked = safePath.join(tempDir, FILES_SOURCE);
    writeTestFile(locked, 'payload\n');
    chmodSync(locked, 0o000);

    try {
      const result = await executeCli(binPath, args, { cwd: tempDir });

      expect(expectStoppedAtSkillA(result)).toContain('could not be copied into the bundle');
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it('errors when the same plugin name is declared in two marketplaces', async () => {
    const tempDir = createTempDir();
    seedPluginLocalSkill(tempDir, 'dup', 'skill-a');
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      `skills:
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
    const result = await runSkillsThenPluginBuild(tempDir);
    expectRefusal(result, 'CONFIG_INVALID');
    expect(result.stderr).toMatch(/declared more than once|globally unique/i);
  });

  it('errors when a plugin has no plugin dir and no files[] (empty-plugin guard)', async () => {
    const tempDir = createTempDir();
    writeConfigAndPkg(tempDir, configMin('        - name: empty\n          skills: []\n'));
    const result = await runSkillsThenPluginBuild(tempDir);
    expectRefusal(result, 'CONFIG_INVALID');
    expect(result.stderr).toMatch(/has no content/i);
  });

  it('refuses a --marketplace the config does not declare as USAGE_INVALID', async () => {
    const tempDir = createTempDir();
    seedPluginP1WithMinimalConfig(tempDir);
    const result = await executeCli(binPath, ['claude', 'plugin', 'build', '--marketplace', 'nope'], { cwd: tempDir });
    expectRefusal(result, 'USAGE_INVALID');
    expect(result.stderr).toContain('declared: mp1');
  });

  it('refuses outside a project as CONFIG_INVALID', async () => {
    const tempDir = createTempDir();
    const result = await executeCli(binPath, ['claude', 'plugin', 'build'], { cwd: tempDir });
    expectRefusal(result, 'CONFIG_INVALID');
  });

  it('plugin build publishes a gate failure as findings, exit 1', async () => {
    const tempDir = createTempDir();
    writeConfigAndPkg(tempDir, `skills:
  include: ["plugins/*/skills/**/SKILL.md"]
  defaults:
    validation:
      severity:
        LINK_OUTSIDE_SKILL_DIR: error
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
        - name: p1
          skills: []
`);
    const skills = safePath.join(tempDir, 'plugins', 'p1', 'skills');
    mkdirSyncReal(safePath.join(skills, 'strict'), { recursive: true });
    writeTestFile(safePath.join(skills, 'shared.md'), '# Shared notes\n');
    writeTestFile(
      safePath.join(skills, 'strict', 'SKILL.md'),
      '---\nname: strict\ndescription: Plugin-local skill whose SKILL.md links a file outside its own directory.\n---\n\n# strict\n\nSee [shared notes](../shared.md).\n',
    );
    writeTestFile(safePath.join(tempDir, '.gitignore'), 'dist/\n');
    commitAll(tempDir);

    const result = await executeCli(binPath, ['claude', 'plugin', 'build'], { cwd: tempDir });

    // The gate's error-severity finding is a finding, not a crash: exit 1, never 2.
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    const report = reportOf(result.stdout);
    expect(report.status).toBe('findings');
    // Located relative to the directory holding the config, never absolute.
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'LINK_OUTSIDE_SKILL_DIR',
      severity: 'error',
      location: 'plugins/p1/skills/strict/SKILL.md',
    }));
    expect(result.stdout).not.toContain(toForwardSlash(tempDir));
    expect(report.data.marketplaces[0]).toMatchObject({
      name: 'mp1',
      status: 'findings',
      reason: expect.stringMatching(/post-build validation errors: strict$/),
    });
  });

  it('does not copy gitignored node_modules from plugins/<p>/', async () => {
    const tempDir = createTempDir();
    seedPluginLocalSkill(tempDir, 'p1', 'skill-a');
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      configMin('        - name: p1\n          skills: []\n'),
    );
    runGitOrThrow(['init', '-q'], { cwd: tempDir });
    runGitOrThrow(['config', 'user.email', 't@t'], { cwd: tempDir });
    runGitOrThrow(['config', 'user.name', 't'], { cwd: tempDir });
    writeTestFile(safePath.join(tempDir, '.gitignore'), 'plugins/p1/node_modules/\n');
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1', 'node_modules'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'plugins', 'p1', 'node_modules', 'junk.js'), '//');
    mkdirSyncReal(safePath.join(tempDir, 'plugins', 'p1', 'commands'), { recursive: true });
    writeTestFile(
      safePath.join(tempDir, 'plugins', 'p1', 'commands', 'ok.md'),
      '---\n---\n# ok',
    );
    runGitOrThrow(['add', '-A'], { cwd: tempDir });
    runGitOrThrow(['commit', '-q', '-m', 'init'], { cwd: tempDir });

    const result = await runSkillsThenPluginBuild(tempDir);
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
