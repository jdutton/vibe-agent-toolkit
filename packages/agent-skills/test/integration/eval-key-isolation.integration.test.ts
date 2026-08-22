/* eslint-disable security/detect-non-literal-fs-filename -- test paths are our own controlled temp dirs */
/**
 * THE CANARY: the eval answer key must never exist on the executor's filesystem.
 *
 * This is a control, not a unit test of a staging helper. It drives the FULL
 * `runSkillTestHarness` and, at the exact moment each executor is spawned, walks
 * every byte the executor could reach — its cwd, its `--add-dir` sandbox, every
 * `--plugin-dir`, and the ENTIRE harness root (the executor has Bash and
 * `bypassPermissions`, so reachability is not limited to cwd) — asserting that no
 * file contains the suite's `expected_output`.
 *
 * Why it is phrased as "what the model's filesystem contains" rather than "what
 * the staging function did": the leak this guards against is invisible in the
 * worst direction. An executor that finds and paraphrases its own answer key makes
 * evals PASS MORE, so the dashboard improves while the signal dies — there is no
 * failing test to notice and no operator will spot it in a green report. Any
 * refactor that re-opens the leak must fail HERE, loudly, or it will not be caught
 * at all.
 *
 * The spawn is faked (`opts.spawn`) so this runs deterministically in CI with no
 * `claude` install, no auth, and no token spend. That is a deliberate trade: a
 * real-model canary nobody can afford to run on every PR is a control nobody
 * watches. The assertion is about the FILESYSTEM HANDED TO THE SPAWN, which is
 * identical whether the process on the other end is real or fake.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSkillTestHarness, type RunHarnessOptions } from '../../src/skill-test/run-harness.js';
import { makeHarnessFakeSpawn } from '../skill-test/spawn-stub.js';
import { soleArmWorkspace } from '../test-helpers.js';

vi.mock('../../src/skill-test/preflight.js', async (io) => (await import('../skill-test/preflight-stub.js')).passingPreflight(io));

/**
 * The secret. A high-entropy sentinel rather than prose, so a hit is unambiguous
 * evidence of the suite file itself (never an incidental substring of SKILL.md,
 * a prompt, or a transcript).
 */
const ANSWER_KEY = 'CANARY-EXPECTED-OUTPUT-9f2c4a7e1b';

/**
 * VAT's private per-run dirs, which live in the OS temp dir as SIBLINGS of the
 * arm's workspace rather than under the harness root — the held eval suite (the
 * answer key for a fetched-artifact subject) and the grader dir.
 *
 * Enumerated by GLOB rather than by asking the harness for the paths, because
 * that is precisely how an executor with Bash finds them (`ls $TMPDIR`); a walk
 * that needs vat to hand it the token tests a reach no attacker has to make.
 * Only this file's high-entropy `ANSWER_KEY` counts as a hit, so another run's
 * dir sitting alongside cannot produce a false positive.
 */
function vatOnlyTmpDirs(): string[] {
  const tmp = normalizedTmpdir();
  return readdirSync(tmp)
    .filter((name) => name.startsWith('vat-skill-evals-') || name.startsWith('vat-skill-grade-'))
    .map((name) => safePath.join(tmp, name));
}
/** Shared eval prompt — its content is irrelevant to every canary assertion. */
const EVAL_PROMPT = 'do the thing';
const SKILL_NAME = 'canary-skill';
const SKILL_MD = `---\nname: ${SKILL_NAME}\ndescription: A fixture skill for the answer-key isolation canary.\n---\n\n# Canary\n`;

let tempDir: string;

/** Every file under `root`, recursively. `[]` when the root does not exist. */
function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = safePath.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  visit(statSync(root).isDirectory() ? root : safePath.join(root, '..'));
  return out;
}

/** Paths under any of `roots` whose bytes contain `needle` (the leak evidence). */
function filesContaining(roots: readonly string[], needle: string): string[] {
  const hits = new Set<string>();
  for (const root of roots) {
    for (const file of walkFiles(root)) {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        continue; // unreadable/binary — cannot carry the key as text
      }
      if (raw.includes(needle)) hits.add(file);
    }
  }
  return [...hits];
}

/** The eval suite JSON, with the answer key in BOTH graded fields. */
function suiteJson(evals: unknown[]): string {
  return JSON.stringify({ skill_name: SKILL_NAME, evals }) + '\n';
}

interface FixtureLayout {
  /** Dir staged as the subject (`subjectSource`). */
  subjectDir: string;
  /** Authored dir holding `evals/` (`subjectScaffoldDir`). */
  scaffoldDir: string;
}

/**
 * Write a fixture whose eval suite lives in `evalsHost` — either the subject dir
 * itself (source / tree-copied-dist shape: the staged tree CARRIES the suite) or a
 * separate authored dir (packageSkill-dist shape: the staged tree does NOT carry it
 * and the harness must read the authored copy without ever staging it).
 */
function writeFixture(evalsHost: 'subject' | 'scaffold', evals: unknown[]): FixtureLayout {
  const subjectDir = safePath.join(tempDir, 'subject', SKILL_NAME);
  mkdirSyncReal(subjectDir, { recursive: true });
  writeFileSync(safePath.join(subjectDir, 'SKILL.md'), SKILL_MD, 'utf8');

  const scaffoldDir =
    evalsHost === 'subject' ? subjectDir : safePath.join(tempDir, 'authored', SKILL_NAME);
  if (scaffoldDir !== subjectDir) {
    mkdirSyncReal(scaffoldDir, { recursive: true });
    writeFileSync(safePath.join(scaffoldDir, 'SKILL.md'), SKILL_MD, 'utf8');
  }

  const evalsDir = safePath.join(scaffoldDir, 'evals');
  mkdirSyncReal(evalsDir, { recursive: true });
  writeFileSync(safePath.join(evalsDir, 'evals.json'), suiteJson(evals), 'utf8');
  return { subjectDir, scaffoldDir };
}

/** Harness options for a canary run: real staging, faked spawns. */
function canaryOpts(
  layout: FixtureLayout,
  spawn: RunHarnessOptions['spawn'],
  extra: Partial<RunHarnessOptions> = {},
): RunHarnessOptions {
  return {
    subject: SKILL_NAME,
    repoRoot: tempDir,
    out: safePath.join(tempDir, 'harness'),
    subjectSource: { path: layout.subjectDir },
    subjectScaffoldDir: layout.scaffoldDir,
    acknowledgedRunsSkillCode: true,
    allowUnverifiedSkillSource: true,
    ...(spawn === undefined ? {} : { spawn }),
    ...extra,
  };
}

/**
 * Run the harness with an executor hook that snapshots, per spawn, every path
 * reachable from that executor which contains the answer key. Returns the run's
 * exit code plus the accumulated leak hits (empty = the canary is alive).
 */
async function runCanary(
  layout: FixtureLayout,
  extra: Partial<RunHarnessOptions> = {},
): Promise<{ exitCode: number; leaks: string[]; spawns: number; workspacesPath?: string }> {
  const harnessRoot = safePath.join(tempDir, 'harness');
  const leaks: string[] = [];
  let spawns = 0;
  const fake = makeHarnessFakeSpawn({
    onExecutorSpawn: (opts) => {
      spawns += 1;
      // The executor's REACHABLE world, not merely its cwd: cwd + --add-dir
      // sandbox + every --plugin-dir + the whole harness root + the WORKSPACES
      // ROOT + every vat-only dir sitting in the same OS temp dir.
      //
      // The cwd is `<workspacesRoot>/<armToken>/<evalId>`, so the workspaces root
      // is TWO levels up. It was one level up until the per-arm segment landed,
      // and the walk was not updated — which silently narrowed it to the eval's
      // own arm and made this file's stated invariant ("every byte the executor
      // could reach") false for the arm next door. The executor has Bash; a
      // sibling workspace is one `ls ..` away.
      leaks.push(
        ...filesContaining(
          [
            opts.cwd,
            safePath.join(opts.cwd ?? '.', '..', '..'),
            opts.sandboxDir,
            ...opts.pluginDirs,
            harnessRoot,
            ...vatOnlyTmpDirs(),
          ],
          ANSWER_KEY,
        ),
      );
    },
  });
  const result = await runSkillTestHarness(canaryOpts(layout, fake.spawn, extra));
  return {
    exitCode: result.exitCode,
    leaks,
    spawns,
    ...(result.workspacesPath === undefined ? {} : { workspacesPath: result.workspacesPath }),
  };
}

describe('eval answer-key isolation (canary)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-canary-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a files:[] eval — whose cwd IS the staged subject dir — cannot reach expected_output', async () => {
    // The sharpest case: with no input `files`, the executor's working directory
    // falls back to the staged subject, so a bare `ls` used to surface evals.json.
    const layout = writeFixture('subject', [
      { id: 'no-files', prompt: EVAL_PROMPT, expected_output: ANSWER_KEY, expectations: ['it works'] },
    ]);

    const { exitCode, leaks, spawns } = await runCanary(layout);

    expect(leaks).toEqual([]);
    // The run really executed — a canary that passes because nothing ran is worthless.
    expect(spawns).toBe(1);
    expect(exitCode).toBe(0);
  });

  it('an eval WITH input files cannot reach expected_output, and its fixtures still stage', async () => {
    const layout = writeFixture('subject', [
      {
        id: 'with-files',
        prompt: 'operate on the project',
        expected_output: ANSWER_KEY,
        expectations: ['it works'],
        files: ['fixtures/input.md'],
      },
    ]);
    const fixturesDir = safePath.join(layout.scaffoldDir, 'evals', 'fixtures');
    mkdirSyncReal(fixturesDir, { recursive: true });
    writeFileSync(safePath.join(fixturesDir, 'input.md'), '# fixture input\n', 'utf8');

    // `keep` because this asserts on the workspace AFTER the run: workspaces live
    // under OS tmp now and are reaped on exit unless the operator asks to keep them.
    const { exitCode, leaks, spawns, workspacesPath } = await runCanary(layout, { keep: true });

    expect(leaks).toEqual([]);
    expect(spawns).toBe(1);
    expect(exitCode).toBe(0);
    // Removing the key must not have removed the eval's declared INPUT — fixtures
    // are what the executor is meant to work on. Workspaces now live outside the
    // harness root, so the run reports their location rather than it being derivable.
    expect(workspacesPath).toBeDefined();
    // Each arm of a `--baseline` run gets its own copy of every workspace so the two
    // cannot observe each other mid-run; a non-baseline run stages one arm. The
    // segment naming that arm is an opaque per-run token, never the arm's name.
    expect(
      existsSync(safePath.join(soleArmWorkspace(workspacesPath ?? '', 'with-files'), 'fixtures', 'input.md')),
    ).toBe(true);
  });

  it('a --baseline run cannot reach expected_output from EITHER arm', async () => {
    // Until this case existed, no canary passed `baseline: true`, so the WITHOUT
    // tree was never staged and never walked — the arm the whole `--baseline`
    // isolation lane exists to protect was the one arm the canary never saw.
    const layout = writeFixture('subject', [
      { id: 'both-arms', prompt: EVAL_PROMPT, expected_output: ANSWER_KEY, expectations: ['it works'] },
    ]);

    const { exitCode, leaks, spawns } = await runCanary(layout, { baseline: true });

    expect(leaks).toEqual([]);
    // Two executor spawns — one per arm. A canary that saw only one arm would
    // pass here vacuously, which is exactly how this gap survived.
    expect(spawns).toBe(2);
    expect(exitCode).toBe(0);
  });

  it('holds the suite in tmp ONLY when it exists nowhere else, and vat detects that reach', async () => {
    // The fetched-artifact shape: the suite exists ONLY inside the resolved
    // subject, so vat has to keep a copy somewhere it can read and the executor
    // cannot be handed. That copy goes to `<tmp>/vat-skill-evals-<token>/` at 0700.
    //
    // This case is the honest residual, and it is why the walk above globs tmp:
    // 0700-outside-the-sandbox is Claude's permission model, not an OS boundary —
    // skill code runs as the same uid. What vat owes here is DETECTION, which is
    // `vatPrivateDirNeedles`. What it owes everywhere else is not making the copy
    // at all, which every other case in this file now asserts.
    const layout = writeFixture('subject', [
      { id: 'held-only', prompt: EVAL_PROMPT, expected_output: ANSWER_KEY, expectations: ['it works'] },
    ]);
    // An authored dir with a SKILL.md but no evals/, so rule 1 finds nothing and
    // the run must fall back to the held copy.
    const authoredWithoutEvals = safePath.join(tempDir, 'authored-empty', SKILL_NAME);
    mkdirSyncReal(authoredWithoutEvals, { recursive: true });
    writeFileSync(safePath.join(authoredWithoutEvals, 'SKILL.md'), SKILL_MD, 'utf8');

    const { exitCode, leaks, spawns } = await runCanary(
      { ...layout, scaffoldDir: authoredWithoutEvals },
    );

    // The run WORKED off the held copy — this is the path the hold dir exists for,
    // and skipping the hold write on the common path must not have broken it.
    expect(spawns).toBe(1);
    expect(exitCode).toBe(0);
    // Every reachable copy is inside vat's own 0700 tmp dir; none is under the
    // executor's cwd, sandbox, plugin dirs, workspaces root or the harness root.
    expect(leaks.length).toBeGreaterThan(0);
    for (const leak of leaks) expect(leak).toContain('vat-skill-evals-');
  });

  it('a dist-shaped subject that does not carry the suite never has it staged back in', async () => {
    // The `packageSkill` shape: the built subject carries no evals/, and the suite
    // lives only in the authored source dir. The harness must read the authored copy
    // WITHOUT copying it into anything the executor can reach.
    const layout = writeFixture('scaffold', [
      { id: 'dist-shaped', prompt: EVAL_PROMPT, expected_output: ANSWER_KEY, expectations: ['it works'] },
    ]);

    const { exitCode, leaks, spawns } = await runCanary(layout);

    expect(leaks).toEqual([]);
    expect(spawns).toBe(1);
    expect(exitCode).toBe(0);
  });

  it('a skill graded against an EXTERNAL suite still has its own suite stripped', async () => {
    // Grading against an out-of-tree suite (`--evals`) does not make the skill's
    // OWN evals/ harmless: it is still an answer key for this same skill, sitting
    // in the executor's working directory. The invariant is "the executor's
    // filesystem contains no answer key", not "…contains no answer key for the
    // suite we happen to be grading".
    //
    // The strip target used to be the same value as the READ target, so naming a
    // suite outside the tree silently disabled the strip: nothing inside the
    // skill matched an absolute path, so nothing was removed.
    const layout = writeFixture('subject', [
      { id: 'internal', prompt: EVAL_PROMPT, expected_output: ANSWER_KEY, expectations: ['it works'] },
    ]);

    // A separate suite, elsewhere, with a DIFFERENT expected output — so a hit on
    // ANSWER_KEY can only have come from the skill's own tree.
    const externalSuite = safePath.join(tempDir, 'corpus', 'evals.json');
    mkdirSyncReal(safePath.join(tempDir, 'corpus'), { recursive: true });
    writeFileSync(
      externalSuite,
      JSON.stringify({
        skill_name: SKILL_NAME,
        evals: [
          { id: 'external', prompt: EVAL_PROMPT, expected_output: 'UNRELATED-KEY', expectations: ['it works'] },
        ],
      }) + '\n',
      'utf8',
    );

    const { exitCode, leaks, spawns } = await runCanary(layout, { evalsSubpath: externalSuite });

    expect(leaks).toEqual([]);
    expect(spawns).toBe(1);
    expect(exitCode).toBe(0);
  });

  it('the staged subject carries no eval suite directory at all', async () => {
    // Belt to the canary's braces: assert the DIRECTORY is gone, not just that the
    // key string is absent — so a future change that keeps a stripped-down suite
    // (prompts only) still has to make a deliberate decision here.
    const layout = writeFixture('subject', [
      { id: 'no-files', prompt: EVAL_PROMPT, expected_output: ANSWER_KEY, expectations: ['it works'] },
    ]);

    let stagedEvalsDirs: string[] = [];
    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: () => {
        stagedEvalsDirs = walkFiles(safePath.join(tempDir, 'harness')).filter((p) =>
          p.includes('/evals/'),
        );
      },
    });
    await runSkillTestHarness(canaryOpts(layout, fake.spawn));

    expect(stagedEvalsDirs).toEqual([]);
  });
});
