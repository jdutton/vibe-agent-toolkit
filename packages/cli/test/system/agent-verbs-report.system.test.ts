/**
 * `vat agent build`, `import`, `installed`, `list`, `install` and `uninstall`
 * publish the report envelope — observed through the built CLI, each document
 * read back with the verb's registered schema.
 *
 * Every run takes a fake HOME: the user scope is `~/.claude/skills`, and nothing
 * here may read — or install into — the developer's real one.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, readFileSync } from 'node:fs';

import { ExitCode, type RefusalCode } from '@vibe-agent-toolkit/schema';
import { createSymlink, mkdirSyncReal, normalizePath, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';
import type { z } from 'zod';

import { AGENT_BUILD_REPORT_SCHEMA } from '../../src/commands/agent/build-schema.js';
import { AGENT_IMPORT_REPORT_SCHEMA } from '../../src/commands/agent/import-schema.js';
import { AGENT_INSTALL_REPORT_SCHEMA } from '../../src/commands/agent/install-schema.js';
import { AGENT_INSTALLED_REPORT_SCHEMA } from '../../src/commands/agent/installed-schema.js';
import { AGENT_LIST_REPORT_SCHEMA } from '../../src/commands/agent/list-schema.js';
import { AGENT_UNINSTALL_REPORT_SCHEMA } from '../../src/commands/agent/uninstall-schema.js';

import { cleanupTestTempDir, createTestTempDir, executeCli, fakeHomeEnv, getBinPath, writeFileTree } from './test-common.js';

const binPath = getBinPath(import.meta.url);

const UNREADABLE = 0o000;
const RESTORED = 0o755;

const MANIFEST = 'metadata:\n  name: widget-reviewer\n  version: 0.1.0\n  description: Reviews widgets\n'
  + 'spec:\n  llm:\n    provider: anthropic\n    model: claude-sonnet-5\n';
const PROMPTED_MANIFEST = `${MANIFEST}  prompts:\n    system:\n      $ref: ./prompts/system.md\n`;
const CLEAN_SKILL = '---\nname: widget-skill\ndescription: Reviews widgets for quality. Use when a reviewer wants a checklist.\n---\n\n# widget-skill\n';

let tempDir: string;
/** Directories a case locked, restored before cleanup — a mode-0 directory is not removable. */
const locked: string[] = [];

/** A git project under the suite's temp dir holding `files`. */
function project(name: string, files: Readonly<Record<string, string>>): string {
  const dir = safePath.join(tempDir, name);
  // A package.json, so a build has somewhere to put its default output.
  writeFileTree(dir, { 'vibe-agent-toolkit.config.yaml': '{}\n', 'package.json': '{"name":"agents"}', ...files });
  spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: dir });
  return dir;
}

/** A fresh fake HOME for one run. */
function freshHome(name: string): string {
  const home = safePath.join(tempDir, 'homes', name);
  mkdirSyncReal(home, { recursive: true });
  return home;
}

let runs = 0;

/**
 * Run `vat <args>` in `cwd` under `home` — a fresh one unless the case seeded
 * its own — and read its document with `schema`.
 */
async function vat<S extends z.ZodTypeAny>(schema: S, args: string[], cwd: string, home = freshHome(`run-${++runs}`)) {
  const result = await executeCli(binPath, args, { cwd, env: fakeHomeEnv(home) });
  return { status: result.status, stderr: result.stderr, report: schema.parse(yaml.parse(result.stdout)) as z.infer<S> };
}

/** The run refused with `code` at exit 2. */
function expectRefusal(run: { status: number | null; stderr: string; report: unknown }, code: RefusalCode): void {
  expect(run.status, run.stderr).toBe(ExitCode.ERROR);
  expect(run.report).toMatchObject({ status: 'error', error: { code } });
}

/** A project holding one agent whose manifest is `manifest`, and its system prompt. */
function agentProject(name: string, manifest = PROMPTED_MANIFEST): string {
  return project(name, { 'agent/agent.yaml': manifest, 'agent/prompts/system.md': 'You review widgets.\n' });
}

/** A fake HOME whose user skills directory holds `files`, and that directory. */
function homeWithSkills(name: string, files: Readonly<Record<string, string>> = {}): { home: string; skills: string } {
  const home = freshHome(name);
  const skills = safePath.join(home, '.claude', 'skills');
  mkdirSyncReal(skills, { recursive: true });
  writeFileTree(skills, files);
  return { home, skills };
}

const INSTALLED_USER = ['agent', 'installed', '--scope', 'user'];

/** A project whose `agents/widget-reviewer` is discoverable by name and, unless `built` is false, already built. */
function installableProject(name: string, built = true): string {
  const bundle = built ? { 'dist/vat-bundles/skill/widget-reviewer/SKILL.md': CLEAN_SKILL } : {};
  return project(name, { 'agents/widget-reviewer/agent.yaml': MANIFEST, ...bundle });
}

const INSTALL = ['agent', 'install', 'widget-reviewer'];
const UNINSTALL = ['agent', 'uninstall', 'widget-reviewer'];

describe('vat agent build / import / installed / list / install / uninstall (system test)', () => {
  beforeAll(() => {
    tempDir = createTestTempDir('vat-agent-report-');
  });

  afterAll(() => {
    for (const dir of locked) chmodSync(dir, RESTORED);
    cleanupTestTempDir(tempDir);
  });

  describe('agent build', () => {
    it('publishes the built agent, exit 0', async () => {
      const { status, stderr, report } = await vat(AGENT_BUILD_REPORT_SCHEMA, ['agent', 'build', './agent'], agentProject('build-ok'));

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report).toMatchObject({ status: 'ok', examined: 1, data: { agent: 'widget-reviewer', target: 'skill' } });
      expect(report.status === 'ok' && report.data.files.some((file) => toForwardSlash(file).endsWith('/SKILL.md'))).toBe(true);
    });

    it('refuses a --target it does not build as USAGE_INVALID, exit 2', async () => {
      expectRefusal(await vat(AGENT_BUILD_REPORT_SCHEMA, ['agent', 'build', './agent', '--target', 'langchain'], agentProject('build-target')), 'USAGE_INVALID');
    });

    it('refuses a system prompt $ref naming a directory as INPUT_UNREADABLE, exit 2', async () => {
      const cwd = project('build-prompt-dir', { 'agent/agent.yaml': PROMPTED_MANIFEST, 'agent/prompts/system.md/keep': '' });
      expectRefusal(await vat(AGENT_BUILD_REPORT_SCHEMA, ['agent', 'build', './agent'], cwd), 'INPUT_UNREADABLE');
    });

    // A stale SKILL.md left nested in the output: the packager refuses the bundle's
    // content — the SKILL_PACKAGING_FAILED finding at the agent, on a run that stopped.
    it('publishes a packager refusal as RUN_INCOMPLETE with a SKILL_PACKAGING_FAILED finding, exit 2', async () => {
      const cwd = agentProject('build-packaging');
      writeFileTree(cwd, { 'dist/vat-bundles/skill/widget-reviewer/stale/SKILL.md': CLEAN_SKILL });

      const run = await vat(AGENT_BUILD_REPORT_SCHEMA, ['agent', 'build', './agent'], cwd);

      expectRefusal(run, 'RUN_INCOMPLETE');
      expect(run.report.findings.map(({ code, location }) => ({ code, location }))).toStrictEqual([{ code: 'SKILL_PACKAGING_FAILED', location: 'agent' }]);
    });

    it('refuses a manifest with no system prompt as CONFIG_INVALID, exit 2 — the manifest, not a VAT defect', async () => {
      expectRefusal(await vat(AGENT_BUILD_REPORT_SCHEMA, ['agent', 'build', './agent'], agentProject('build-no-prompt', MANIFEST)), 'CONFIG_INVALID');
    });
  });

  describe('agent import', () => {
    const IMPORT = ['agent', 'import', './skill/SKILL.md'];

    it('publishes the agent.yaml it wrote, exit 0', async () => {
      const cwd = project('import-ok', { 'skill/SKILL.md': CLEAN_SKILL });

      const { status, stderr, report } = await vat(AGENT_IMPORT_REPORT_SCHEMA, IMPORT, cwd);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report.examined).toBe(1);
      const agentPath = report.status === 'ok' ? report.data.agentPath : '';
      expect(toForwardSlash(agentPath)).toBe(toForwardSlash(safePath.join(cwd, 'skill', 'agent.yaml')));
      expect(readFileSync(agentPath, 'utf-8')).toContain('name: widget-skill');
    });

    it('agent import failure refuses with INPUT_UNREADABLE, exit 2', async () => {
      const cwd = project('import-invalid', { 'skill/SKILL.md': '---\nname: [unclosed\n---\n\n# x\n' });
      expectRefusal(await vat(AGENT_IMPORT_REPORT_SCHEMA, IMPORT, cwd), 'INPUT_UNREADABLE');
    });

    it('refuses to overwrite an agent.yaml without --force as USAGE_INVALID, exit 2', async () => {
      const cwd = project('import-exists', { 'skill/SKILL.md': CLEAN_SKILL, 'skill/agent.yaml': 'kept: true\n' });

      expectRefusal(await vat(AGENT_IMPORT_REPORT_SCHEMA, IMPORT, cwd), 'USAGE_INVALID');
      expect(readFileSync(safePath.join(cwd, 'skill', 'agent.yaml'), 'utf-8')).toBe('kept: true\n');
    });
  });

  describe('agent installed', () => {
    it('lists a copied and a symlinked skill with their types, exit 0', async ({ skip }) => {
      const cap = symlinkCapability() ?? skip();
      const { home, skills } = homeWithSkills('installed-two', { 'copied/SKILL.md': CLEAN_SKILL });
      const linkTarget = safePath.join(tempDir, 'link-target');
      writeFileTree(linkTarget, { 'SKILL.md': CLEAN_SKILL });
      createSymlink(cap, linkTarget, safePath.join(skills, 'linked'), 'dir');

      const { status, stderr, report } = await vat(AGENT_INSTALLED_REPORT_SCHEMA, INSTALLED_USER, tempDir, home);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report).toMatchObject({ status: 'ok', examined: 1 });
      const listed = report.status === 'ok' ? report.data.skills.map(({ name, scope, type }) => ({ name, scope, type })) : [];
      expect(listed.toSorted((a, b) => a.name.localeCompare(b.name))).toStrictEqual([
        { name: 'copied', scope: 'user', type: 'directory' },
        { name: 'linked', scope: 'user', type: 'symlink' },
      ]);
    });

    it.skipIf(CANNOT_DENY_READS)('a scope directory the OS will not list is a SCAN_PATH_UNREADABLE warning, exit 0', async () => {
      const { home, skills } = homeWithSkills('installed-locked');
      chmodSync(skills, UNREADABLE);
      locked.push(skills);

      const { status, stderr, report } = await vat(AGENT_INSTALLED_REPORT_SCHEMA, INSTALLED_USER, tempDir, home);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report.status).toBe('findings');
      expect(report.findings.map(({ code, severity, location }) => ({ code, severity, location }))).toStrictEqual([
        { code: 'SCAN_PATH_UNREADABLE', severity: 'warning', location: '.claude/skills' },
      ]);
      expect(report.status === 'findings' && report.data.scanned).toStrictEqual(['user']);
    });

    // Both scopes' directories are `.claude/skills` under their own base, so the
    // location alone cannot say which one: the scope rides in `field`.
    it.skipIf(CANNOT_DENY_READS)('tells two unreadable scopes apart under --scope all', async () => {
      const { home, skills } = homeWithSkills('installed-both-locked');
      const cwd = safePath.join(tempDir, 'both-locked-project');
      const projectSkills = safePath.join(cwd, '.claude', 'skills');
      mkdirSyncReal(projectSkills, { recursive: true });
      for (const dir of [skills, projectSkills]) {
        chmodSync(dir, UNREADABLE);
        locked.push(dir);
      }

      const { status, stderr, report } = await vat(AGENT_INSTALLED_REPORT_SCHEMA, ['agent', 'installed', '--scope', 'all'], cwd, home);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report.findings.map(({ field, location }) => ({ field, location })).toSorted((a, b) => String(a.field).localeCompare(String(b.field)))).toStrictEqual([
        { field: 'project', location: '.claude/skills' },
        { field: 'user', location: '.claude/skills' },
      ]);
    });

    it('refuses a --scope it does not know as USAGE_INVALID, exit 2', async () => {
      expectRefusal(await vat(AGENT_INSTALLED_REPORT_SCHEMA, ['agent', 'installed', '--scope', 'galaxy'], tempDir), 'USAGE_INVALID');
    });
  });

  describe('agent list', () => {
    it('publishes each agent relative to the stated root, exit 0', async () => {
      const cwd = installableProject('list-ok', false);

      const { status, stderr, report } = await vat(AGENT_LIST_REPORT_SCHEMA, ['agent', 'list'], cwd);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report).toMatchObject({ status: 'ok', examined: 3 });
      expect(report.status === 'ok' && toForwardSlash(report.data.root)).toBe(toForwardSlash(cwd));
      expect(report.status === 'ok' && report.data.agents).toStrictEqual([{ name: 'widget-reviewer', version: '0.1.0', path: 'agents/widget-reviewer' }]);
    });

    it.skipIf(CANNOT_DENY_READS)('a search path the OS will not list is one SCAN_PATH_UNREADABLE warning, exit 0', async () => {
      const cwd = installableProject('list-locked', false);
      const agents = safePath.join(cwd, 'agents');
      chmodSync(agents, UNREADABLE);
      locked.push(agents);

      const { status, stderr, report } = await vat(AGENT_LIST_REPORT_SCHEMA, ['agent', 'list'], cwd);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report.findings.map(({ code, severity, location }) => ({ code, severity, location }))).toStrictEqual([
        { code: 'SCAN_PATH_UNREADABLE', severity: 'warning', location: 'agents' },
      ]);
      expect(report.status === 'findings' && report.data.agents).toStrictEqual([]);
    });
  });

  describe('agent install', () => {
    it('agent install publishes the install path', async () => {
      const home = freshHome('install-ok');

      const { status, stderr, report } = await vat(AGENT_INSTALL_REPORT_SCHEMA, INSTALL, installableProject('install-ok'), home);

      expect(status, stderr).toBe(ExitCode.OK);
      const installPath = safePath.join(home, '.claude', 'skills', 'widget-reviewer');
      expect(report).toMatchObject({ status: 'ok', examined: 1, data: { agent: 'widget-reviewer', symlink: false } });
      expect(report.status === 'ok' && toForwardSlash(report.data.installPath)).toBe(toForwardSlash(installPath));
      expect(readFileSync(safePath.join(installPath, 'SKILL.md'), 'utf-8')).toBe(CLEAN_SKILL);
    });

    it('refuses an install over an existing one without --force as USAGE_INVALID, and --force replaces it', async () => {
      const { home } = homeWithSkills('install-exists', { 'widget-reviewer/SKILL.md': 'kept\n' });
      const cwd = installableProject('install-exists');

      expectRefusal(await vat(AGENT_INSTALL_REPORT_SCHEMA, INSTALL, cwd, home), 'USAGE_INVALID');
      const installed = safePath.join(home, '.claude', 'skills', 'widget-reviewer', 'SKILL.md');
      expect(readFileSync(installed, 'utf-8')).toBe('kept\n');
      const forced = await vat(AGENT_INSTALL_REPORT_SCHEMA, [...INSTALL, '--force'], cwd, home);
      expect(forced.status, forced.stderr).toBe(ExitCode.OK);
      expect(readFileSync(installed, 'utf-8')).toBe(CLEAN_SKILL);
    });

    it('installs --dev as a symlink to the built bundle, and says so', async ({ skip }) => {
      if (process.platform === 'win32' || symlinkCapability() === null) skip('--dev is refused on Windows, and this host cannot create symlinks');
      const home = freshHome('install-dev');
      const cwd = installableProject('install-dev');

      const { status, stderr, report } = await vat(AGENT_INSTALL_REPORT_SCHEMA, [...INSTALL, '--dev'], cwd, home);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report).toMatchObject({ status: 'ok', data: { symlink: true } });
      const installPath = safePath.join(home, '.claude', 'skills', 'widget-reviewer');
      expect(lstatSync(installPath).isSymbolicLink()).toBe(true);
      expect(toForwardSlash(normalizePath(installPath))).toBe(toForwardSlash(normalizePath(safePath.join(cwd, 'dist/vat-bundles/skill/widget-reviewer'))));
    });

    // A bundle holding a link that escapes it: copying would ship content the bundle does not own.
    it('refuses a bundle whose symlink escapes it as INPUT_UNREADABLE, exit 2', async ({ skip }) => {
      const cap = symlinkCapability() ?? skip();
      const cwd = installableProject('install-escaping-link');
      createSymlink(cap, safePath.join(cwd, 'package.json'), safePath.join(cwd, 'dist/vat-bundles/skill/widget-reviewer/outside.json'), 'file');

      expectRefusal(await vat(AGENT_INSTALL_REPORT_SCHEMA, INSTALL, cwd), 'INPUT_UNREADABLE');
    });

    it('refuses an agent whose bundle was never built as INPUT_UNREADABLE, exit 2', async () => {
      expectRefusal(await vat(AGENT_INSTALL_REPORT_SCHEMA, INSTALL, installableProject('install-unbuilt', false)), 'INPUT_UNREADABLE');
    });

    it('refuses a name that is not one path segment as USAGE_INVALID, exit 2', async () => {
      expectRefusal(await vat(AGENT_INSTALL_REPORT_SCHEMA, ['agent', 'install', '../escape'], installableProject('install-escape')), 'USAGE_INVALID');
    });
  });

  describe('agent uninstall', () => {
    it('publishes the removed install, exit 0', async () => {
      const { home, skills } = homeWithSkills('uninstall-ok', { 'widget-reviewer/SKILL.md': CLEAN_SKILL });

      const { status, stderr, report } = await vat(AGENT_UNINSTALL_REPORT_SCHEMA, UNINSTALL, tempDir, home);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report).toMatchObject({ status: 'ok', examined: 1, data: { agent: 'widget-reviewer', wasSymlink: false } });
      expect(report.status === 'ok' && toForwardSlash(report.data.installPath)).toBe(toForwardSlash(safePath.join(skills, 'widget-reviewer')));
      expect(() => lstatSync(safePath.join(skills, 'widget-reviewer'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    });

    // A `--dev` link whose build was cleaned: the entry is there, its target is not.
    it('removes a dangling --dev link rather than calling it not installed', async ({ skip }) => {
      const cap = symlinkCapability() ?? skip();
      const { home, skills } = homeWithSkills('uninstall-dangling');
      createSymlink(cap, safePath.join(tempDir, 'never-built'), safePath.join(skills, 'widget-reviewer'), 'dir');

      const { status, stderr, report } = await vat(AGENT_UNINSTALL_REPORT_SCHEMA, UNINSTALL, tempDir, home);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report).toMatchObject({ status: 'ok', data: { wasSymlink: true } });
      expect(() => lstatSync(safePath.join(skills, 'widget-reviewer'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    });

    it('refuses an agent that is not installed as USAGE_INVALID, exit 2', async () => {
      expectRefusal(await vat(AGENT_UNINSTALL_REPORT_SCHEMA, UNINSTALL, tempDir), 'USAGE_INVALID');
    });
  });
});
