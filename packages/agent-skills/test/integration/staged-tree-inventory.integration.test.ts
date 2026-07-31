/**
 * A complete inventory of what `vat skill test` puts in front of the executor.
 *
 * The drift gate (packaged-output-drift.system.test.ts) exists because nothing
 * compared BUILT bytes against a baseline, so a packager change could silently
 * rewrite every shipped skill with the whole suite still green. The staged tree
 * had the same hole from the other end: every other staging test asserts one
 * NAMED property — this file lands flat, that plugin nests there, a deleted
 * source file is pruned — and all of them keep passing if staging starts
 * emitting an extra file, as long as it breaks no named property.
 *
 * "An extra file in the executor's working directory" is precisely the failure
 * this branch exists to close: an eval answer key is exactly that. So this test
 * asserts the FULL set of paths, and fails on anything that appears or vanishes.
 *
 * When a deliberate change makes this fail, update the expected inventory in the
 * same commit — the diff is the point, and reviewing it is the gate.
 */

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  descriptorToSource,
  stageHarness,
  stagedDirName,
  type StageItem,
} from '../../src/skill-test/staging.js';

const EVALS_SUBPATH = 'evals/evals.json';

/** Every file path under `root`, relative and forward-slashed, sorted. */
function inventory(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tmp root
    for (const name of readdirSync(dir)) {
      const abs = safePath.join(dir, name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tmp root
      if (statSync(abs).isDirectory()) walk(abs);
      else found.push(toForwardSlash(safePath.relative(root, abs)));
    }
  };
  walk(root);
  return found.sort((a, b) => a.localeCompare(b));
}

/** Write a file under `dir`, creating parents. */
function writeUnder(dir: string, relPath: string, content: string): void {
  const abs = safePath.join(dir, relPath);
  mkdirSyncReal(safePath.join(abs, '..'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tmp fixture
  writeFileSync(abs, content, 'utf8');
}

/**
 * Resolver producing a skill tree that carries everything the executor must NOT
 * see alongside everything it must: real content, plus an eval suite and its
 * fixtures — the answer key, in its conventional location.
 */
function makeSuiteCarryingResolver(srcRoot: string) {
  return async (source: { path?: string; workspace?: string; vendored?: boolean }) => {
    const id = source.path ?? source.workspace ?? 'vendored';
    const dir = safePath.join(srcRoot, id.replaceAll(/[^a-z0-9]/gi, '_'));
    mkdirSyncReal(dir, { recursive: true });
    writeUnder(dir, 'SKILL.md', `---\nname: ${id}\ndescription: d\n---\n\n# ${id}\n`);
    writeUnder(dir, 'resources/reference.md', '# Reference\n');
    writeUnder(dir, EVALS_SUBPATH, '{"evals":[{"expected_output":"THE ANSWER"}]}');
    writeUnder(dir, 'evals/fixtures/input.txt', 'fixture bytes');
    return { stagedDir: dir, identity: `id-${id}` };
  };
}

interface StageDirs {
  root: string;
  srcRoot: string;
  holdDir: string;
}

const CURRENT_UID = typeof process.getuid === 'function' ? process.getuid() : 0;

/** Stage one subject plus one required companion, both carrying an eval suite. */
async function stageSubjectAndCompanion(dirs: StageDirs, evalsSubpath: string | undefined) {
  const items: StageItem[] = [
    { name: 'subject', source: descriptorToSource({ path: '../subject' }), role: 'subject' },
    { name: 'companion', source: descriptorToSource({ path: '../companion' }) },
  ];
  return stageHarness({
    harnessRoot: dirs.root,
    items,
    resolve: makeSuiteCarryingResolver(dirs.srcRoot) as never,
    // A REAL stagingRoot: the resolver materializes under srcRoot, and the
    // isolation guard proves each staged copy is ours before deleting from it.
    ctx: { stagingRoot: dirs.srcRoot } as never,
    currentUid: CURRENT_UID,
    ...(evalsSubpath === undefined ? {} : { evalsSubpath }),
    evalSuiteHoldDir: dirs.holdDir,
  });
}

describe('staged tree inventory (integration)', () => {
  let dirs: StageDirs;
  let root: string;
  let holdDir: string;

  beforeEach(() => {
    dirs = {
      root: mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-stage-inv-')),
      srcRoot: mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-stage-inv-src-')),
      holdDir: mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-stage-inv-hold-')),
    };
    root = dirs.root;
    holdDir = dirs.holdDir;
  });

  afterEach(() => {
    for (const dir of [dirs.root, dirs.srcRoot, dirs.holdDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stages exactly the executor-visible files, and no eval suite anywhere', async () => {
    await stageSubjectAndCompanion(dirs, EVALS_SUBPATH);

    // Staged dirs are `<slug>-<hash8>` of the item name — derived rather than
    // hardcoded so the inventory stays readable and a naming change fails in
    // stagedDirName's own tests instead of here.
    const subject = stagedDirName('subject');
    const companion = stagedDirName('companion');

    // The complete tree. Anything added or removed by a future change to
    // staging, packaging, or eval isolation shows up as a diff here.
    expect(inventory(root)).toEqual(
      [
        `${companion}/SKILL.md`,
        `${companion}/resources/reference.md`,
        'staged.manifest.json',
        `${subject}/SKILL.md`,
        `${subject}/resources/reference.md`,
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('holds the subject suite outside the harness root, and drops the companion one entirely', async () => {
    const result = await stageSubjectAndCompanion(dirs, EVALS_SUBPATH);

    // The subject's suite is vat's to read, so it is relocated rather than
    // deleted — but to a directory the executor is never pointed at.
    expect(result.subjectEvalSuiteHeld).toBe(true);
    expect(inventory(holdDir)).toContain('evals.json');

    // A companion's suite is not this run's answer key and is not preserved.
    expect(inventory(root).some((p) => p.includes('/evals/'))).toBe(false);
  });

  // CHARACTERIZATION, not endorsement. `evalsSubpath: undefined` is a documented
  // no-op: the caller declared no suite, so nothing is stripped — and a suite
  // sitting in the conventional location therefore reaches the executor.
  //
  // In production this is unreachable: run-harness.ts always defaults the value
  // to `evals/evals.json` before calling in, so the strip always runs. The gap is
  // that the invariant ("the executor's filesystem holds no answer key") is
  // upheld by a caller's default rather than by this function, so a second
  // library caller could reintroduce the leak without changing anything here.
  //
  // Left as-is deliberately: the no-op opt-out was scoped on purpose in the
  // commit that fixed the declared-but-different case, and narrowing it is a
  // product decision, not a cleanup. This test exists so that behavior cannot
  // change silently in either direction.
  it('does NOT strip the conventional suite when the caller declares none (documented no-op)', async () => {
    await stageSubjectAndCompanion(dirs, undefined);

    const staged = inventory(root);
    expect(staged).toContain(`${stagedDirName('subject')}/evals/evals.json`);
    expect(staged).toContain(`${stagedDirName('companion')}/evals/evals.json`);
  });
});
