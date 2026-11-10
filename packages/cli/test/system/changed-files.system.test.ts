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
/** A statement whose FIRST relation does not exist, beside `changed_files`. */
const TYPO_BESIDE_CHANGED_FILES = 'SELECT c.path FROM typo_tbl t, changed_files c';

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

/** A run that must fail, as its broken findings' `[check, message, reason]`. */
function brokenTriples(run: Run): unknown[] {
  expect(run.status).toBe(1);
  return brokenFindings(run).map((finding) => [finding['check'], finding['message'], finding['reason']]);
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

    // The query verb compiles its statement against every relation before any lens runs, so the
    // typo is the first fault it can name — a usage error naming the typo, not the lens.
    it('refuses a statement naming a missing table beside changed_files at compile, naming the typo', () => {
      const run = query(branchDir, TYPO_BESIDE_CHANGED_FILES, []);

      expect(run.status).toBe(2);
      expect(run.error?.code).toBe('USAGE_INVALID');
      expect(run.error?.message).toContain('no such table: typo_tbl');
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

    // The crawl meets the missing binary before the lens does. Its silence must be attributed to the
    // environment (BACKEND_UNAVAILABLE, naming PATH), never to the repository, never INTERNAL_ERROR.
    it('refuses as BACKEND_UNAVAILABLE naming PATH when git is not on PATH', () => {
      const gitless = safePath.join(base, 'gitless-path');
      fs.mkdirSync(gitless, { recursive: true });
      // Every spelling of the PATH key the ambient environment uses (Windows spells it `Path`).
      const pathKeys = Object.keys(process.env).filter((key) => key.toUpperCase() === 'PATH');
      const noGit = Object.fromEntries((pathKeys.length === 0 ? ['PATH'] : pathKeys).map((key) => [key, gitless]));

      const run = vat(branchDir, ['resources', 'query', 'SELECT path, status FROM changed_files', '--base', 'main', '--format', 'json'], {
        ...env,
        ...noGit,
      });

      expect(run.status, run.stderr).toBe(2);
      expect(run.error?.code).toBe('BACKEND_UNAVAILABLE');
      expect(run.error?.message).toContain('git was not found on PATH');
      expect(run.error?.message).not.toContain('not a git repository');
    });

    // The crawl's snapshot meets the stray file before the lens does: it must name the sparse cause
    // and its three fixes, never "not a git repository".
    it('refuses a sparse checkout holding a stray untracked file as INPUT_UNREADABLE, naming the three fixes', () => {
      const sparse = committedRepo('sparse');
      put(sparse, 'outside/kept.md', '# Outside the definition\n');
      git(sparse, ['add', '-A']);
      git(sparse, ['commit', '-q', '-m', 'outside']);
      git(sparse, ['sparse-checkout', 'set', '--no-cone', '/docs/']);
      put(sparse, 'stray.md', '# Stray, outside the sparse definition\n');

      const run = query(sparse, 'SELECT path FROM changed_files', ['--base', 'main']);

      expect(run.status, run.stderr).toBe(2);
      expect(run.error?.code).toBe('INPUT_UNREADABLE');
      expect(run.error?.message).toMatch(/"stray\.md".*sparse-checkout definition.*git sparse-checkout add.*remove.*\.gitignore/s);
      expect(run.error?.message).not.toContain('not a git repository');
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

    // SQLite names only the FIRST missing table — the typo — so a code read from its text called this
    // a usage error by luck, and the missing --base never got its remedy.
    it('carries the lens\'s refusal on a check that also names a missing table, by the relations it names', () => {
      writeChecks(branchDir, `    typo-docs:\n      description: typo beside changed_files\n      sql: "${TYPO_BESIDE_CHANGED_FILES}"\n`);

      expect(brokenTriples(vat(branchDir, ['resources', 'check', '--format', 'json'], env))).toStrictEqual([
        ['typo-docs', expect.stringContaining(NO_BASE_FIX), { refusal: 'USAGE_INVALID' }],
      ]);
    });

    it('fails a check defining a CTE named changed_files as broken, naming the reserved name rather than --base', () => {
      writeChecks(
        branchDir,
        '    shadowing-cte:\n      description: a CTE in the relation\'s name\n'
        + '      sql: "WITH changed_files AS (SELECT path FROM resource_realizations) SELECT path FROM changed_files"\n',
      );

      const triples = brokenTriples(vat(branchDir, ['resources', 'check', '--format', 'json'], env));

      expect(triples).toStrictEqual([
        ['shadowing-cte', expect.stringContaining('`changed_files` is a reserved relation name; rename the CTE'), { refusal: 'USAGE_INVALID' }],
      ]);
      expect(String((triples[0] as unknown[])[1])).not.toContain(NO_BASE_FIX);
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
        ['changed-docs', expect.stringMatching(/more output than VAT reads/), { refusal: 'BACKEND_UNAVAILABLE' }],
      ]);
    });

    // `--base` is read only when a statement names `changed_files`: a bad ref beside checks that never
    // read it is no fault, and git is never asked about it (a logging git on PATH proves the second).
    it.skipIf(process.platform === 'win32')('accepts and never resolves --base when no statement names changed_files', () => {
      writeChecks(
        branchDir,
        '    no-lens:\n      description: nothing violates\n'
        + "      sql: \"SELECT path FROM resource_realizations WHERE path = 'none'\"\n",
      );
      const shim = safePath.join(base, 'logging-git');
      const log = safePath.join(shim, 'calls.log');
      fs.mkdirSync(shim, { recursive: true });
      fs.writeFileSync(log, '', 'utf-8');
      fs.writeFileSync(
        safePath.join(shim, 'git'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${gitExecutable()}" "$@"\n`,
        { encoding: 'utf-8', mode: 0o755 },
      );

      const run = vat(branchDir, ['resources', 'check', '--base', 'no-such-ref', '--format', 'json'], {
        ...env,
        PATH: `${shim}${delimiter}${process.env['PATH'] ?? ''}`,
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.error).toBeUndefined();
      expect(brokenFindings(run)).toStrictEqual([]);
      expect(run.data['lensesEvaluated']).not.toContain('changed-files');
      const calls = fs.readFileSync(log, 'utf-8');
      // The shim is the git VAT runs (the population lists the tree through it), so its silence counts.
      expect(calls).toMatch(/ls-files/);
      expect(calls).not.toContain('no-such-ref');
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
