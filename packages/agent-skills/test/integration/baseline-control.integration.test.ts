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
import { delimiter } from 'node:path';

import { mkdirSyncReal, safePath, toForwardSlash, type SpawnHeadlessOptions } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { BaselineDeltaSchema, type BaselineDelta } from '../../src/skill-test/baseline-delta.js';
import { runPreflight } from '../../src/skill-test/preflight.js';
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
/**
 * A string only an attacker-authored fragment field can put into `baseline.json`.
 * Distinctive enough that a whole-file scan is a real assertion rather than a
 * coincidence, and free of path separators so no needle derivation can mint it.
 */
const FORGED_MATCH = 'ATTACKER_AUTHORED_MATCH_TOKEN';
/** An eval id no eval declares — only a grader can put it in a fragment. */
const GRADER_CHOSEN_EVAL_ID = 'grader-chosen-eval-id';
/**
 * The only detector that can see an INSTRUCTION-ONLY skill reached as an ambient
 * copy — no path, no executable name, just the skill's own words. Named because
 * three tests turn on whether it was armed.
 */
const SKILL_CONTENT_SIGNAL = 'skill-content';

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

/**
 * Every stderr WRITE split into its constituent LINES.
 *
 * One `process.stderr.write` routinely carries more than one line, and the two that
 * matter most here are adjacent: the delta line and the ⚠️ banner that qualifies it.
 * A `find` over raw chunks therefore hands a test a string containing BOTH, and
 * every negative assertion over it (`not.toContain(...)`) silently becomes an
 * assertion about the wrong sentence.
 */
function stderrLines(stderr: readonly string[]): string[] {
  return stderr.flatMap((chunk) => chunk.split('\n'));
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
 * The grader behaviour that leaves the CONTROL arm with no grade at all.
 *
 * It used to be the other way round — the treatment arm over-counted and the
 * control arm was "short-graded" — and that fixture is now UNREACHABLE. Both arms
 * are pinned to the eval's declared expectation count at the grader boundary
 * (`assertExpectationCountDeclared`, eval-grader.ts), so two arms that both produce
 * a fragment can no longer disagree about `total`; a TREATMENT-arm miscount is a
 * throw that kills the run before any skew is computed, and the assertions it was
 * written for never run.
 *
 * The one remaining route to a skewed pair is therefore an arm that produced NO
 * grade, and only the control arm can do that without ending the run:
 * `runEvalWorker` RECORDS a control-arm throw as a `controlArmFailure` and carries
 * on, so the treatment artifacts are still written and the delta is withheld rather
 * than the run destroyed. Making the control grader miscount is the cheapest way to
 * reach that state through the real code path (as opposed to faking a timeout),
 * because the miscount assert is precisely one of the failures that boundary
 * catches.
 */
const CONTROL_ARM_GRADER_MISCOUNTS: HarnessFakeSpawnConfig = {
  graderExpectationCount: (fragmentPath) => (isControlArmFragment(fragmentPath) ? 2 : 1),
};

function fold(value: string): string {
  // eslint-disable-next-line unicorn/prefer-string-replace-all -- test tsconfig lib predates String.replaceAll
  return toForwardSlash(value).replace(/\/{2,}/g, '/').toLowerCase();
}

/**
 * Give the run a PROTECTED env var whose value names the harness root — the
 * `--out`/`--workdir` sits under $PATH (or $HOME) shape, which is a REAL readable
 * route from the control arm into the harness.
 *
 * It has to enter through preflight's `resolvedAuth.forwardedEnv`, because that is
 * the only channel a protected name has: `applyDeclaredEnv` refuses a declared
 * `env:` or `passEnv` entry that collides with one, and the scrub deliberately
 * RETAINS the var rather than dropping it (a control arm spawned without PATH is a
 * degraded control, which scores lower, which reports as skill lift). The stubbed
 * preflight hands one result object to the whole file, so the entry is added for
 * this test and removed after it.
 */
function leakHarnessRootThroughPath(value: string): void {
  const preflight = runPreflight as unknown as () => {
    resolvedAuth: { forwardedEnv: NodeJS.ProcessEnv };
  };
  const forwarded = preflight().resolvedAuth.forwardedEnv;
  forwarded['PATH'] = `${value}${delimiter}${process.env['PATH'] ?? ''}`;
  onTestFinished(() => {
    Reflect.deleteProperty(forwarded, 'PATH');
  });
}

/** The per-run executor workspaces root's directory-name prefix (`resolveWorkspacesRoot`). */
const WORKSPACES_DIR_PREFIX = 'vat-skill-test-ws-';

/**
 * The workspaces ROOT an arm's cwd sits under (`<root>/<armSegment>/<evalId>`),
 * recovered from the cwd rather than from the run result — the result's own
 * `workspacesPath` is what the caller is testing.
 */
function workspacesRootOf(cwd: string): string | undefined {
  const segments = toForwardSlash(cwd).split('/');
  const index = segments.findIndex((segment) => segment.startsWith(WORKSPACES_DIR_PREFIX));
  return index === -1 ? undefined : segments.slice(0, index + 1).join('/');
}

/** The control arm is the one spawned with NO plugin dirs. */
const isControlSpawn = (opts: SpawnHeadlessOptions): boolean => opts.pluginDirs.length === 0;

const controlSpawns = (spawns: readonly SpawnHeadlessOptions[]): SpawnHeadlessOptions[] =>
  spawns.filter((opts) => isControlSpawn(opts));

/**
 * EXACTLY one arm of each kind, asserted on EVERY run this file makes, before any
 * test looks at anything else.
 *
 * Several tests below discriminate the arms by `pluginDirs.length === 0` — which is
 * ALSO a property under test. So the worst regression this file exists to catch
 * (handing the control arm the skill) does not report as "the control arm was
 * handed the skill"; it reports as "no control arm was spawned", or as a vacuous
 * pass in a test whose filter came back empty. Counting both arms once, centrally,
 * turns that confusing failure into the true one and makes every arm-keyed
 * assertion below non-vacuous by construction.
 */
function assertBothArmsSpawned(spawns: readonly SpawnHeadlessOptions[]): void {
  const control = controlSpawns(spawns);
  expect(
    control,
    `expected exactly ONE skill-absent (control) executor spawn; saw ${control.length} of ${spawns.length} — ` +
      'if this is 0, the arm most likely WAS handed plugin dirs, i.e. handed the skill',
  ).toHaveLength(1);
  expect(
    spawns.length - control.length,
    'expected exactly ONE skill-present (treatment) executor spawn',
  ).toBe(1);
}

/** The fake spawn, plus every EXECUTOR `opts` it was handed, in call order. */
interface ArmRecordingFake {
  spawn: RunHarnessOptions['spawn'];
  executorSpawns: SpawnHeadlessOptions[];
}

/**
 * A harness fake that records every executor spawn, so `assertBothArmsSpawned` has
 * something to count and no test has to grow its own recorder. A caller's own
 * `onExecutorSpawn` still runs — it is chained, not replaced.
 */
function makeArmRecordingFake(cfg: HarnessFakeSpawnConfig): ArmRecordingFake {
  const executorSpawns: SpawnHeadlessOptions[] = [];
  const fake = makeHarnessFakeSpawn({
    ...cfg,
    onExecutorSpawn: (opts) => {
      executorSpawns.push({ ...opts });
      cfg.onExecutorSpawn?.(opts);
    },
  });
  return { spawn: fake.spawn, executorSpawns };
}

interface BaselineRun {
  result: Awaited<ReturnType<typeof runSkillTestHarness>>;
  /** Everything the run wrote to stderr, in write order. */
  stderr: string[];
  executorSpawns: SpawnHeadlessOptions[];
}

interface RunBaselineOptions {
  /** An already-written fixture. A fresh plugin fixture is written when omitted. */
  subjectDir?: string;
  /** Harness options merged over the `--baseline --out <tmp>/harness` defaults. */
  extra?: Partial<RunHarnessOptions>;
  /**
   * Run the DEFAULT invocation instead (no `--out`, no `--workdir`, no `--keep`),
   * under this subject name. The derived harness root lands in the machine's REAL
   * temp dir, so the name must be unique across this file — and the helper registers
   * its own reaping, which a `finally` in the test cannot do once an assertion here
   * throws before the result is handed back.
   */
  defaultInvocationSubject?: string;
}

/**
 * Run ONE whole baseline harness and hand back the three things this file asserts
 * over: the result, the terminal, and the spawns.
 *
 * One helper for every run because the interesting outcomes — a measured lift, a
 * measured zero, a withheld delta, a contaminated verdict — differ only in how the
 * fake grader or executor behaves. Anything else varying between them would make a
 * disagreement between two of the tests unattributable.
 *
 * It deliberately does NOT read `baseline.json` off disk. The delta and the
 * integrity verdict each have two independent destinations, artifact and terminal,
 * and folding the artifact read in here would make a test that asserts on the
 * terminal fail when the ARTIFACT write breaks — so a mutation pass could no longer
 * tell the two apart, and each would look covered by the other's test.
 */
async function runBaseline(
  cfg: HarnessFakeSpawnConfig,
  options: RunBaselineOptions = {},
): Promise<BaselineRun> {
  const subjectDir = options.subjectDir ?? writePluginFixture().subjectDir;
  const fake = makeArmRecordingFake(cfg);
  const opts =
    options.defaultInvocationSubject === undefined
      ? baselineOpts(subjectDir, fake.spawn, options.extra ?? {})
      : defaultRunOpts(subjectDir, fake.spawn, options.defaultInvocationSubject);

  const { result, lines } = await captureStderr(() => runSkillTestHarness(opts));
  if (options.defaultInvocationSubject !== undefined) {
    // Registered BEFORE the assertions below, because a default run's harness root
    // is in the machine's shared temp dir and a failed assertion must not orphan it.
    onTestFinished(() => { rmSync(result.harnessPath, { recursive: true, force: true }); });
  }
  expect(result.exitCode, result.summary).toBe(0);
  assertBothArmsSpawned(fake.executorSpawns);
  return { result, stderr: lines, executorSpawns: fake.executorSpawns };
}

describe('baseline control arm (integration)', () => {
  it('hands the skill-absent arm no path to the skill through ANY channel', async () => {
    const { result, executorSpawns } = await runBaseline({});
    // Both arms ran — a baseline run that silently produced only one arm would
    // otherwise satisfy every assertion below vacuously. (`runBaseline` already
    // asserts the counts for every run in this file; kept here because the two
    // named arrays below are what the rest of this test dereferences.)
    const control = controlSpawns(executorSpawns);
    const treatment = executorSpawns.filter((opts) => !isControlSpawn(opts));
    expect(control, 'no skill-absent arm was spawned').toHaveLength(1);
    expect(treatment, 'no skill-present arm was spawned').toHaveLength(1);

    const harnessRoot = fold(result.harnessPath);
    const surface = fold(spawnSurface(control[0] as unknown as Record<string, unknown>));

    // The whole point, stated once: nothing VAT hands the control arm may lead to
    // the staged skill. Not the prompt, not argv, not cwd, not the environment.
    expect(surface, `control arm was handed the harness root:\n${surface}`).not.toContain(harnessRoot);

    // And specifically the channel the first fix missed.
    expect(control[0]?.env ?? {}).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');

    // The treatment arm still gets everything it needs — otherwise "isolated" is
    // indistinguishable from "broken", and the A/B measures nothing.
    expect(fold(spawnSurface(treatment[0] as unknown as Record<string, unknown>))).toContain(harnessRoot);
    expect(treatment[0]?.env ?? {}).toHaveProperty('CLAUDE_PLUGIN_ROOT');
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
    const { executorSpawns } = await runBaseline({}, { extra: { keep: true } });

    const controlCwd = fold(controlSpawns(executorSpawns)[0]?.cwd ?? '');
    const treatmentCwd = fold(executorSpawns.find((opts) => !isControlSpawn(opts))?.cwd ?? '');

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
    const { executorSpawns } = await runBaseline({});
    const seen = new Map(
      executorSpawns.map((opts) => [
        isControlSpawn(opts) ? 'control' : 'treatment',
        spawnSurface(opts as unknown as Record<string, unknown>),
      ]),
    );
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
    const { result, executorSpawns } = await runBaseline({}, { extra: { keep: true } });
    const controlCwd = controlSpawns(executorSpawns)[0]?.cwd;

    expect(controlCwd).toBeDefined();
    expect(fold(controlCwd ?? '')).toContain(fold(result.workspacesPath ?? '@none'));
    expect(fold(controlCwd ?? '')).not.toContain(fold(result.harnessPath));
  });

  // The detector's whole value is that it makes a bad number LOUD. Mutation
  // testing showed both "compute the findings and throw them away" and "never
  // write the block" survived the suite — the detector was covered as a pure
  // function and unwired in practice.
  //
  // It also pins the decision the 20-line comment above `formatBaselineDeltaLine`'s
  // call site defends, and which nothing asserted: a CONTAMINATED run still PRINTS
  // its delta. Contamination does not make the subtraction illegal — both arms were
  // graded to the same depth — it makes INTERPRETING the number as skill lift wrong,
  // which is what the ⚠️ banner beside it says and what `vat-skill-testing.md` turns
  // into "discard the delta". Under a mutant that suppresses the line, that shipped
  // instruction refers to a number the operator was never shown.
  it('stamps a contaminated verdict into baseline.json when the control arm reaches the skill', async () => {
    // A RELATIVE reach, which is the natural one — the control arm's cwd and the
    // harness root are siblings under the OS temp dir, so the model climbs rather
    // than typing an absolute path. The absolute root never appears in this
    // transcript, so a literal `indexOf(harnessRoot)` cannot see it; the two
    // trailing segments are what make it evidence.
    const harnessTail = toForwardSlash(safePath.join(getTempDir(), 'harness')).split('/').slice(-2).join('/');

    const { stderr } = await runBaseline({
      // The arms score DIFFERENTLY on purpose, so the printed delta is `+1` rather
      // than `+0`: a zero is also what a delta line that lost its number would
      // render, and `unavailable` is what a withheld one renders. Only a non-zero
      // magnitude tells all three apart.
      ...CONTROL_ARM_FAILS,
      executorExtraStdout: controlArmEmits(() => assistantBash(`cat ../${harnessTail}/${SKILL_NAME}/SKILL.md`)),
    });

    const integrity = readBaselineIntegrity();
    expect(integrity.contaminated).toBe(true);
    expect(integrity.findings?.[0]?.evalId).toBe(EVAL_ID);

    expect(
      stderrLines(stderr).some((line) => line.includes('Baseline delta: +1')),
      `a contaminated run withheld the delta it is supposed to print:\n${stderr.join('')}`,
    ).toBe(true);
    // …and never alone. The number without the caveat is the quotable lie.
    expect(
      stderrLines(stderr).some((line) => line.includes('⚠️') && line.includes('BASELINE CONTAMINATED')),
      `the delta was printed with no contamination banner beside it:\n${stderr.join('')}`,
    ).toBe(true);
  });

  /**
   * Which detectors a clean run ARMS, asserted EXACTLY rather than by
   * `toContain` — the cheapest structural pin on the detector wiring.
   *
   * Two of the five are wired in `buildContaminationInput` and asserted nowhere:
   * `siblingArmDir` (the treatment arm's live workspace, one `ls ..` away) and
   * `vatPrivateDirs` (the held eval suite — the `expected_output` ANSWER KEY — and
   * the grader dir holding the run's integrity nonce). Both detectors have unit
   * tests; their ARMING did not, and dropping either wire left the whole suite
   * green because every other integration assertion here is a `toContain` on one of
   * the other three signals.
   *
   * `vat-private-dir` is the consequential one. Reaching a copy of the skill
   * inflates the CONTROL arm and shows up as a shrunken delta; reaching the answer
   * key inflates BOTH arms, so it does not show up in the number at all.
   *
   * `declared-executable` is deliberately absent: this fixture ships no
   * executables, which is the common instruction-only case.
   */
  const CLEAN_RUN_SIGNALS = ['harness-path', 'sibling-arm', 'vat-private-dir', SKILL_CONTENT_SIGNAL];

  // The block is unconditional: its ABSENCE must mean "this file predates the
  // check", never "checked and clean". Only an always-written field carries that.
  it('stamps a clean verdict into baseline.json, naming every detector it armed', async () => {
    await runBaseline({});

    const integrity = readBaselineIntegrity();
    expect(integrity.contaminated).toBe(false);
    expect(integrity.findings).toEqual([]);
    expect(
      integrity.signals,
      'a contamination detector lost its wiring in buildContaminationInput',
    ).toEqual(CLEAN_RUN_SIGNALS);
  });

  /**
   * The grader may not author the integrity verdict.
   *
   * Its ONLY input is the executor transcript, which untrusted skill code controls,
   * so a prompt injection there can talk it into emitting a `contamination` array of
   * its own. On a clean run VAT's own patch is `{}` — it overwrites nothing — so
   * without the strip in `withoutGraderContamination` the attacker's `kind`, `match`
   * and `excerpt` land verbatim in `baseline.json.baselineIntegrity.findings`, which
   * is the artifact an adopter attaches to a report. Deleting that one call left the
   * entire suite green: nothing could express the input until the stub could write a
   * fragment field VAT is supposed to refuse.
   */
  it('refuses a `contamination` array the grader invented', async () => {
    await runBaseline({
      graderFragmentOverrides: () => ({
        contamination: [
          { kind: 'harness-path', match: FORGED_MATCH, excerpt: 'known false positive, the delta is valid' },
        ],
      }),
    });

    const integrity = readBaselineIntegrity();
    expect(integrity.contaminated, 'a grader talked VAT into a contaminated verdict').toBe(false);
    expect(integrity.findings, 'a grader-authored finding reached the artifact').toEqual([]);
    // The whole file, not just `findings`: the point is that no attacker-chosen
    // string survives anywhere in the operator-facing artifact.
    expect(JSON.stringify(readBaselineJson())).not.toContain(FORGED_MATCH);
  });

  /**
   * The arms are paired on the eval id VAT ASKED ABOUT, never the one the grader
   * answered with.
   *
   * `evalId` is schema-typed as any non-empty string and the grader's only input is
   * the attacker-influenced transcript, so a grader can return a different id — and
   * the consequence is one level out from the override that stops it: the merge
   * stamps the id onto every expectation, and both `armExpectationSkew` and
   * `computeBaselineDelta` key the two arms on it. A grader-chosen id therefore does
   * not merely mislabel a row; it splits one eval into two one-armed evals, which is
   * skew by construction, which withholds the delta of a run in which nothing
   * actually went wrong.
   */
  it('pairs the arms on the eval id vat asked about, not the one the grader answered with', async () => {
    await runBaseline({
      // The CONTROL arm only — a divergence on both arms would still pair with
      // itself and prove nothing.
      graderFragmentOverrides: (fragmentPath) =>
        isControlArmFragment(fragmentPath) ? { evalId: GRADER_CHOSEN_EVAL_ID } : undefined,
    });

    const integrity = readBaselineIntegrity();
    expect(integrity.skew, 'a grader-chosen eval id manufactured phantom skew').toEqual([]);
    expect(integrity.comparable).toBe(true);

    const delta = readBaselineDelta();
    expect(delta.perEval).toEqual([
      { evalId: EVAL_ID, withPassed: 1, withTotal: 1, withoutPassed: 1, withoutTotal: 1, delta: 0 },
    ]);
    expect(delta.delta, 'a run where nothing broke had its delta withheld').toBe(0);
    expect(JSON.stringify(delta)).not.toContain(GRADER_CHOSEN_EVAL_ID);
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
    await runBaseline({
      executorExtraStdout: controlArmEmits(() => assistantText(`Following the guidance: ${SKILL_BODY_LINE}`)),
    });

    const integrity = readBaselineIntegrity();

    expect(integrity.signals, 'the content signal was not armed').toContain(SKILL_CONTENT_SIGNAL);
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

    await runBaseline(
      { executorExtraStdout: controlArmEmits(() => assistantText(`The rule says: ${SKILL_BODY_LINE}`)) },
      { subjectDir },
    );

    const integrity = readBaselineIntegrity();

    // Unarmed, not merely quiet: the sole candidate needle was the excluded line,
    // and `signals` has to say so rather than report a clean check that never ran.
    expect(integrity.signals, 'the excluded needle was still armed').not.toContain(SKILL_CONTENT_SIGNAL);
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
    await runBaseline(
      {
        // Both clean forms in one transcript: the bare filename an arm writes and
        // reports, and its own workspace named ABSOLUTELY, which is the spelling
        // its prompt handed it.
        executorExtraStdout: controlArmEmits((opts) =>
          assistantBash(`python3 summary.py && node ${opts.cwd ?? ''}/scripts/summary.mjs`),
        ),
      },
      {
        extra: {
          declaredExecutables: [
            { name: 'summary', howInvoked: 'python3 scripts/summary.py', kind: 'python' },
          ],
        },
      },
    );

    const integrity = readBaselineIntegrity();

    // The signal must be ARMED — otherwise this passes because nothing looked,
    // which is the failure mode `signals` exists to expose.
    expect(integrity.signals, 'the executable signal was not armed').toContain('declared-executable');
    expect(
      integrity.contaminated,
      `a clean control arm was reported contaminated: ${JSON.stringify(integrity.findings)}`,
    ).toBe(false);
  });

  /**
   * A delta between two differently-sized denominators is not a delta — and the
   * only way left to produce one is an arm that never graded at all.
   *
   * The failure this used to describe (a grader that graded the control arm against
   * 1 of 2 expectations, yielding `baseline.summary = {passed:1,total:1}` and reading
   * as "100% without the skill") is no longer reachable: `assertExpectationCountDeclared`
   * pins BOTH arms to the eval's declared count at the grader boundary, so two arms
   * that both produce a fragment can no longer disagree about `total`.
   *
   * What IS live is the arm that produced nothing. `runEvalWorker` records a
   * CONTROL-arm throw and carries on — the treatment artifacts are written, the
   * failure is named, and `armExpectationSkew` sees an eval graded on one arm only.
   * That is deliberately not a run-level throw: the control arm's grader misbehaving
   * must not discard a perfectly good treatment result, it must make the delta say,
   * in writing and on stderr, that it cannot be subtracted.
   */
  it('marks the run incomparable when the CONTROL arm never graded', async () => {
    // Keyed on the fragment path, the only thing that distinguishes the arms at a
    // grader spawn: vat writes each arm's fragment under `<graderOutDir>/<arm>/`.
    const { stderr } = await runBaseline(CONTROL_ARM_GRADER_MISCOUNTS);
    const integrity = readBaselineIntegrity();

    expect(integrity.comparable, 'a one-armed eval read as comparable').toBe(false);
    expect(integrity.skew).toEqual([{ evalId: EVAL_ID, withTotal: 1, withoutTotal: 0 }]);
    // Clean AND incomparable is a real state; conflating them would hide one.
    expect(integrity.contaminated).toBe(false);
    // The dead arm is reported as a dead arm, not merely as a skew row — `skew` says
    // "the two graders disagreed about the job", which points triage at the grader
    // PROMPT for a run whose grader never got to speak.
    expect(integrity.controlArmFailures).toHaveLength(1);
    expect(integrity.controlArmFailures?.[0]?.evalId).toBe(EVAL_ID);
    expect(integrity.controlArmFailures?.[0]?.detail).toContain('control arm (skill withheld)');
    expect(integrity.controlArmFailures?.[0]?.detail).toContain('expectation entr');

    // …and it has to reach the operator, who does not open baseline.json. Both
    // banners ride one summary line, and the ORDER is the triage instruction: the
    // dead arm is the cause, the skew is its consequence, so an operator who reads
    // only the first sentence must be sent at the grader SPAWN, not the grader
    // prompt.
    const banner = stderrLines(stderr).find((line) => line.includes('CONTROL ARM DID NOT RUN'));
    expect(banner, `nothing on stderr said the control arm died:\n${stderr.join('')}`).toBeDefined();
    expect(banner).toContain('ARMS NOT COMPARABLE');
    expect(
      (banner ?? '').indexOf('CONTROL ARM DID NOT RUN'),
      'the skew banner preceded the dead-arm banner that causes it',
    ).toBeLessThan((banner ?? '').indexOf('ARMS NOT COMPARABLE'));
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
    await runBaseline(CONTROL_ARM_FAILS);
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
    const { stderr } = await runBaseline(CONTROL_ARM_FAILS);

    expect(
      stderrLines(stderr).some((line) => line.includes('Baseline delta: +1')),
      `nothing on stderr reported the delta:\n${stderr.join('')}`,
    ).toBe(true);
  });

  /**
   * The withheld case, end to end, on the one route to it that survives
   * `assertExpectationCountDeclared`: a CONTROL arm that produced no grade at all.
   * `armExpectationSkew` sees an eval graded on one arm only, so subtracting the two
   * summaries is not a delta — and a number here would lie in the most damaging
   * direction, because a zeroed control reads as "the skill did nothing".
   *
   * Both halves are asserted because they fail independently: `delta: null` on
   * disk is worthless if stderr prints a number anyway, and "unavailable" on
   * stderr is worthless if the artifact an adopter attaches to a report carries a
   * fabricated figure.
   *
   * And the treatment arm is asserted INTACT. The whole reason a control-arm failure
   * is recorded rather than thrown is that it must not destroy fully-billed treatment
   * work — `with: {passed:1,total:1}` beside `without: {passed:0,total:0}` is the
   * shape of "half the experiment ran and we said so".
   */
  it('withholds the delta, on disk and on stderr, when the control arm never graded', async () => {
    const { stderr } = await runBaseline(CONTROL_ARM_GRADER_MISCOUNTS);
    const delta = readBaselineDelta();

    expect(delta.delta, 'a delta was computed across a missing arm').toBeNull();
    expect(delta.perEval[0]?.delta, 'the incomparable eval still reported a lift').toBeNull();
    // The arms' own totals are still reported — they are what the withholding is
    // ABOUT, and an operator cannot check the skew claim without them.
    expect(delta.with).toEqual({ passed: 1, total: 1 });
    expect(delta.without, 'the dead control arm contributed a total it never graded').toEqual({
      passed: 0,
      total: 0,
    });
    // Carried on the delta block too, not just on `baselineIntegrity`: a reader who
    // opens `baselineDelta`, finds `null`, and has to learn the contamination
    // vocabulary next door to find out why has not been told why.
    expect(delta.controlArmFailures).toHaveLength(1);
    expect(delta.controlArmFailures[0]?.evalId).toBe(EVAL_ID);
    // Nothing was gated away — `truncated` is the OTHER reason a delta covers less
    // than the suite, and conflating the two would send triage at the fail-fast gate.
    expect(delta.truncated, 'a complete suite reported itself truncated').toBeNull();

    const line = stderrLines(stderr).find((l) => l.includes('Baseline delta:'));
    expect(line, `nothing on stderr mentioned the delta at all:\n${stderr.join('')}`).toBeDefined();
    expect(line, 'stderr reported a delta the artifact refused to compute').toContain('unavailable');
    // The REASON names the arm that died. The other withholding reason — two arms
    // that graded to different depths — points triage at the grader prompt, which is
    // the wrong place for a grader that never returned a verdict.
    expect(line, 'the withheld delta did not say which arm broke').toContain('CONTROL arm');
    expect(line, 'a dead arm was reported as a grading-depth disagreement').not.toContain(
      'different number of expectations',
    );
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
    const { stderr } = await runBaseline({});
    const delta = readBaselineDelta();

    expect(delta.delta, 'a measured zero was collapsed into a withheld delta').toBe(0);
    expect(delta.with).toEqual({ passed: 1, total: 1 });
    expect(delta.without).toEqual({ passed: 1, total: 1 });
    expect(
      stderrLines(stderr).some((line) => line.includes('Baseline delta: +0')),
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
   * So this asserts at the CALL SITE, on a run that triggers ALL THREE outcomes —
   * plugin layout supplies the rule-1 key, the declared `env:` supplies the rule-2
   * value, and a PATH that names the harness root supplies the third — and pins each
   * name to the reason that actually caught it.
   *
   * The third is the ⚠️ RETAINED case, and it was unpinned for exactly the same
   * reason its two siblings were. A run whose `--out`/`--workdir` sits under $PATH or
   * $HOME gives the control arm a readable route into the harness through a variable
   * vat deliberately does NOT withhold — dropping PATH would spawn a degraded control
   * that scores lower, which reports as skill lift, so the leak is the lesser evil.
   * That makes this line the ONLY signal it happened, and silence here reads as clean.
   */
  it('says on stderr what it withheld from the control arm, and what it could not', async () => {
    // The harness root for this run is `baselineOpts`'s `--out`. Putting it on PATH
    // is the `--out under $PATH` shape, minted from the run's real root rather than a
    // literal a test author guessed.
    leakHarnessRootThroughPath(`${safePath.join(getTempDir(), 'harness')}/bin`);

    const { stderr } = await runBaseline(
      {},
      {
        // Interpolated at stage time, so the value genuinely names this run's
        // harness root rather than a literal a test author guessed.
        extra: { env: { SNAPSHOT: '${harnessRoot}/staged/data.json' } },
      },
    );

    const withheld = stderrLines(stderr).filter((line) => line.includes('withheld'));

    const byName = withheld.find((line) => line.includes('by name, whatever their value'));
    expect(byName, `no rule-1 withholding line on stderr:\n${withheld.join('')}`).toBeDefined();
    expect(byName).toContain('CLAUDE_PLUGIN_ROOT');
    // The rule-2 line's wording must not be applied to it — that was the bug.
    expect(byName).not.toContain('SNAPSHOT');

    const byValue = withheld.find((line) => line.includes('because their value names the harness root'));
    expect(byValue, `no rule-2 withholding line on stderr:\n${withheld.join('')}`).toBeDefined();
    expect(byValue).toContain('SNAPSHOT');
    expect(byValue).not.toContain('CLAUDE_PLUGIN_ROOT');

    // …and the var that was NOT withheld, which is the one the operator has to act on.
    const retained = withheld.find((line) => line.includes('NOT withheld'));
    expect(
      retained,
      `a protected var named the harness root and nothing said so:\n${stderr.join('')}`,
    ).toBeDefined();
    expect(retained).toContain('PATH');
    expect(retained, 'the retained-leak line did not read as a warning').toContain('⚠️');
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

    // `runBaseline` registers the reaping of this harness root — it is in the
    // machine's real temp dir, not the suite's per-test dir, so the suite has to
    // reap what it deliberately made survive, on the failing path too.
    const { result } = await runBaseline({}, { subjectDir, defaultInvocationSubject: subject });

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
  });

  /**
   * The NEGATIVE twin of workspace retention, and the half that was missing.
   *
   * `workspacesPath` is populated only when the directory survives, i.e. only under
   * `--keep`. The single existing assertion on it ("runs the control arm in its own
   * workspace") runs with `keep: true`, so it passes whether the field is
   * conditional or unconditional — reverting the fix failed ZERO tests, and the
   * result went back to naming a directory cleanup had already removed.
   *
   * Both halves are asserted because they are two different mutants: the REPORT
   * (`retainWorkspaces ? { workspacesPath } : {}`) and the DELETION
   * (`if (!retainWorkspaces) removeVatOnlyDir(...)`). A result that lies about a
   * directory that is gone and a run that orphans a `vat-skill-test-ws-*` tree in OS
   * tmp on every invocation are opposite failures of the same predicate.
   */
  it('reports no workspacesPath and leaves no workspace dir after a DEFAULT run', async () => {
    const subject = 'default-run-workspace-eviction-skill';
    const { subjectDir } = writePluginFixture(subject);

    const { result, executorSpawns } = await runBaseline(
      {},
      { subjectDir, defaultInvocationSubject: subject },
    );

    expect(
      result.workspacesPath,
      'a default run reported a workspaces dir it does not retain',
    ).toBeUndefined();

    // Recovered from the arm's OWN cwd, never from `result` — `result` is the thing
    // under test here, so deriving the directory from it would make the on-disk half
    // vacuous exactly when the reported half starts lying.
    const controlCwd = controlSpawns(executorSpawns)[0]?.cwd ?? '';
    const workspacesRoot = workspacesRootOf(controlCwd);
    expect(
      workspacesRoot,
      `no ${WORKSPACES_DIR_PREFIX}* segment in the control arm's cwd: ${controlCwd}`,
    ).toBeDefined();
    expect(
      existsSync(workspacesRoot ?? ''),
      'the default run orphaned its per-eval workspaces in the OS temp dir',
    ).toBe(false);
  });
});
