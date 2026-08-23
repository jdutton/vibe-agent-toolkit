/* eslint-disable security/detect-non-literal-fs-filename -- test paths are our own controlled temp dirs */
/**
 * THE CONTROL: a `--baseline` run's skill-absent arm must not be handed the skill.
 *
 * This is the test that did not exist, and its absence is why the original defect
 * shipped and why the FIRST fix for it was itself incomplete. Every prior baseline
 * assertion in this repo tested a pure helper — `buildExecutorPrompt`,
 * `buildEvalWorkItems`, the detector — and no test anywhere ran the harness with
 * `baseline: true`. A mutation pass proved the consequence: restoring the original
 * bug verbatim (hand the control arm the staged subject path) left the entire
 * suite green.
 *
 * So this asserts the PROPERTY, not the mechanisms. A path reaches a child process
 * through four channels — prompt, argv, cwd, and environment — and the first fix
 * closed three of them. `CLAUDE_PLUGIN_ROOT` in the fourth still pointed at the
 * staged plugin root, so one `env | grep` recovered the whole treatment. The
 * assertion below is therefore deliberately phrased over the WHOLE spawn rather
 * than over named fields: any future channel that carries the harness root into
 * the control arm fails here by construction, without anyone remembering to
 * extend a list.
 *
 * The spawn is faked, as in the sibling answer-key canary. The property is about
 * what VAT HANDS the process, which is identical whether the process on the other
 * end is real or fake.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, toForwardSlash, type SpawnHeadlessOptions } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { BaselineDeltaSchema, type BaselineDelta } from '../../src/skill-test/baseline-delta.js';
import {
  runSkillTestHarness,
  RETAINED_RESULTS_DIRNAME,
  type RunHarnessOptions,
} from '../../src/skill-test/run-harness.js';
import { makeHarnessFakeSpawn, type HarnessFakeSpawnConfig } from '../skill-test/spawn-stub.js';
import { setupTempDir } from '../test-helpers.js';

vi.mock('../../src/skill-test/preflight.js', async (io) => (await import('../skill-test/preflight-stub.js')).passingPreflight(io));

const SKILL_NAME = 'control-skill';
const EVAL_ID = 'no-files-eval';
/**
 * One body line long and distinctive enough to become a content needle — the
 * signal an instruction-only skill depends on. Kept out of the eval prompt on
 * purpose: a needle the suite's own text contains is excluded by design.
 */
const SKILL_BODY_LINE = 'Rows are assigned to the nearest bucket whose ceiling exceeds the row value.';
const SKILL_MD = `---\nname: ${SKILL_NAME}\ndescription: A fixture skill for the baseline control test.\n---\n\n# Control\n\n${SKILL_BODY_LINE}\n`;
/** The `--baseline` arm's artifact — the file this whole lane exists to make honest. */
const BASELINE_JSON = 'baseline.json';

const { getTempDir } = setupTempDir('vat-baseline-control-');

/**
 * A subject in PLUGIN layout — the shape the defect was reported against, and the
 * only shape for which `CLAUDE_PLUGIN_ROOT` is set at all. A standalone-skill
 * fixture would pass this test while the hole stayed wide open.
 */
function writePluginFixture(
  skillName: string = SKILL_NAME,
  evalPrompt = 'do the thing',
): { subjectDir: string; pluginRoot: string } {
  const pluginRoot = safePath.join(getTempDir(), 'src', `plugin-${skillName}`);
  const manifestDir = safePath.join(pluginRoot, '.claude-plugin');
  mkdirSyncReal(manifestDir, { recursive: true });
  writeFileSync(
    safePath.join(manifestDir, 'plugin.json'),
    JSON.stringify({ name: 'my-plugin', version: '1.0.0' }) + '\n',
    'utf8',
  );

  const subjectDir = safePath.join(pluginRoot, 'skills', skillName);
  mkdirSyncReal(subjectDir, { recursive: true });
  // eslint-disable-next-line unicorn/prefer-string-replace-all -- test tsconfig lib predates String.replaceAll
  writeFileSync(safePath.join(subjectDir, 'SKILL.md'), SKILL_MD.replace(new RegExp(SKILL_NAME, 'g'), skillName), 'utf8');

  // An eval with NO input `files` — the case whose executor used to fall back to
  // running inside the staged subject dir.
  const evalsDir = safePath.join(subjectDir, 'evals');
  mkdirSyncReal(evalsDir, { recursive: true });
  writeFileSync(
    safePath.join(evalsDir, 'evals.json'),
    JSON.stringify({
      skill_name: skillName,
      evals: [{ id: EVAL_ID, prompt: evalPrompt, expectations: ['it happened'] }],
    }) + '\n',
    'utf8',
  );
  return { subjectDir, pluginRoot };
}

function baselineOpts(
  subjectDir: string,
  spawn: RunHarnessOptions['spawn'],
  extra: Partial<RunHarnessOptions> = {},
): RunHarnessOptions {
  return {
    subject: SKILL_NAME,
    repoRoot: getTempDir(),
    out: safePath.join(getTempDir(), 'harness'),
    subjectSource: { path: subjectDir },
    subjectScaffoldDir: subjectDir,
    acknowledgedRunsSkillCode: true,
    allowUnverifiedSkillSource: true,
    baseline: true,
    ...(spawn === undefined ? {} : { spawn }),
    ...extra,
  };
}

/**
 * The DEFAULT invocation: no `--out`, no `--workdir`, no `--keep` — the one
 * `vat-skill-testing.md`'s copy-paste example uses, and the only one for which
 * `harnessCreated` is true and cleanup actually fires.
 *
 * Every other test in this file passes `out:` or `keep: true`, which is exactly
 * why none of them could see that cleanup deleted `results/baseline.json` inside
 * the harness's own `finally` before the caller ever got the result back. The
 * subject name is a parameter because the derived harness root is a pure function
 * of it (`<tmp>/vat-skill-test/<sanitized>-<hash8>`) and lands in the REAL OS temp
 * dir, shared with every other run on the machine — so this test needs a name no
 * other test or developer run will collide with.
 */
function defaultRunOpts(
  subjectDir: string,
  spawn: RunHarnessOptions['spawn'],
  subject: string,
): RunHarnessOptions {
  const opts = baselineOpts(subjectDir, spawn);
  delete opts.out;
  opts.subject = subject;
  return opts;
}

/**
 * EVERY value VAT hands one spawn, serialized whole — not an enumeration of the
 * fields we currently think matter.
 *
 * This used to name five fields (`prompt`, `cwd`, `sandboxDir`, `pluginDirs`,
 * `env`) while `SpawnHeadlessOptions` carries seven, and a mutation that routed the
 * staged skill dir through `model` — which `assembleClaudeArgs` puts straight onto
 * argv as `--model <path>` — left all four tests green. An allowlist here reproduces,
 * one level up, exactly the failure this file exists to prevent: the first fix closed
 * three of four channels, and its test closed five of seven fields. Serializing the
 * whole options object is what makes the docblock's "by construction" claim true.
 */
function spawnSurface(opts: Record<string, unknown>): string {
  return JSON.stringify(opts, (_key, value) => (typeof value === 'function' ? undefined : value));
}

/**
 * Fold a path or a serialized surface into one comparable spelling, mirroring the
 * production `normalizeForMatch`. `JSON.stringify` escapes a Windows separator as
 * `\\`, which becomes `//` under a naive slash flip and then matches no
 * single-slash needle — so collapsing slash runs is what keeps these assertions
 * alive on Windows rather than merely green.
 */
/**
 * Extra stream-json emitted by the CONTROL arm alone.
 *
 * Only its transcript is scanned, so putting the evidence on both arms would let
 * a test pass on a detector that read the wrong one. The arm is identified the
 * way the whole file identifies it — the one spawned with no plugin dirs.
 */
function controlArmEmits(
  build: (opts: SpawnHeadlessOptions) => unknown,
): (opts: SpawnHeadlessOptions) => string | undefined {
  return (opts) => (opts.pluginDirs.length === 0 ? JSON.stringify(build(opts)) : undefined);
}

/** A single assistant text block, the shape a model answers in. */
const assistantText = (text: string): unknown => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});

/** A single Bash tool_use block, the shape a model reaches with. */
const assistantBash = (command: string): unknown => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
});

/**
 * Run `body` with `process.stderr` captured, and hand back both its result and
 * what was written. stderr is where the two "do not trust this delta" signals
 * actually reach an operator, so more than one test has to read it — and the spy
 * must be restored even when the body throws, or every later test in the file
 * loses its output.
 */
async function captureStderr<T>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  });
  try {
    return { result: await body(), lines };
  } finally {
    spy.mockRestore();
  }
}

/** As much of the integrity block as these tests assert on. */
interface BlockShape {
  contaminated?: boolean;
  comparable?: boolean;
  signals?: string[];
  skew?: Array<{ evalId?: string; withTotal?: number; withoutTotal?: number }>;
  findings?: Array<{ evalId?: string }>;
}

/**
 * `baseline.json` parsed back OFF DISK, which is the only place either of its two
 * blocks reaches an operator. Reading it rather than trusting the in-memory result
 * is the point: a block computed and never written is the failure this file already
 * caught once, and it is the same shape of defect the `dropped` field hit before it.
 */
function readBaselineJson(resultsDir?: string): {
  baselineIntegrity?: BlockShape;
  baselineDelta?: unknown;
} {
  const dir = resultsDir ?? safePath.join(getTempDir(), 'harness', RETAINED_RESULTS_DIRNAME);
  const baselinePath = safePath.join(dir, BASELINE_JSON);
  expect(existsSync(baselinePath), 'baseline.json was never written').toBe(true);
  return JSON.parse(readFileSync(baselinePath, 'utf8')) as {
    baselineIntegrity?: BlockShape;
    baselineDelta?: unknown;
  };
}

/** The integrity block: "may I subtract these two arms?" */
function readBaselineIntegrity(resultsDir?: string): BlockShape {
  const parsed = readBaselineJson(resultsDir);
  expect(parsed.baselineIntegrity, 'baselineIntegrity block missing').toBeDefined();
  return parsed.baselineIntegrity ?? {};
}

/**
 * The delta block: the subtraction itself, and the entire product of `--baseline`.
 *
 * Parsed through the SHIPPED schema rather than an `as` cast, so a block that was
 * written but written malformed — a stringified number, a stray key, a `perEval`
 * that lost its `evalId` — fails here loudly instead of satisfying a hand-written
 * structural assertion that happens to look at the two fields that survived.
 */
function readBaselineDelta(): BaselineDelta {
  const parsed = readBaselineJson();
  expect(parsed.baselineDelta, 'baselineDelta block missing from baseline.json').toBeDefined();
  return BaselineDeltaSchema.parse(parsed.baselineDelta);
}

/**
 * Run a baseline harness to completion and hand back the integrity block it left
 * on disk — the sequence every verdict assertion in this file needs, and the one
 * whose middle step (the run actually succeeding) is what stops a later assertion
 * passing against a file some earlier test wrote.
 */
/**
 * Run a whole baseline harness with the given grader behaviour and hand back
 * everything the run wrote to stderr.
 *
 * One helper for every delta assertion because the three interesting outcomes —
 * a measured lift, a measured zero, a withheld delta — differ only in how the
 * fake grader behaves. Anything else varying between them would make a
 * disagreement between two of the tests unattributable.
 *
 * It deliberately does NOT also read the block off disk. The delta has two
 * independent destinations, artifact and terminal, and folding both into one
 * helper would make a test that asserts on the terminal fail when the ARTIFACT
 * write breaks — so a mutation pass could no longer tell the two apart, and each
 * would look covered by the other's test.
 */
async function runBaselineCapturingStderr(cfg: HarnessFakeSpawnConfig): Promise<string[]> {
  const { subjectDir } = writePluginFixture();
  const fake = makeHarnessFakeSpawn(cfg);
  const { result, lines } = await captureStderr(() =>
    runSkillTestHarness(baselineOpts(subjectDir, fake.spawn)),
  );
  expect(result.exitCode, result.summary).toBe(0);
  return lines;
}

/** True for the SKILL-ABSENT arm's grader fragment — vat writes it under `<graderOutDir>/without/`. */
const isControlArmFragment = (fragmentPath: string): boolean =>
  toForwardSlash(fragmentPath).includes('/without/');

/**
 * The grader behaviour that produces a REAL, non-zero lift: the treatment arm
 * passes its expectation and the control arm fails the same one. A delta test in
 * which both arms score alike cannot tell a working subtraction from a constant
 * zero.
 */
const CONTROL_ARM_FAILS: HarnessFakeSpawnConfig = {
  graderPassedFor: (_evalId, fragmentPath) => !isControlArmFragment(fragmentPath),
};

/**
 * The grader behaviour that makes the arms INCOMPARABLE: the control arm is graded
 * against 1 expectation where the treatment got 2. Shared with the integrity test
 * below, which asserts the other half of the same run.
 */
const ARMS_GRADED_TO_DIFFERENT_DEPTHS: HarnessFakeSpawnConfig = {
  graderExpectationCount: (fragmentPath) => (isControlArmFragment(fragmentPath) ? 1 : 2),
};

async function runBaselineForIntegrity(
  subjectDir: string,
  spawn: RunHarnessOptions['spawn'],
  extra: Partial<RunHarnessOptions> = {},
): Promise<ReturnType<typeof readBaselineIntegrity>> {
  const result = await runSkillTestHarness(baselineOpts(subjectDir, spawn, extra));
  expect(result.exitCode, result.summary).toBe(0);
  return readBaselineIntegrity();
}

function fold(value: string): string {
  // eslint-disable-next-line unicorn/prefer-string-replace-all -- test tsconfig lib predates String.replaceAll
  return toForwardSlash(value).replace(/\/{2,}/g, '/').toLowerCase();
}

describe('baseline control arm (integration)', () => {
  it('hands the skill-absent arm no path to the skill through ANY channel', async () => {
    const { subjectDir } = writePluginFixture();
    const control: Array<Record<string, unknown>> = [];
    const treatment: Array<Record<string, unknown>> = [];

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        // The control arm is the one spawned with no plugin dirs.
        (opts.pluginDirs.length === 0 ? control : treatment).push({ ...opts });
      },
    });

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn));

    expect(result.exitCode, result.summary).toBe(0);
    // Both arms ran — a baseline run that silently produced only one arm would
    // otherwise satisfy every assertion below vacuously.
    expect(control, 'no skill-absent arm was spawned').toHaveLength(1);
    expect(treatment, 'no skill-present arm was spawned').toHaveLength(1);

    const harnessRoot = fold(result.harnessPath);
    const surface = fold(spawnSurface(control[0] as Record<string, unknown>));

    // The whole point, stated once: nothing VAT hands the control arm may lead to
    // the staged skill. Not the prompt, not argv, not cwd, not the environment.
    expect(surface, `control arm was handed the harness root:\n${surface}`).not.toContain(harnessRoot);

    // And specifically the channel the first fix missed.
    expect((control[0] as { env?: NodeJS.ProcessEnv }).env ?? {}).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');

    // The treatment arm still gets everything it needs — otherwise "isolated" is
    // indistinguishable from "broken", and the A/B measures nothing.
    expect(fold(spawnSurface(treatment[0] as Record<string, unknown>))).toContain(harnessRoot);
    expect((treatment[0] as { env?: NodeJS.ProcessEnv }).env ?? {}).toHaveProperty('CLAUDE_PLUGIN_ROOT');
  });

  /**
   * The FIFTH channel, and the one an audit of "what does VAT hand this process"
   * structurally cannot find: not a path into either arm, but a directory both arms
   * own. The two arms of one eval are queued adjacently into a bounded-parallel
   * pool, so they run at the same time; when they shared a workspace the control
   * arm could `ls`, read whatever the treatment had just written, and answer from
   * it — scoring like the treatment, erasing the lift, and leaving a transcript
   * with no harness path in it for the detector to find. Each arm's own cwd was
   * correct in isolation and wrong as a pair.
   */
  it('gives each arm its own workspace, so the control cannot read the treatment output', async () => {
    const { subjectDir } = writePluginFixture();
    const cwds = new Map<string, string>();

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        cwds.set(opts.pluginDirs.length === 0 ? 'control' : 'treatment', opts.cwd ?? '');
      },
    });

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn, { keep: true }));

    expect(result.exitCode, result.summary).toBe(0);
    const controlCwd = fold(cwds.get('control') ?? '');
    const treatmentCwd = fold(cwds.get('treatment') ?? '');

    expect(controlCwd, 'no skill-absent arm was spawned').not.toBe('');
    expect(treatmentCwd, 'no skill-present arm was spawned').not.toBe('');
    expect(controlCwd, 'both arms were given the SAME working directory').not.toBe(treatmentCwd);
    // Neither may sit inside the other, which a naive `<ws>/<id>` vs `<ws>/<id>/without`
    // layout would satisfy the inequality above while still sharing everything.
    expect(controlCwd.startsWith(treatmentCwd + '/')).toBe(false);
    expect(treatmentCwd.startsWith(controlCwd + '/')).toBe(false);
  });

  /**
   * BLINDING. `buildExecutorPrompt`'s docblock promises the executor "must NEVER
   * be told (directly or by implication) that it is being tested, evaluated, or
   * graded" — and the workspace layout was quietly breaking that promise in the
   * loudest possible place. The prompt states the working directory verbatim, and
   * the directory was `…/vat-skill-test-ws-<token>/without/e1`, so each arm read
   * which side of the A/B it was on in a string it cannot avoid. It also named
   * the sibling: `../with/<id>/` was a guessable path to the treatment arm's live
   * output.
   *
   * The assertion is over the WHOLE spawn surface, not the prompt alone: the same
   * path is also the `cwd`, the `sandboxDir`, and an `--add-dir` argv slot, so
   * checking one field would leave three telling the arm the same thing.
   */
  it('never tells either arm which arm it is', async () => {
    const { subjectDir } = writePluginFixture();
    const seen = new Map<string, string>();

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        seen.set(opts.pluginDirs.length === 0 ? 'control' : 'treatment', spawnSurface({ ...opts }));
      },
    });

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn));
    expect(result.exitCode, result.summary).toBe(0);
    expect(seen.size, 'both arms must have spawned').toBe(2);

    for (const [arm, surface] of seen) {
      // Path SEGMENTS, not a substring scan: "with" occurs in ordinary prose, and
      // the prompt legitimately contains English.
      // eslint-disable-next-line local/no-hardcoded-path-split -- `fold` already forward-slashed this; splitting on separators is the point
      const segments = new Set(fold(surface).split(/[/"\\,\s]+/));
      expect(segments, `the ${arm} arm was handed a path segment naming an arm`).not.toContain('with');
      expect(segments, `the ${arm} arm was handed a path segment naming an arm`).not.toContain('without');
    }
  });

  it("runs the control arm in its own workspace, never in the staged skill", async () => {
    const { subjectDir } = writePluginFixture();
    let controlCwd: string | undefined;

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        if (opts.pluginDirs.length === 0) controlCwd = opts.cwd;
      },
    });

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn, { keep: true }));

    expect(result.exitCode, result.summary).toBe(0);
    expect(controlCwd).toBeDefined();
    expect(fold(controlCwd ?? '')).toContain(fold(result.workspacesPath ?? '@none'));
    expect(fold(controlCwd ?? '')).not.toContain(fold(result.harnessPath));
  });

  // The detector's whole value is that it makes a bad number LOUD. Mutation
  // testing showed both "compute the findings and throw them away" and "never
  // write the block" survived the suite — the detector was covered as a pure
  // function and unwired in practice.
  it('stamps a contaminated verdict into baseline.json when the control arm reaches the skill', async () => {
    const { subjectDir } = writePluginFixture();

    // A RELATIVE reach, which is the natural one — the control arm's cwd and the
    // harness root are siblings under the OS temp dir, so the model climbs rather
    // than typing an absolute path. The absolute root never appears in this
    // transcript, so a literal `indexOf(harnessRoot)` cannot see it; the two
    // trailing segments are what make it evidence.
    const harnessTail = toForwardSlash(safePath.join(getTempDir(), 'harness')).split('/').slice(-2).join('/');

    const fake = makeHarnessFakeSpawn({
      executorExtraStdout: controlArmEmits(() => assistantBash(`cat ../${harnessTail}/${SKILL_NAME}/SKILL.md`)),
    });

    const integrity = await runBaselineForIntegrity(subjectDir, fake.spawn);
    expect(integrity.contaminated).toBe(true);
    expect(integrity.findings?.[0]?.evalId).toBe(EVAL_ID);
  });

  // The block is unconditional: its ABSENCE must mean "this file predates the
  // check", never "checked and clean". Only an always-written field carries that.
  it('stamps a clean verdict into baseline.json when the control arm behaves', async () => {
    const { subjectDir } = writePluginFixture();

    const integrity = await runBaselineForIntegrity(subjectDir, makeHarnessFakeSpawn({}).spawn);
    expect(integrity.contaminated).toBe(false);
    expect(integrity.findings).toEqual([]);
  });

  /**
   * The reach every other signal is structurally blind to, and the common case:
   * an INSTRUCTION-ONLY skill, which ships no executable, found as an ambient copy,
   * which carries no harness path. `grep -rl "<phrase>" .` → `Read` → answer left
   * nothing for a path needle or a name needle to match, so `contaminated: false`
   * meant "saw no evidence" while reading as "verified none".
   *
   * The transcript below quotes the skill and names NOTHING — no path, no
   * executable, no directory. Only content can see it.
   */
  it('flags a control arm that quotes the skill without naming any path', async () => {
    const { subjectDir } = writePluginFixture();

    const fake = makeHarnessFakeSpawn({
      executorExtraStdout: controlArmEmits(() => assistantText(`Following the guidance: ${SKILL_BODY_LINE}`)),
    });

    const integrity = await runBaselineForIntegrity(subjectDir, fake.spawn);

    expect(integrity.signals, 'the content signal was not armed').toContain('skill-content');
    expect(integrity.contaminated, 'a quoted-skill reach went undetected').toBe(true);
    expect(integrity.findings?.[0]?.evalId).toBe(EVAL_ID);
  });

  /**
   * The other half of the content signal, and the half that decides whether it is
   * usable at all: an adopter who quotes a sentence of their own SKILL.md in an
   * eval prompt hands it to the arm THROUGH vat. The arm echoing the prompt it was
   * given is not the arm reaching the skill — and without the exclusion, every run
   * of that suite would be stamped contaminated, control and treatment alike.
   *
   * Asserted at the harness rather than on the derivation, because what has to be
   * right here is that the run's own eval text reaches the exclusion at all.
   */
  it('does not flag the control arm for echoing a skill line its own eval prompt carried', async () => {
    const { subjectDir } = writePluginFixture(SKILL_NAME, `Explain this rule: ${SKILL_BODY_LINE}`);

    const fake = makeHarnessFakeSpawn({
      executorExtraStdout: controlArmEmits(() => assistantText(`The rule says: ${SKILL_BODY_LINE}`)),
    });

    const integrity = await runBaselineForIntegrity(subjectDir, fake.spawn);

    // Unarmed, not merely quiet: the sole candidate needle was the excluded line,
    // and `signals` has to say so rather than report a clean check that never ran.
    expect(integrity.signals, 'the excluded needle was still armed').not.toContain('skill-content');
    expect(integrity.contaminated, 'echoing the prompt was reported as a reach').toBe(false);
  });

  /**
   * The executable-name signal must not fire on the control arm's OWN scratch
   * files, and the only thing that tells them apart from a reach is a path root
   * the harness has to thread in.
   *
   * A review found 8/8 realistic clean behaviours firing the old pattern —
   * `python3 analyze.py` against a declared `scripts/analyze.py`, `Wrote
   * report.md`, `saved to summary.txt` — each stamping `contaminated: true`, whose
   * attached instruction is "discard the delta". A check that routinely destroys
   * good runs is not erring safely; it teaches operators to ignore the one warning
   * that matters.
   *
   * The pattern now requires a path, and the path must escape the arm's own
   * workspace. The absolute self-reference below is the form that needs
   * `armWorkspaceDir` WIRED rather than inferred: the executor prompt states the
   * working directory absolutely, so the arm reuses that absolute path routinely,
   * and every mention would otherwise read as an escape. Asserting it here rather
   * than on the detector alone is the point — the unit tests pass `armWorkspaceDir`
   * themselves, so they cannot see the harness failing to.
   */
  it('does not flag the control arm for running its own scratch script', async () => {
    const { subjectDir } = writePluginFixture();

    const fake = makeHarnessFakeSpawn({
      // Both clean forms in one transcript: the bare filename an arm writes and
      // reports, and its own workspace named ABSOLUTELY, which is the spelling
      // its prompt handed it.
      executorExtraStdout: controlArmEmits((opts) =>
        assistantBash(`python3 summary.py && node ${opts.cwd ?? ''}/scripts/summary.mjs`),
      ),
    });

    const integrity = await runBaselineForIntegrity(subjectDir, fake.spawn, {
      declaredExecutables: [{ name: 'summary', howInvoked: 'python3 scripts/summary.py', kind: 'python' }],
    });

    // The signal must be ARMED — otherwise this passes because nothing looked,
    // which is the failure mode `signals` exists to expose.
    expect(integrity.signals, 'the executable signal was not armed').toContain('declared-executable');
    expect(
      integrity.contaminated,
      `a clean control arm was reported contaminated: ${JSON.stringify(integrity.findings)}`,
    ).toBe(false);
  });

  /**
   * A delta between two differently-sized denominators is not a delta.
   *
   * vat computes each arm's `summary` from the fragments it received, so both
   * reports are internally consistent by construction — `reconcileGrading`, the
   * only cross-check that existed, cannot see this and is WITH-arm only anyway. A
   * grader that graded the control arm against 1 of 2 expectations yields
   * `baseline.summary = {passed:1,total:1}`, which reads as **100% without the
   * skill**: the most damaging direction the number can be wrong in, because it
   * says the skill did nothing.
   *
   * Deliberately not a throw. The control arm's grader misbehaving must not
   * discard a perfectly good treatment result — it must make the delta say, in
   * writing and on stderr, that it cannot be subtracted.
   */
  it('marks the run incomparable when the arms were graded to different depths', async () => {
    const { subjectDir } = writePluginFixture();
    // Keyed on the fragment path, the only thing that distinguishes the arms at a
    // grader spawn: vat writes each arm's fragment under `<graderOutDir>/<arm>/`.
    const fake = makeHarnessFakeSpawn(ARMS_GRADED_TO_DIFFERENT_DEPTHS);

    const { result: integrity, lines: stderr } = await captureStderr(() =>
      runBaselineForIntegrity(subjectDir, fake.spawn),
    );

    expect(integrity.comparable, 'a short-graded control arm read as comparable').toBe(false);
    expect(integrity.skew).toEqual([{ evalId: EVAL_ID, withTotal: 2, withoutTotal: 1 }]);
    // Clean AND incomparable is a real state; conflating them would hide one.
    expect(integrity.contaminated).toBe(false);
    // …and it has to reach the operator, who does not open baseline.json.
    expect(
      stderr.some((line) => line.includes('ARMS NOT COMPARABLE')),
      `nothing on stderr said the arms were incomparable:\n${stderr.join('')}`,
    ).toBe(true);
  });

  /**
   * THE PRODUCT. `--baseline` runs every eval twice and its entire output is the
   * LIFT between the two arms — and until this test, vat computed no delta
   * anywhere: it wrote two same-shaped artifacts and left the operator to subtract
   * by hand while the shipped docs said it "reports the delta".
   *
   * The arms deliberately score DIFFERENTLY here. A baseline fixture in which both
   * arms pass cannot tell a working subtraction from a hard-coded zero, and cannot
   * tell `withPassed − withoutPassed` from its own negation — so a test built on
   * one measures magnitude, not lift.
   *
   * Read back off disk, and through the shipped schema: the delta only exists for
   * an operator if it survived into the artifact in the shape the artifact promises.
   */
  it('computes the lift between the two arms and writes it into baseline.json', async () => {
    await runBaselineCapturingStderr(CONTROL_ARM_FAILS);
    const delta = readBaselineDelta();

    // Both arms' totals, not just the difference: a delta printed beside two
    // numbers it is not actually the difference of is the "close enough" number
    // that gets quoted without its caveat.
    expect(delta.with).toEqual({ passed: 1, total: 1 });
    expect(delta.without).toEqual({ passed: 0, total: 1 });
    expect(delta.delta, 'the skill lifted one expectation and the delta did not say so').toBe(1);
    expect(delta.perEval).toEqual([
      { evalId: EVAL_ID, withPassed: 1, withTotal: 1, withoutPassed: 0, withoutTotal: 1, delta: 1 },
    ]);
  });

  /**
   * …and it has to reach the operator, who does not open `baseline.json`. Two
   * earlier rounds of this lane shipped findings that existed only inside an
   * artifact; the delta is the one number the command exists to produce, so a
   * delta that lands on disk and nowhere else has still not been reported.
   *
   * The SIGN is asserted, not merely the digit: `+1` says the skill lifted, `-1`
   * says the control outscored it, and a line printing a bare magnitude reads the
   * same in both directions.
   */
  it('prints the delta to stderr, with its sign', async () => {
    const stderr = await runBaselineCapturingStderr(CONTROL_ARM_FAILS);

    expect(
      stderr.some((line) => line.includes('Baseline delta: +1')),
      `nothing on stderr reported the delta:\n${stderr.join('')}`,
    ).toBe(true);
  });

  /**
   * The withheld case, end to end. `armExpectationSkew` says the two arms were
   * graded to different depths, so subtracting their summaries is not a delta —
   * and a number here would lie in the most damaging direction, because a
   * short-graded control reads as "100% without the skill", i.e. "the skill did
   * nothing".
   *
   * Both halves are asserted because they fail independently: `delta: null` on
   * disk is worthless if stderr prints a number anyway, and "unavailable" on
   * stderr is worthless if the artifact an adopter attaches to a report carries a
   * fabricated figure.
   */
  it('withholds the delta, on disk and on stderr, when the arms are not comparable', async () => {
    const stderr = await runBaselineCapturingStderr(ARMS_GRADED_TO_DIFFERENT_DEPTHS);
    const delta = readBaselineDelta();

    expect(delta.delta, 'a delta was computed across mismatched denominators').toBeNull();
    expect(delta.perEval[0]?.delta, 'the incomparable eval still reported a lift').toBeNull();
    // The arms' own totals are still reported — they are what the withholding is
    // ABOUT, and an operator cannot check the skew claim without them.
    expect(delta.with).toEqual({ passed: 2, total: 2 });
    expect(delta.without).toEqual({ passed: 1, total: 1 });

    const line = stderr.find((l) => l.includes('Baseline delta:'));
    expect(line, `nothing on stderr mentioned the delta at all:\n${stderr.join('')}`).toBeDefined();
    expect(line, 'stderr reported a delta the artifact refused to compute').toContain('unavailable');
  });

  /**
   * `0` and `null` are DIFFERENT FINDINGS and must never collapse into each other.
   * `0` is "measured, and the skill lifted nothing" — a perfectly valid, publishable
   * result and often the most useful thing a baseline run can tell an author. `null`
   * is "no delta exists here". A future simplification that treats a falsy delta as
   * absent, or renders `0` as "unavailable", turns a real finding into a
   * non-measurement, and this is the assertion that stops it.
   */
  it('records a measured zero as 0, never as a withheld delta', async () => {
    const stderr = await runBaselineCapturingStderr({});
    const delta = readBaselineDelta();

    expect(delta.delta, 'a measured zero was collapsed into a withheld delta').toBe(0);
    expect(delta.with).toEqual({ passed: 1, total: 1 });
    expect(delta.without).toEqual({ passed: 1, total: 1 });
    expect(
      stderr.some((line) => line.includes('Baseline delta: +0')),
      `stderr did not report the measured zero as a number:\n${stderr.join('')}`,
    ).toBe(true);
  });

  /**
   * The scrub must SAY what it withheld, and say it truthfully — the withholding is
   * the only visible sign that the control arm was degraded, and a degraded control
   * scores lower, which reports as skill lift.
   *
   * Two things were wrong. The mutation audit found the stderr write was pinned by
   * nothing: every assertion was on `scrubControlArmEnv`'s RETURN VALUE, so deleting
   * the write left the suite green — the same "testing a pure helper never pins its
   * wiring" class this lane has now hit four times. And the one line it did write
   * described a merged list as "naming the harness root" when half of it is dropped
   * by NAME whatever its value: on this very run CLAUDE_PLUGIN_ROOT's value is under
   * the harness root only incidentally, and in the installed-plugin-cache case it is
   * not under it at all.
   *
   * So this asserts at the CALL SITE, on a run that triggers BOTH rules — plugin
   * layout supplies the rule-1 key, the declared `env:` supplies the rule-2 value —
   * and pins each name to the reason that actually caught it.
   */
  it('says on stderr what it withheld from the control arm, and by which rule', async () => {
    const { subjectDir } = writePluginFixture();
    const fake = makeHarnessFakeSpawn({});

    const { result, lines: stderr } = await captureStderr(() =>
      runSkillTestHarness(
        baselineOpts(subjectDir, fake.spawn, {
          // Interpolated at stage time, so the value genuinely names this run's
          // harness root rather than a literal a test author guessed.
          env: { SNAPSHOT: '${harnessRoot}/staged/data.json' },
        }),
      ),
    );

    expect(result.exitCode, result.summary).toBe(0);
    const withheld = stderr.filter((line) => line.includes('withheld'));

    const byName = withheld.find((line) => line.includes('by name, whatever their value'));
    expect(byName, `no rule-1 withholding line on stderr:\n${withheld.join('')}`).toBeDefined();
    expect(byName).toContain('CLAUDE_PLUGIN_ROOT');
    // The rule-2 line's wording must not be applied to it — that was the bug.
    expect(byName).not.toContain('SNAPSHOT');

    const byValue = withheld.find((line) => line.includes('because their value names the harness root'));
    expect(byValue, `no rule-2 withholding line on stderr:\n${withheld.join('')}`).toBeDefined();
    expect(byValue).toContain('SNAPSHOT');
    expect(byValue).not.toContain('CLAUDE_PLUGIN_ROOT');
  });

  /**
   * Three rounds of work went into making the control arm's number honest. This is
   * the test that asks whether the honest number is still on disk when the command
   * exits — on the invocation the docs tell adopters to use.
   *
   * It ran on the DEFAULT path: `harnessCreated` true, so `cleanupHarness` fired
   * from `runSkillTestHarness`'s own `finally` and `rmSync(recursive)`'d the harness
   * root — with `results/` inside it — before `run.ts` printed the `Harness:` line
   * that pointed at it. `--baseline --help` says to read `baselineIntegrity` in
   * `baseline.json`; the run's help says failing evals live in `grading.json`;
   * neither file existed by the time the process returned to the operator.
   *
   * The other half of the assertion matters just as much: cleanup must still evict
   * the staged untrusted skill bytes. "Retain the results" must not quietly become
   * "retain everything", or every default run leaves an executable copy of the
   * subject in OS tmp.
   */
  it('leaves results/ on disk after a DEFAULT run (no --out, no --workdir, no --keep)', async () => {
    // Distinct from SKILL_NAME: the harness root is derived from the subject name
    // into the shared OS temp dir, so a name reused by another test would have the
    // two runs fighting over one directory (and one lockfile).
    const subject = 'default-run-retention-skill';
    const { subjectDir } = writePluginFixture(subject);
    const fake = makeHarnessFakeSpawn({});

    const result = await runSkillTestHarness(defaultRunOpts(subjectDir, fake.spawn, subject));
    try {
      expect(result.exitCode, result.summary).toBe(0);

      // Reported, not derived — the operator is handed this path, and it has to be
      // the one that survived.
      expect(result.resultsPath, 'the run did not report where its artifacts went').toBeDefined();
      const resultsDir = result.resultsPath ?? '';

      for (const artifact of [BASELINE_JSON, 'grading.json', 'friction.json', 'tool-eval.json']) {
        expect(
          existsSync(safePath.join(resultsDir, artifact)),
          `${artifact} did not survive the default run's own cleanup`,
        ).toBe(true);
      }

      // baseline.json is not merely present — it still parses and still carries the
      // block the three prior rounds exist to make trustworthy.
      expect(readBaselineIntegrity(resultsDir).contaminated).toBe(false);

      // …and nothing else did. The staged subject tree is what cleanup is FOR.
      expect(readdirSync(result.harnessPath)).toEqual([RETAINED_RESULTS_DIRNAME]);
    } finally {
      // This harness root is in the machine's real temp dir, not the suite's
      // per-test dir, so the suite has to reap what it deliberately made survive.
      rmSync(result.harnessPath, { recursive: true, force: true });
    }
  });
});
