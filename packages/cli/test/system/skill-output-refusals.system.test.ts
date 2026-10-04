/**
 * Every skill-packaging lane ends an output it cannot write on RUN_INCOMPLETE
 * (exit 2) — never a SKILL_PACKAGING_FAILED finding against the skill, never
 * INTERNAL_ERROR — and none of them deletes or re-modes what the operator owns.
 *
 * One fixture shape per lane, from the exit-code matrix's helpers; each case
 * makes ONE thing about the output unwritable and asserts the published code.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { executeCli } from './test-helpers/cli-runner.js';
import {
  BUILDABLE_AGENT_FILES,
  CLEAN_EVALS,
  CLEAN_SKILL,
  documentOf,
  hasClaude,
  MATRIX_BIN_PATH,
  PLUGIN_BUILD_CONFIG,
  PLUGIN_BUILD_FILES,
  project,
  SKILLS_CONFIG,
  useMatrixTempDir,
} from './test-helpers/exit-code-matrix.js';

const SKILL_MD = 'skills/clean/SKILL.md';
const UNWRITABLE = 0o555;
const PER_TEST_TIMEOUT_MS = 60_000;

/** Paths a case made unwritable or unreadable, restored after it so the suite can remove its temp dir. */
const locked: string[] = [];

function lock(path: string, mode: number): string {
  chmodSync(path, mode);
  locked.push(path);
  return path;
}

/** Run the built CLI in `cwd` and return its exit code and published document. */
function run(cwd: string, args: string[]): { status: number | null; document: Record<string, unknown>; output: string } {
  const result = executeCli(MATRIX_BIN_PATH, args, { cwd });
  return { status: result.status, document: documentOf(result.stdout), output: `${result.stdout}\n${result.stderr}` };
}

/** The refusal a document published: its status and error code. */
function refusalOf(document: Record<string, unknown>): { status: unknown; code: unknown } {
  return { status: document['status'], code: (document['error'] as { code?: unknown } | undefined)?.code };
}

function skillsProject(name: string): string {
  return project(name, SKILLS_CONFIG, { [SKILL_MD]: CLEAN_SKILL, 'package.json': JSON.stringify({ name }) });
}

describe('an output a skill-packaging lane cannot write ends RUN_INCOMPLETE (system test)', () => {
  useMatrixTempDir();
  afterEach(() => {
    for (const path of locked.splice(0)) chmodSync(path, 0o755);
  });

  it.skipIf(CANNOT_DENY_READS)('vat skills package: an unwritable --output parent', { timeout: PER_TEST_TIMEOUT_MS }, () => {
    const cwd = skillsProject('package-ro');
    mkdirSyncReal(safePath.join(cwd, 'ro'));
    lock(safePath.join(cwd, 'ro'), UNWRITABLE);

    const { status, document, output } = run(cwd, ['skills', 'package', SKILL_MD, '-o', 'ro/out']);

    expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'RUN_INCOMPLETE' });
    expect(status).toBe(2);
  });

  it('vat skills package: a file in the way of --output is the run, not the skill', { timeout: PER_TEST_TIMEOUT_MS }, () => {
    const cwd = skillsProject('package-blocked');
    writeFileSync(safePath.join(cwd, 'blocker'), 'x');

    const { status, document, output } = run(cwd, ['skills', 'package', SKILL_MD, '-o', 'blocker/out']);

    expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'RUN_INCOMPLETE' });
    expect(document['findings']).toStrictEqual([]);
    expect(status).toBe(2);
  });

  it('vat skills package: a ZIP it cannot write is never reported as written', { timeout: PER_TEST_TIMEOUT_MS }, () => {
    const cwd = skillsProject('package-zip');
    mkdirSyncReal(safePath.join(cwd, 'z.zip'));

    const { status, document, output } = run(cwd, ['skills', 'package', SKILL_MD, '-o', 'z', '--force']);

    expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'RUN_INCOMPLETE' });
    expect(status).toBe(2);
  });

  it.skipIf(CANNOT_DENY_READS)('vat agent build: an unwritable --output parent', { timeout: PER_TEST_TIMEOUT_MS }, () => {
    const cwd = project('agent-ro', '{}\n', BUILDABLE_AGENT_FILES);
    mkdirSyncReal(safePath.join(cwd, 'ro'));
    lock(safePath.join(cwd, 'ro'), UNWRITABLE);

    const { status, document, output } = run(cwd, ['agent', 'build', './agent', '--output', 'ro/out']);

    expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'RUN_INCOMPLETE' });
    expect(status).toBe(2);
  });

  it.skipIf(CANNOT_DENY_READS)('vat claude plugin build: an unwritable marketplaces directory', { timeout: PER_TEST_TIMEOUT_MS }, () => {
    const cwd = project('plugin-ro', PLUGIN_BUILD_CONFIG(), PLUGIN_BUILD_FILES);
    const marketplaces = safePath.join(cwd, 'dist', '.claude', 'plugins', 'marketplaces');
    mkdirSyncReal(marketplaces, { recursive: true });
    lock(marketplaces, UNWRITABLE);

    const { status, document, output } = run(cwd, ['claude', 'plugin', 'build']);

    expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'RUN_INCOMPLETE' });
    expect(status).toBe(2);
  });

  // The refusal comes AFTER discovery: it carries the skill it found, not `examined: 0`.
  it.skipIf(CANNOT_DENY_READS)('vat skills build: an unwritable dist/, reporting the skills it examined', { timeout: PER_TEST_TIMEOUT_MS }, () => {
    const cwd = skillsProject('build-ro');
    mkdirSyncReal(safePath.join(cwd, 'dist'));
    lock(safePath.join(cwd, 'dist'), UNWRITABLE);

    const { status, document, output } = run(cwd, ['skills', 'build']);

    expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'RUN_INCOMPLETE' });
    expect(document['examined']).toBe(1);
    expect(status).toBe(2);
  });

  it.skipIf(CANNOT_DENY_READS || !hasClaude())(
    'vat skill test run: an --out whose parent is unwritable',
    { timeout: PER_TEST_TIMEOUT_MS },
    () => {
      const cwd = project('skill-test-ro', SKILLS_CONFIG, { [SKILL_MD]: CLEAN_SKILL, 'skills/clean/evals/evals.json': CLEAN_EVALS });
      mkdirSyncReal(safePath.join(cwd, 'ro'));
      lock(safePath.join(cwd, 'ro'), UNWRITABLE);

      const { status, document, output } = run(cwd, [
        'skill', 'test', 'run', './skills/clean', '--dry-run', '--i-understand-this-runs-skill-code', '--out', safePath.join(cwd, 'ro', 'harness'),
      ]);

      expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'RUN_INCOMPLETE' });
      expect(status).toBe(2);
    },
  );
});

describe('a lane never deletes or re-modes what the operator owns (system test)', () => {
  useMatrixTempDir();
  afterEach(() => {
    for (const path of locked.splice(0)) chmodSync(path, 0o755);
  });

  it('vat skills package refuses an --output that already holds files, and they survive', { timeout: PER_TEST_TIMEOUT_MS }, () => {
    const cwd = skillsProject('package-occupied');
    mkdirSyncReal(safePath.join(cwd, 'keep'));
    writeFileSync(safePath.join(cwd, 'keep', 'important.txt'), 'precious');

    const { status, document, output } = run(cwd, ['skills', 'package', SKILL_MD, '-o', 'keep']);

    expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'USAGE_INVALID' });
    expect(status).toBe(2);
    expect(readFileSync(safePath.join(cwd, 'keep', 'important.txt'), 'utf-8')).toBe('precious');
    expect(existsSync(safePath.join(cwd, 'keep', 'SKILL.md'))).toBe(false);
  });

  it('vat skills package --force replaces a previous package', { timeout: PER_TEST_TIMEOUT_MS }, () => {
    const cwd = skillsProject('package-force');
    expect(run(cwd, ['skills', 'package', SKILL_MD, '-o', 'out']).status).toBe(0);
    writeFileSync(safePath.join(cwd, 'out', 'stale.md'), '# stale');

    const { status, output } = run(cwd, ['skills', 'package', SKILL_MD, '-o', 'out', '--force']);

    expect(status, output).toBe(0);
    expect(existsSync(safePath.join(cwd, 'out', 'stale.md'))).toBe(false);
    expect(existsSync(safePath.join(cwd, 'out', 'SKILL.md'))).toBe(true);
  });

  it.skipIf(CANNOT_DENY_READS || process.platform === 'win32' || !hasClaude())(
    'vat skill test run refuses an --out that is not 0700, and leaves its mode alone',
    { timeout: PER_TEST_TIMEOUT_MS },
    () => {
      const cwd = project('skill-test-out-mode', SKILLS_CONFIG, { [SKILL_MD]: CLEAN_SKILL, 'skills/clean/evals/evals.json': CLEAN_EVALS });
      const out = safePath.join(cwd, 'harness');
      mkdirSyncReal(out);
      lock(out, UNWRITABLE);

      const { status, document, output } = run(cwd, ['skill', 'test', 'run', './skills/clean', '--dry-run', '--i-understand-this-runs-skill-code', '--out', out]);

      expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'USAGE_INVALID' });
      expect(status).toBe(2);
      expect((statSync(out).mode & 0o777).toString(8)).toBe('555');
    },
  );

  // One file the OS will not read, ANYWHERE in the repository: git refuses the whole
  // snapshot. That is the input's refusal, naming the file — not "not a git repository".
  it.skipIf(CANNOT_DENY_READS)('vat skills build names an unreadable file that refused the git snapshot', { timeout: PER_TEST_TIMEOUT_MS }, () => {
    const cwd = skillsProject('build-unreadable');
    writeFileSync(safePath.join(cwd, 'private.txt'), 'secret');
    lock(safePath.join(cwd, 'private.txt'), 0o000);

    const { status, document, output } = run(cwd, ['skills', 'build']);

    expect(refusalOf(document), output).toStrictEqual({ status: 'error', code: 'INPUT_UNREADABLE' });
    expect(JSON.stringify(document['error'])).toContain('private.txt');
    expect(status).toBe(2);
  });
});
