/**
 * `changed_files` and `--base`, end to end through the built binary over a real repository: the
 * flag reaching the lens from `vat resources query`, `vat resources check` (through its supervised
 * child) and `vat validate` (through its checks phase), and every refusal reaching the operator
 * with its reason. The pieces are unit-tested; this file is the wiring between them.
 *
 * The fixture is a branch BEHIND `main`: `main` moved on after the branch left it, so a run that
 * compared with `main`'s tip instead of the merge base would list `docs/main-only.md` too.
 */

import { delimiter } from 'node:path';

import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, createTestTempDir, fs, safePath } from './test-common.js';
import { checksPhase, vat, type Run } from './test-helpers/checks-phase.js';

// ⛔ Every `vat` process (and its checks child) inherits the scratch TMPDIR.
useScratchTmpdir('vat-scratch-changed-files-');

/** The two files the branch touched under `docs/`: one edited, one new and untracked. */
const BRANCH_CHANGES = [{ path: 'docs/a.md', status: 'modified' }, { path: 'docs/c.md', status: 'added' }];
const CHANGED_DOCS_SQL = "SELECT c.path FROM changed_files c WHERE c.path LIKE 'docs/%' ORDER BY c.path";
const BROKEN = 'RESOURCE_CHECK_BROKEN';
/** The no-base refusal's fix, as the lens words it. */
const NO_BASE_FIX = 'Pass --base <ref>';

let base: string;
let branchDir: string;
let cleanDir: string;
let env: Record<string, string>;

/** Run git in `cwd` with the fixture's identity and the stubbed home, inherited `GIT_*` scrubbed, failing loudly. */
function git(cwd: string, args: readonly string[]): void {
  runGitOrThrow([
    '-c', 'user.name=VAT Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args,
  ], { cwd, env });
}

/** Write `content` at `relative` under `dir`. */
function put(dir: string, relative: string, content: string): void {
  const target = safePath.join(dir, relative);
  fs.mkdirSync(safePath.join(target, '..'), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
}

/** A repository on an unborn `main` holding an uncommitted `docs/a.md`. */
function unbornRepo(name: string): string {
  const dir = safePath.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  put(dir, 'docs/a.md', '# Alpha\n');
  return dir;
}

/** A repository with `docs/a.md` and `docs/b.md` committed on `main`. */
function committedRepo(name: string): string {
  const dir = unbornRepo(name);
  put(dir, 'docs/b.md', '# Bravo\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

/** Write a config whose `resources.checks` is exactly `checks` (YAML, already indented by four). */
function writeChecks(dir: string, checks: string): void {
  fs.writeFileSync(safePath.join(dir, 'vibe-agent-toolkit.config.yaml'), `resources:\n  checks:\n${checks}`, 'utf-8');
}

/** The `changed-docs` check: one finding per changed file under `docs/`. */
const CHANGED_DOCS_CHECK = `    changed-docs:\n      description: changed doc\n      sql: "${CHANGED_DOCS_SQL}"\n`;

/** `vat resources query <sql> [--base <ref>] --format json` in `cwd`. */
function query(cwd: string, sql: string, baseArgs: readonly string[]): Run {
  return vat(cwd, ['resources', 'query', sql, ...baseArgs, '--format', 'json'], env);
}

/** The run's `RESOURCE_CHECK_BROKEN` findings. */
function brokenFindings(run: Run): Array<Record<string, unknown>> {
  return (run.findings as unknown as Array<Record<string, unknown>>).filter((finding) => finding['code'] === BROKEN);
}

/** The findings of a run with `code`, as `[location, check]`. */
function findingsWith(run: Run, code: string): unknown[] {
  return (run.findings as unknown as Array<Record<string, unknown>>)
    .filter((finding) => finding['code'] === code)
    .map((finding) => [finding['location'], finding['check']]);
}

describe('changed_files and --base, end to end', () => {
  beforeAll(() => {
    base = createTestTempDir('vat-changed-files-');
    const home = safePath.join(base, 'home');
    fs.mkdirSync(home, { recursive: true });
    env = { HOME: home, XDG_CONFIG_HOME: home, CLAUDE_CONFIG_DIR: safePath.join(home, '.claude'), USERPROFILE: home };

    branchDir = committedRepo('branch');
    git(branchDir, ['switch', '-q', '-c', 'feature']);
    git(branchDir, ['switch', '-q', 'main']);
    put(branchDir, 'docs/main-only.md', '# Main moved on\n');
    git(branchDir, ['add', '-A']);
    git(branchDir, ['commit', '-q', '-m', 'main moves']);
    git(branchDir, ['switch', '-q', 'feature']);
    put(branchDir, 'docs/a.md', '# Alpha, edited on the branch\n');
    put(branchDir, 'docs/c.md', '# Charlie, new and untracked\n');

    cleanDir = committedRepo('clean');
  });

  afterAll(() => {
    cleanupTestTempDir(base);
  });

  describe('vat resources query', () => {
    it('lists what the branch touched since its merge base with --base', () => {
      const run = query(branchDir, 'SELECT path, status FROM changed_files ORDER BY path', ['--base', 'main']);

      expect(run.status, run.stderr).toBe(0);
      expect(run.data['rows']).toStrictEqual(BRANCH_CHANGES);
    });

    it('refuses without --base (USAGE_INVALID, exit 2), carrying the lens\'s reason', () => {
      const run = query(branchDir, 'SELECT path FROM changed_files', []);

      expect(run.status).toBe(2);
      expect(run.error?.code).toBe('USAGE_INVALID');
      expect(run.error?.message).toContain(NO_BASE_FIX);
    });

    it('refuses a ref that names no commit as USAGE_INVALID, carrying git\'s reason', () => {
      const run = query(branchDir, 'SELECT path FROM changed_files', ['--base', 'no-such-branch']);

      expect(run.status).toBe(2);
      expect(run.error?.code).toBe('USAGE_INVALID');
      expect(run.error?.message).toContain('"no-such-branch" does not name a commit');
    });

    it('refuses a repository with no commits as INPUT_UNREADABLE, not a usage error', () => {
      const run = query(unbornRepo('unborn'), 'SELECT path FROM changed_files', ['--base', 'main']);

      expect(run.status).toBe(2);
      expect(run.error?.code).toBe('INPUT_UNREADABLE');
      expect(run.error?.message).toContain('no commits yet');
    });

    it('answers an honestly empty diff with a table of zero rows, not a missing relation', () => {
      const run = query(cleanDir, 'SELECT path FROM changed_files', ['--base', 'main']);

      expect(run.status, run.stderr).toBe(0);
      expect(run.data['columns']).toStrictEqual(['path']);
      expect(run.data['rows']).toStrictEqual([]);
    });
  });

  describe('vat resources check', () => {
    it('reports a violation per changed file with --base', () => {
      writeChecks(branchDir, CHANGED_DOCS_CHECK);

      const run = vat(branchDir, ['resources', 'check', '--base', 'main', '--format', 'json'], env);

      expect(run.status, run.stderr).toBe(1);
      expect(findingsWith(run, 'CUSTOM:changed-docs')).toStrictEqual([['docs/a.md', 'changed-docs'], ['docs/c.md', 'changed-docs']]);
      expect(run.data['lensesEvaluated']).toContain('changed-files');
    });

    it('fails the check that reads changed_files without --base as broken, naming the fix', () => {
      writeChecks(branchDir, CHANGED_DOCS_CHECK);

      const run = vat(branchDir, ['resources', 'check', '--format', 'json'], env);

      expect(run.status).toBe(1);
      const broken = brokenFindings(run);
      expect(broken.map((finding) => finding['check'])).toStrictEqual(['changed-docs']);
      expect(String(broken[0]?.['message'])).toContain(NO_BASE_FIX);
      expect(broken[0]?.['reason']).toStrictEqual({ refusal: 'USAGE_INVALID' });
      // A refused lens produced no relation, so it is not reported as evaluated.
      expect(run.data['lensesEvaluated']).not.toContain('changed-files');
    });

    it('names the repository cause in the broken finding when the lens cannot be evaluated', () => {
      const unborn = unbornRepo('unborn-check');
      writeChecks(unborn, CHANGED_DOCS_CHECK);

      const run = vat(unborn, ['resources', 'check', '--base', 'main', '--format', 'json'], env);

      expect(run.status).toBe(1);
      expect(brokenFindings(run).map((finding) => [finding['check'], finding['message'], finding['reason']])).toStrictEqual([
        ['changed-docs', expect.stringContaining('no commits yet'), { refusal: 'INPUT_UNREADABLE' }],
      ]);
    });

    // A `git` ahead of the real one on PATH whose `merge-base` writes more than VAT reads: git did
    // not run to completion, which only the code — not the exit status — tells apart.
    it.skipIf(process.platform === 'win32')('carries BACKEND_UNAVAILABLE when git could not finish', () => {
      writeChecks(branchDir, CHANGED_DOCS_CHECK);
      const shim = safePath.join(base, 'overrunning-git');
      fs.mkdirSync(shim, { recursive: true });
      fs.writeFileSync(
        safePath.join(shim, 'git'),
        `#!/bin/sh\ncase " $* " in *" merge-base "*) head -c 70000000 /dev/zero; exit 0;; esac\nexec "${gitExecutable()}" "$@"\n`,
        { encoding: 'utf-8', mode: 0o755 },
      );

      const run = vat(branchDir, ['resources', 'check', '--base', 'main', '--format', 'json'], {
        ...env,
        PATH: `${shim}${delimiter}${process.env['PATH'] ?? ''}`,
      });

      expect(run.status).toBe(1);
      expect(brokenFindings(run).map((finding) => [finding['check'], finding['message'], finding['reason']])).toStrictEqual([
        ['changed-docs', expect.stringContaining('nearer base'), { refusal: 'BACKEND_UNAVAILABLE' }],
      ]);
    });

    it('evaluates the lens for a check that names changed_files only in its examined statement', () => {
      writeChecks(
        branchDir,
        '    examined-changes:\n      description: nothing violates\n'
        + "      sql: \"SELECT path FROM resource_realizations WHERE path = 'none'\"\n"
        + `      examined: "SELECT COUNT(*) FROM changed_files c WHERE c.path LIKE 'docs/%'"\n`,
      );

      const run = vat(branchDir, ['resources', 'check', '--base', 'main', '--format', 'json'], env);

      expect(run.status, run.stderr).toBe(0);
      const entry = (run.data['checks'] as Array<Record<string, unknown>>).find((check) => check['name'] === 'examined-changes');
      expect(entry).toMatchObject({ rows: 0, examined: BRANCH_CHANGES.length });
      expect(entry).not.toHaveProperty('broken');
    });
  });

  describe('vat validate', () => {
    it('hands --base to its checks phase, whose check then sees the branch\'s changes', () => {
      writeChecks(branchDir, CHANGED_DOCS_CHECK);

      const run = vat(branchDir, ['validate', '--base', 'main'], env);

      expect(checksPhase(run).status).toBe('findings');
      expect(findingsWith(run, 'CUSTOM:changed-docs')).toStrictEqual([['docs/a.md', 'changed-docs'], ['docs/c.md', 'changed-docs']]);
      expect(findingsWith(run, BROKEN)).toStrictEqual([]);
    });
  });
});
