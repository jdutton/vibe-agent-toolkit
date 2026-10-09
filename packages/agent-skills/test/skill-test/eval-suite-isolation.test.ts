/**
 * Unit tests for eval-suite-isolation.ts — the rule that keeps the eval answer key
 * off the executor's filesystem. Real fs throughout (the module's whole job is
 * filesystem effects), against temp dirs that stand in for the resolver's staged copy.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { evalSuiteUnitPath, isolateEvalSuite } from '../../src/skill-test/eval-suite-isolation.js';
import { setupTempDir } from '../test-helpers.js';

/**
 * Rooted through `safePath.resolve` so it carries a drive letter on Windows —
 * `evalSuiteUnitPath` resolves internally, so a bare '/s/skill' literal would be
 * compared against 'D:/s/skill' there and fail.
 */
const SKILL_DIR = toForwardSlash(safePath.resolve('/s/skill'));
const SUBPATH = 'evals/evals.json';
/** The same suite basename, also the whole subpath in the suite-at-skill-root layout. */
const SUITE_FILE = 'evals.json';
const KEY = '{"expected_output":"the answer"}';

/** A staged-copy fixture: `<root>/staged/<name>` with SKILL.md and (optionally) a suite. */
function writeStaged(root: string, name: string, opts: { suite?: boolean; subpath?: string } = {}): string {
  const dir = safePath.join(root, 'staged', name);
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(safePath.join(dir, 'SKILL.md'), '---\nname: x\n---\nbody\n');
  if (opts.suite !== false) {
    const suitePath = safePath.join(dir, opts.subpath ?? SUBPATH);
    mkdirSyncReal(safePath.join(suitePath, '..'), { recursive: true });
    writeFileSync(suitePath, KEY);
  }
  return dir;
}

describe('evalSuiteUnitPath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the suite DIRECTORY for a nested subpath (it also holds fixtures/)', () => {
    expect(evalSuiteUnitPath(SKILL_DIR, SUBPATH)).toBe(`${SKILL_DIR}/evals`);
    expect(evalSuiteUnitPath(SKILL_DIR, 'evals/my-skill/evals.json')).toBe(`${SKILL_DIR}/evals/my-skill`);
  });

  it('resolves the FILE when the suite sits at the skill root (never the skill dir itself)', () => {
    // dirname is '.', so treating the "unit" as the directory would target the whole
    // skill — the one case where removing the unit would delete the subject.
    expect(evalSuiteUnitPath(SKILL_DIR, SUITE_FILE)).toBe(`${SKILL_DIR}/${SUITE_FILE}`);
  });

  it('returns undefined for a subpath that escapes the skill dir (nothing was staged inside)', () => {
    // A perfectly good layout: suites kept OUTSIDE the shipped tree. There is nothing
    // to strip, and we must not resolve to a path outside the staged copy.
    expect(evalSuiteUnitPath(SKILL_DIR, '../shared/evals/evals.json')).toBeUndefined();
    expect(evalSuiteUnitPath(SKILL_DIR, '/etc/passwd')).toBeUndefined();
  });

  it('rethrows a containment-check failure that is not a refusal (undefined means "outside", not "broke")', () => {
    // `undefined` is the answer for a subpath that ESCAPES the skill dir. The
    // containment check used to be `try { joinUnderRoot } catch { undefined }`, so a
    // bug inside the check read as "nothing to strip" and the answer key stayed in
    // the staged copy. Only the helper's own refusal may produce `undefined`.
    vi.spyOn(safePath, 'joinUnderRoot').mockImplementation(() => {
      throw new TypeError('The "path" argument must be of type string');
    });
    expect(() => evalSuiteUnitPath(SKILL_DIR, SUBPATH)).toThrow(TypeError);
  });

  it('returns undefined when no eval suite is declared at all (evalsSubpath is undefined)', () => {
    // Regression: a run whose subject declares no eval suite used to arrive here
    // with `evalsSubpath` typed `string` but actually `undefined` at runtime,
    // crashing inside `dirname(undefined)`. This is a first-class, explicitly
    // typed no-op case — nothing was ever staged, so there is nothing to strip.
    expect(evalSuiteUnitPath(SKILL_DIR, undefined)).toBeUndefined();
  });
});

describe('isolateEvalSuite', () => {
  const { getTempDir } = setupTempDir('vat-eval-isolation-');

  // ⛔ A removal path: the temp directory is this suite's scratch, so nothing here — and no
  // mutation of the code under test — can reach the real one.
  beforeEach(() => {
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, getTempDir());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('removes the suite from a staged copy and reports it was NOT preserved (no hold dir)', async () => {
    const root = getTempDir();
    const staged = writeStaged(root, 'companion');

    const preserved = await isolateEvalSuite({
      stagedDir: staged,
      stagingRoot: safePath.join(root, 'staged'),
      evalsSubpath: SUBPATH,
    });

    expect(preserved).toBe(false);
    expect(existsSync(safePath.join(staged, 'evals'))).toBe(false);
    // Only the suite goes — the skill itself must still be testable.
    expect(existsSync(safePath.join(staged, 'SKILL.md'))).toBe(true);
  });

  it('relocates the suite into the hold dir when one is given, then removes it from the staged copy', async () => {
    const root = getTempDir();
    const staged = writeStaged(root, 'subject');
    const holdDir = safePath.join(root, 'hold');
    // Fixtures ride along with the suite: they are the eval's INPUT and must survive.
    const fixtures = safePath.join(staged, 'evals', 'fixtures');
    mkdirSyncReal(fixtures, { recursive: true });
    writeFileSync(safePath.join(fixtures, 'input.md'), '# input\n');

    const preserved = await isolateEvalSuite({
      stagedDir: staged,
      stagingRoot: safePath.join(root, 'staged'),
      evalsSubpath: SUBPATH,
      holdDir,
    });

    expect(preserved).toBe(true);
    expect(existsSync(safePath.join(staged, 'evals'))).toBe(false);
    // The hold dir IS the evals dir: the suite file sits at its root and fixtures
    // keep their relative position, so declared input `files` resolve unchanged.
    expect(readFileSync(safePath.join(holdDir, SUITE_FILE), 'utf8')).toBe(KEY);
    expect(existsSync(safePath.join(holdDir, 'fixtures', 'input.md'))).toBe(true);
  });

  // The hold dir holds the answer key, so it stays the owner's alone: a copy of the suite
  // directory ONTO it would hand it the staged directory's mode (0755 under a usual umask).
  it.skipIf(process.platform === 'win32')('keeps the hold dir 0700 when it relocates a suite directory into it', async () => {
    const root = getTempDir();
    const staged = writeStaged(root, 'subject-mode');
    const holdDir = safePath.join(root, 'hold-mode');
    // The unit a tree copy would hand its mode to — the staged suite directory itself — is
    // not 0700, so a copy of it ONTO the hold dir would be caught.
    const unit = safePath.join(staged, 'evals');
    chmodSync(unit, 0o755);
    expect(statSync(unit).mode & 0o777).not.toBe(0o700);

    await isolateEvalSuite({ stagedDir: staged, stagingRoot: safePath.join(root, 'staged'), evalsSubpath: SUBPATH, holdDir });

    expect(statSync(holdDir).mode & 0o777).toBe(0o700);
  });

  it('handles a root-level suite file (dirname === ".") without touching the skill dir', async () => {
    const root = getTempDir();
    const staged = writeStaged(root, 'flat', { subpath: SUITE_FILE });
    const holdDir = safePath.join(root, 'hold-flat');

    const preserved = await isolateEvalSuite({
      stagedDir: staged,
      stagingRoot: safePath.join(root, 'staged'),
      evalsSubpath: SUITE_FILE,
      holdDir,
    });

    expect(preserved).toBe(true);
    expect(existsSync(staged)).toBe(true);
    expect(existsSync(safePath.join(staged, 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(staged, SUITE_FILE))).toBe(false);
    expect(readFileSync(safePath.join(holdDir, SUITE_FILE), 'utf8')).toBe(KEY);
  });

  it('is a no-op when the staged copy carries no suite', async () => {
    const root = getTempDir();
    const staged = writeStaged(root, 'no-suite', { suite: false });

    expect(
      await isolateEvalSuite({
        stagedDir: staged,
        stagingRoot: safePath.join(root, 'staged'),
        evalsSubpath: SUBPATH,
      }),
    ).toBe(false);
    expect(existsSync(safePath.join(staged, 'SKILL.md'))).toBe(true);
  });

  it('is a no-op when the run declares no eval suite at all (evalsSubpath undefined)', async () => {
    // Regression: this is the exact runtime shape that crashed 7 integration
    // tests — a caller whose run declares no eval suite passes `evalsSubpath:
    // undefined`. Must return false cleanly and never touch the staged dir.
    const root = getTempDir();
    const staged = writeStaged(root, 'no-suite-declared');

    expect(
      await isolateEvalSuite({
        stagedDir: staged,
        stagingRoot: safePath.join(root, 'staged'),
        evalsSubpath: undefined,
      }),
    ).toBe(false);
    // The staged suite (if any) is untouched — evalsSubpath undefined means
    // this run never asked to strip anything, not "strip the default path".
    expect(existsSync(safePath.join(staged, 'evals', SUITE_FILE))).toBe(true);
    expect(existsSync(safePath.join(staged, 'SKILL.md'))).toBe(true);
  });

  it('REFUSES to delete when the staged dir is outside the staging root, leaving the suite intact', async () => {
    // The guard that matters: every resolver returns a copy under the staging root,
    // but if one ever handed back the user's real source tree, this must throw rather
    // than delete their authored evals.
    const root = getTempDir();
    const notStaged = writeStaged(root, 'authored');

    await expect(
      isolateEvalSuite({
        stagedDir: notStaged,
        stagingRoot: safePath.join(root, 'elsewhere'),
        evalsSubpath: SUBPATH,
      }),
    ).rejects.toThrow(/escapes root/);
    expect(existsSync(safePath.join(notStaged, 'evals', SUITE_FILE))).toBe(true);
  });

  it('leaves a suite configured OUTSIDE the skill dir untouched', async () => {
    const root = getTempDir();
    const staged = writeStaged(root, 'external', { suite: false });

    expect(
      await isolateEvalSuite({
        stagedDir: staged,
        stagingRoot: safePath.join(root, 'staged'),
        evalsSubpath: '../shared/evals.json',
      }),
    ).toBe(false);
    expect(existsSync(safePath.join(staged, 'SKILL.md'))).toBe(true);
  });
});
