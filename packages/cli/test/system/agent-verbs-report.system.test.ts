/**
 * `vat agent build`, `import`, `installed`, `list`, `install` and `uninstall`
 * publish the report envelope — observed through the built CLI, each document
 * read back with the verb's registered schema.
 *
 * Every run takes a fake HOME: the user scope is `~/.claude/skills`, and nothing
 * here may read — or install into — the developer's real one.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';

import { ExitCode, type RefusalCode } from '@vibe-agent-toolkit/schema';
import { createSymlink, mkdirSyncReal, normalizePath, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, gitExecutable, resolveExecutable } from '@vibe-agent-toolkit/utils/testing';
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
/** The owner's read, write and search bits — what an install root must keep for anything to remove it. */
const OWNER_RWX = 0o700;

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

    // A SKILL.md the agent's scripts/ carries lands nested in the bundle: the packager refuses the
    // bundle's content — the SKILL_PACKAGING_FAILED finding at the agent, on a run that stopped.
    // (A stale one in a previous build no longer reaches it: the build replaces the output whole.)
    it('publishes a packager refusal as RUN_INCOMPLETE with a SKILL_PACKAGING_FAILED finding, exit 2', async () => {
      const cwd = agentProject('build-packaging');
      writeFileTree(cwd, { 'agent/scripts/stale/SKILL.md': CLEAN_SKILL });

      const run = await vat(AGENT_BUILD_REPORT_SCHEMA, ['agent', 'build', './agent'], cwd);

      expectRefusal(run, 'RUN_INCOMPLETE');
      expect(run.report.findings.map(({ code, location }) => ({ code, location }))).toStrictEqual([{ code: 'SKILL_PACKAGING_FAILED', location: 'agent' }]);
    });

    // VAT never overwrites what it did not produce: the `skills package -o` rule, and its check.
    it('refuses an --output already holding the user\'s files as USAGE_INVALID naming it, and --force replaces it', async () => {
      const cwd = agentProject('build-occupied');
      writeFileTree(cwd, { 'userout/widget-reviewer/SKILL.md': 'USER precious\n' });
      const userSkill = safePath.join(cwd, 'userout', 'widget-reviewer', 'SKILL.md');

      const refused = await vat(AGENT_BUILD_REPORT_SCHEMA, ['agent', 'build', './agent', '--output', 'userout'], cwd);
      expectRefusal(refused, 'USAGE_INVALID');
      expect(refused.report.status === 'error' ? refused.report.error.message : '').toContain('userout/widget-reviewer');
      expect(readFileSync(userSkill, 'utf-8')).toBe('USER precious\n');

      const forced = await vat(AGENT_BUILD_REPORT_SCHEMA, ['agent', 'build', './agent', '--output', 'userout', '--force'], cwd);
      expect(forced.status, forced.stderr).toBe(ExitCode.OK);
      expect(readFileSync(userSkill, 'utf-8')).toContain('name: widget-reviewer');
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
      // The staged copy an interrupted install leaves beside a skill is not an install.
      const { home, skills } = homeWithSkills('installed-two', { 'copied/SKILL.md': CLEAN_SKILL, '.copied.vat-staged-x1y2z3/SKILL.md': CLEAN_SKILL });
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

    // Copying a pipe blocks until a writer appears, and `--force` used to remove the
    // previous install first: the run hung with the user left holding neither.
    it.skipIf(process.platform === 'win32')('--force refuses a named pipe in the bundle as INPUT_UNREADABLE without blocking, and keeps the previous install (mkfifo is POSIX-only)', async () => {
      const { home } = homeWithSkills('install-fifo', { 'widget-reviewer/SKILL.md': 'kept\n' });
      const cwd = installableProject('install-fifo');
      const fifo = safePath.join(cwd, 'dist/vat-bundles/skill/widget-reviewer/zpipe');
      execFileSync(resolveExecutable('mkfifo'), [fifo]);
      // A run that blocked on the pipe is released after a while (opening read-write never blocks, and is a
      // writer), so a regression fails on the assertions below instead of hanging the suite.
      const release = setTimeout(() => closeSync(openSync(fifo, 'r+')), 5000);
      try {
        expectRefusal(await vat(AGENT_INSTALL_REPORT_SCHEMA, [...INSTALL, '--force'], cwd, home), 'INPUT_UNREADABLE');
      } finally {
        clearTimeout(release);
      }
      const skills = safePath.join(home, '.claude', 'skills');
      expect(readFileSync(safePath.join(skills, 'widget-reviewer', 'SKILL.md'), 'utf-8')).toBe('kept\n');
      expect(readdirSync(skills)).toEqual(['widget-reviewer']);
    });

    // A bundle built in a read-only checkout (or chmod'd by a packaging step) used to
    // install as a 0555 root that `vat agent uninstall` could not empty.
    it.skipIf(process.platform === 'win32')('installs a read-only bundle owner-writable, so uninstall removes it (POSIX modes)', async () => {
      const home = freshHome('install-readonly-bundle');
      const cwd = installableProject('install-readonly-bundle');
      const bundle = safePath.join(cwd, 'dist/vat-bundles/skill/widget-reviewer');
      chmodSync(bundle, 0o555);
      locked.push(bundle);

      const installed = await vat(AGENT_INSTALL_REPORT_SCHEMA, INSTALL, cwd, home);
      expect(installed.status, installed.stderr).toBe(ExitCode.OK);
      const installPath = safePath.join(home, '.claude', 'skills', 'widget-reviewer');
      expect(statSync(installPath).mode & OWNER_RWX).toBe(OWNER_RWX);

      const removed = await vat(AGENT_UNINSTALL_REPORT_SCHEMA, UNINSTALL, cwd, home);
      expect(removed.status, removed.stderr).toBe(ExitCode.OK);
      expect(() => lstatSync(installPath)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    });

    // The bundle is the input: a file in it the OS will not read is INPUT_UNREADABLE (as
    // the help says), never RUN_INCOMPLETE — and the previous install is kept.
    it.skipIf(CANNOT_DENY_READS)('--force refuses a bundle file the OS will not read as INPUT_UNREADABLE naming it, and keeps the previous install', async () => {
      const { home, skills } = homeWithSkills('install-unreadable-file', { 'widget-reviewer/SKILL.md': 'kept\n' });
      const cwd = installableProject('install-unreadable-file');
      const secret = safePath.join(cwd, 'dist/vat-bundles/skill/widget-reviewer/secret.md');
      writeFileTree(cwd, { 'dist/vat-bundles/skill/widget-reviewer/secret.md': 'secret\n' });
      chmodSync(secret, UNREADABLE);

      const run = await vat(AGENT_INSTALL_REPORT_SCHEMA, [...INSTALL, '--force'], cwd, home);
      expectRefusal(run, 'INPUT_UNREADABLE');
      expect(JSON.stringify(run.report)).toContain('secret.md');
      expect(readFileSync(safePath.join(skills, 'widget-reviewer', 'SKILL.md'), 'utf-8')).toBe('kept\n');
    });

    it('refuses a bundle holding a dangling link as INPUT_UNREADABLE naming it', async ({ skip }) => {
      const cap = symlinkCapability() ?? skip();
      const cwd = installableProject('install-dangling-link');
      createSymlink(cap, safePath.join(cwd, 'nowhere.md'), safePath.join(cwd, 'dist/vat-bundles/skill/widget-reviewer/dangling.md'), 'file');

      const run = await vat(AGENT_INSTALL_REPORT_SCHEMA, INSTALL, cwd);
      expectRefusal(run, 'INPUT_UNREADABLE');
      expect(JSON.stringify(run.report)).toContain('dangling.md');
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

  // Both scopes resolve when the verb runs: `--cwd` moves the project scope, and
  // the user scope is wherever CLAUDE_CONFIG_DIR points — not where HOME does.
  describe('scope resolution', () => {
    it('--cwd moves the project scope: uninstall removes from the named tree, not the launch directory', async () => {
      const target = project('scope-cwd-target', { '.claude/skills/widget-reviewer/SKILL.md': CLEAN_SKILL });
      const launch = project('scope-cwd-launch', { '.claude/skills/widget-reviewer/SKILL.md': CLEAN_SKILL });

      const { status, stderr, report } = await vat(AGENT_UNINSTALL_REPORT_SCHEMA, ['--cwd', target, ...UNINSTALL, '--scope', 'project'], launch);

      expect(status, stderr).toBe(ExitCode.OK);
      expect(report.status === 'ok' && toForwardSlash(normalizePath(report.data.installPath)))
        .toBe(toForwardSlash(normalizePath(safePath.join(target, '.claude', 'skills', 'widget-reviewer'))));
      expect(() => lstatSync(safePath.join(target, '.claude', 'skills', 'widget-reviewer'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      expect(lstatSync(safePath.join(launch, '.claude', 'skills', 'widget-reviewer')).isDirectory()).toBe(true);
    });

    it('installs the user scope under CLAUDE_CONFIG_DIR, where installed then finds it', async () => {
      const root = installableProject('scope-config-dir');
      const home = freshHome('scope-config-dir');
      const configDir = safePath.join(tempDir, 'relocated-claude');
      const env = { ...fakeHomeEnv(home), CLAUDE_CONFIG_DIR: configDir };

      const install = await executeCli(binPath, INSTALL, { cwd: root, env });
      const installed = await executeCli(binPath, INSTALLED_USER, { cwd: root, env });

      expect(install.status, install.stderr).toBe(ExitCode.OK);
      expect(lstatSync(safePath.join(configDir, 'skills', 'widget-reviewer', 'SKILL.md')).isFile()).toBe(true);
      expect(() => lstatSync(safePath.join(home, '.claude', 'skills', 'widget-reviewer'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      const listed = AGENT_INSTALLED_REPORT_SCHEMA.parse(yaml.parse(installed.stdout));
      expect(listed.status === 'error' ? [] : listed.data.skills.map((s) => s.name)).toEqual(['widget-reviewer']);
    });
  });
});
