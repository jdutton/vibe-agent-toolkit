/**
 * Check 16 of `pre-publish-check --release-readiness`, end to end: the flag on
 * the command line reaches the known-defects gate, and a blocking entry stops a
 * stable version with FINDINGS, naming the entry. The gate's own decision is
 * unit-tested in `known-defects-gate.test.ts`; this file pins only the wiring a
 * unit test cannot see — a hard-wired `releaseReadiness: false`, or a deleted
 * Check 16, passes every unit test and is red here.
 *
 * Integration tier: it spawns the script against a fixture tree (a git repo
 * with a bare local `origin`, so the remote-tag check never touches a network).
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable, NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { STABLE_TAG_BLOCKER_MARKER } from '../../src/known-defects-gate.js';
import { cleanupTestTempDir, createTestTempDir } from '../test-helpers.js';

const PACKAGE_DIR = safePath.resolve(import.meta.dirname, '..', '..');
const SCRIPT = safePath.join(PACKAGE_DIR, 'src', 'pre-publish-check.ts');
const BLOCKING_ENTRY = 'A fixture defect that blocks the stable tag';

function git(cwd: string, args: string[]): void {
  const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function write(root: string, relative: string, content: string): void {
  const absolute = safePath.join(root, relative);
  mkdirSyncReal(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

/**
 * A tree every earlier check passes over: one private umbrella package carrying
 * `version`, a CHANGELOG whose section for it has content, and a register.
 */
function fixtureTree(version: string, register: string, remote: string): string {
  const root = createTestTempDir({ prefix: 'pre-publish-known-defects-' });
  write(root, 'package.json', JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['packages/*'] }));
  write(
    root,
    'packages/vibe-agent-toolkit/package.json',
    JSON.stringify({ name: 'vibe-agent-toolkit', version, private: true }),
  );
  write(root, 'CHANGELOG.md', `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-01-01\n\n- A change.\n`);
  write(root, 'docs/contributing/known-defects.md', register);

  git(root, ['init', '-b', 'main', '--quiet']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  git(root, ['init', '--bare', '--quiet', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  return root;
}

function register(blocking: boolean): string {
  return `# Known defects\n\n### ${BLOCKING_ENTRY}\n\n${blocking ? STABLE_TAG_BLOCKER_MARKER : '- **Severity:** Minor'}\n`;
}

function prePublish(root: string): { status: number | null; stdout: string } {
  const result = spawnSync(
    NODE_EXECUTABLE,
    ['--import', 'tsx', SCRIPT, '--root', root, '--skip-git-checks', '--release-readiness'],
    { cwd: PACKAGE_DIR, encoding: 'utf8' },
  );
  return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
}

/** Every temp directory a case made, removed after it. */
const dirs: string[] = [];

/** A fixture tree at `version` whose register blocks the stable tag or not, plus its `origin`. */
function tree(version: string, blocking: boolean): string {
  const remote = createTestTempDir({ prefix: 'pre-publish-known-defects-origin-' });
  const root = fixtureTree(version, register(blocking), remote);
  dirs.push(root, remote);
  return root;
}

describe('pre-publish-check --release-readiness: Check 16 (known defects)', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTestTempDir(dir);
  });

  it('refuses a stable version with FINDINGS, naming the blocking entry', () => {
    const { status, stdout } = prePublish(tree('1.0.0', true));
    expect(stdout).toContain('Checking known defects that block the stable tag');
    expect(stdout).toContain(`- ${BLOCKING_ENTRY}`);
    expect(status).toBe(ExitCode.FINDINGS);
  });

  it('passes a prerelease over the same blocking entry', () => {
    const { status, stdout } = prePublish(tree('1.0.0-rc.1', true));
    expect(stdout).toContain('No known defect blocks this version');
    expect(status).toBe(ExitCode.OK);
  });

  it('passes a stable version whose register blocks nothing', () => {
    const { status, stdout } = prePublish(tree('1.0.0', false));
    expect(stdout).toContain('No known defect blocks this version');
    expect(status).toBe(ExitCode.OK);
  });

  it('refuses to run without --root rather than checking whatever tree it stands in', () => {
    const result = spawnSync(NODE_EXECUTABLE, ['--import', 'tsx', SCRIPT, '--skip-git-checks'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
    });
    expect(result.stderr).toContain('--root DIR is required');
    expect(result.status).toBe(ExitCode.ERROR);
  });
});
