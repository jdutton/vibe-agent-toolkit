/* eslint-disable security/detect-non-literal-fs-filename -- test paths derived from our own temp harness dirs */
/**
 * FULL-WIRING tests for `runSkillTestHarness` — the ones that must drive the real
 * orchestrator end to end because the thing under test is the WIRING, not a pure
 * function anyone can call directly.
 *
 * The executor→grader pipeline is driven with an INJECTED fake spawn (opts.spawn),
 * so no real `claude` is needed; preflight + staging are stubbed so the
 * orchestrator reaches the real pipeline/merge/verdict/artifact-write path.
 *
 * Three families live here, each because a unit test of the same behaviour would
 * have passed while the shipped run did the wrong thing:
 *
 * 1. The per-eval grader integrity NONCE (issue #145). One secret per-run nonce is
 *    stamped into every grader prompt (in-memory only, never to disk) and every
 *    merged fragment must echo it; a wrong/absent nonce — the signature of a forged
 *    or left-behind fragment written by untrusted skill code — is a GradingNonceError
 *    (exit 1).
 * 2. A CONTROL-arm failure must not destroy the treatment run. Every unit here is
 *    fine in isolation; the defect was that the throw propagated out of `runPipeline`
 *    and `results/` ended up holding only `provenance.json`.
 * 3. `baseline.json` must TELL THE TRUTH about the scan and the scope behind its
 *    numbers — a degraded contamination scan and a fail-fast-truncated suite were
 *    both fully implemented and then never reached the artifact, which is a wiring
 *    defect no test of either component could see.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import type { BaselineDelta } from '../../src/skill-test/baseline-delta.js';
import type { BaselineIntegrity } from '../../src/skill-test/baseline-integrity.js';
import { GradingNonceError } from '../../src/skill-test/grading-adapter.js';
import { runSkillTestHarness } from '../../src/skill-test/run-harness.js';
import { stageHarness } from '../../src/skill-test/staging.js';
import { setupStubbedHarnessSubject } from '../test-helpers.js';

import { makeHarnessFakeSpawn, SPAWN_TIMED_OUT } from './spawn-stub.js';

vi.mock('../../src/skill-test/preflight.js', async (io) => (await import('./preflight-stub.js')).passingPreflight(io));

vi.mock('../../src/skill-test/staging.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, stageHarness: vi.fn() };
});

type FakeSpawn = ReturnType<typeof makeHarnessFakeSpawn>['spawn'];

/** Run the acknowledged harness against a fixed harness output dir under `tempDir`. */
function runHarness(
  tempDir: string,
  authoredDir: string,
  spawn: FakeSpawn,
  extra?: {
    tolerateEvalFailure?: boolean;
    baseline?: boolean;
    dryRun?: boolean;
    env?: Record<string, string>;
    /** Collapse the pipeline's rate-limit backoff so the retry budget is spent instantly. */
    fastRateLimitRetries?: boolean;
  },
): ReturnType<typeof runSkillTestHarness> {
  return runSkillTestHarness({
    subject: 'my-skill',
    repoRoot: tempDir,
    out: safePath.join(tempDir, 'harness'),
    subjectSource: { path: authoredDir },
    subjectScaffoldDir: authoredDir,
    acknowledgedRunsSkillCode: true,
    spawn,
    ...(extra?.tolerateEvalFailure === undefined ? {} : { tolerateEvalFailure: extra.tolerateEvalFailure }),
    ...(extra?.baseline === undefined ? {} : { baseline: extra.baseline }),
    ...(extra?.dryRun === undefined ? {} : { dryRun: extra.dryRun }),
    ...(extra?.env === undefined ? {} : { env: extra.env }),
    ...(extra?.fastRateLimitRetries === true ? { rateLimitBackoffMs: () => 0 } : {}),
  });
}

/** Every file currently in the run's `results/`, name → bytes. */
function snapshotResults(tempDir: string): Record<string, string> {
  const dir = safePath.join(tempDir, 'harness', 'results');
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => [name, readFileSync(safePath.join(dir, name), 'utf8')]),
  );
}

/** One eval declaring exactly one expectation, optionally in a named tier. */
interface TestEval {
  id: string;
  tier?: number;
}

/**
 * Replace the shared one-eval fixture suite with a bespoke one.
 *
 * The suite is written to the AUTHORED dir, which is where the harness reads it
 * from — the staged dir deliberately carries none (the answer key never reaches
 * anything the executor can read).
 */
function writeEvalSuite(authoredDir: string, evals: readonly TestEval[]): void {
  writeFileSync(
    safePath.join(authoredDir, 'evals', 'evals.json'),
    JSON.stringify({
      skill_name: 'demo',
      evals: evals.map((e) => ({
        id: e.id,
        prompt: 'p',
        expected_output: 'o',
        expectations: ['e'],
        ...(e.tier === undefined ? {} : { tier: e.tier }),
      })),
    }) + '\n',
    'utf8',
  );
}

/** The two extra blocks a `--baseline` run stamps onto `baseline.json`. */
interface BaselineArtifact {
  summary: { passed: number; total: number };
  baselineIntegrity: BaselineIntegrity;
  baselineDelta: BaselineDelta;
}

/** The treatment arm's aggregate verdict artifact — read in several of these tests. */
const GRADING_JSON = 'grading.json';
const BASELINE_JSON = 'baseline.json';
/** Everything the merge writes BESIDES grading.json — all four must survive a broken arm. */
const OTHER_MERGED_ARTIFACTS = ['friction.json', 'tool-eval.json', BASELINE_JSON];

function readResult(tempDir: string, name: string): unknown {
  return JSON.parse(readFileSync(safePath.join(tempDir, 'harness', 'results', name), 'utf8'));
}

const readBaseline = (tempDir: string): BaselineArtifact => readResult(tempDir, BASELINE_JSON) as BaselineArtifact;

/**
 * A control arm (`pluginDirs: []`) whose executor is killed by the wall-clock
 * watchdog — an `InternalHarnessError` thrown from inside the pipeline worker,
 * which is the exact shape that used to take the whole run down.
 */
const controlExecutorTimesOut = (predicate: (cwd: string) => boolean = () => true) =>
  makeHarnessFakeSpawn({
    executorResultFor: (opts) =>
      opts.pluginDirs.length === 0 && predicate(opts.cwd) ? SPAWN_TIMED_OUT : undefined,
  });

describe('runSkillTestHarness — per-eval grader integrity nonce', () => {
  const { getTempDir, getAuthoredDir } = setupStubbedHarnessSubject('vat-nonce-', vi.mocked(stageHarness));

  it('accepts nonce-valid fragments and writes grading.json from the merge (PASS)', async () => {
    const result = await runHarness(getTempDir(), getAuthoredDir(), makeHarnessFakeSpawn().spawn);
    expect(result.summary).toBe('PASS 1/1');
    expect(result.exitCode).toBe(0);
    const gradingPath = safePath.join(getTempDir(), 'harness', 'results', GRADING_JSON);
    expect(existsSync(gradingPath)).toBe(true);
    expect(JSON.parse(readFileSync(gradingPath, 'utf8')).summary).toEqual({ passed: 1, total: 1 });
  });

  it('rejects a fragment whose nonce does not match this run (forged/left-behind)', async () => {
    const forging = makeHarnessFakeSpawn({ forgeNonce: true });
    await expect(runHarness(getTempDir(), getAuthoredDir(), forging.spawn)).rejects.toThrow(GradingNonceError);
  });
});

// End-to-end verdict → exit code (the fail-closed default). The fake grader emits
// a nonce-valid FAILING fragment, so the run reaches verdictExitCode only after
// every integrity gate has passed.
describe('runSkillTestHarness — eval verdict exit code (fail-closed default)', () => {
  const { getTempDir, getAuthoredDir } = setupStubbedHarnessSubject('vat-verdict-', vi.mocked(stageHarness));

  it('a completed run with a failing verdict exits EvalFailure (4) by DEFAULT', async () => {
    const result = await runHarness(getTempDir(), getAuthoredDir(), makeHarnessFakeSpawn({ graderPassed: false }).spawn);
    expect(result.summary).toBe('FAIL 0/1');
    expect(result.exitCode).toBe(4);
  });

  it('the --allow-eval-failure opt-out downgrades a failing verdict to Ok (0)', async () => {
    const failing = makeHarnessFakeSpawn({ graderPassed: false });
    const result = await runHarness(getTempDir(), getAuthoredDir(), failing.spawn, { tolerateEvalFailure: true });
    expect(result.summary).toBe('FAIL 0/1');
    expect(result.exitCode).toBe(0);
  });
});

/**
 * THE MEASURED DEFECT, pinned end to end.
 *
 * Two evals, `--baseline`, control-arm executor returns `timedOut`: the run THREW
 * `InternalHarnessError`, both treatment executors and both treatment graders had
 * already run and been billed, and `results/` held ONLY `provenance.json` — no
 * grading.json, no baseline.json, no tool-eval.json. The error text
 * (`Executor timed out for eval "e1"`) never even said which arm had died.
 *
 * A unit test cannot see this. Every component behaved exactly as documented; the
 * failure was that `runPipeline` propagates any non-RateLimitSignal throw, and the
 * arm that threw was the disposable one.
 */
describe('runSkillTestHarness — a CONTROL-arm failure must not destroy the run', () => {
  const { getTempDir, getAuthoredDir } = setupStubbedHarnessSubject('vat-ctl-fail-', vi.mocked(stageHarness));

  /** e2's control executor dies; e1's survives, so one arm-pair is intact and one is not. */
  const runWithDeadControlOnE2 = async () => {
    const tempDir = getTempDir();
    writeEvalSuite(getAuthoredDir(), [{ id: 'e1' }, { id: 'e2' }]);
    const result = await runHarness(
      tempDir,
      getAuthoredDir(),
      controlExecutorTimesOut((cwd) => cwd.endsWith('/e2')).spawn,
      { baseline: true },
    );
    return { tempDir, result };
  };

  it('completes the run instead of throwing', async () => {
    await expect(runWithDeadControlOnE2()).resolves.toBeDefined();
  });

  it('WRITES the treatment artifacts the operator already paid for', async () => {
    const { tempDir } = await runWithDeadControlOnE2();

    // The treatment arm ran both evals to a verdict; that is the whole product.
    expect(readResult(tempDir, GRADING_JSON)).toMatchObject({ summary: { passed: 2, total: 2 } });
    for (const name of OTHER_MERGED_ARTIFACTS) {
      expect(existsSync(safePath.join(tempDir, 'harness', 'results', name))).toBe(true);
    }
  });

  it('withholds the delta as null and says WHICH ARM broke and WHY', async () => {
    const { tempDir } = await runWithDeadControlOnE2();
    const { baselineIntegrity, baselineDelta } = readBaseline(tempDir);

    expect(baselineDelta.delta).toBeNull();
    expect(baselineDelta.controlArmFailures.map((f) => f.evalId)).toEqual(['e2']);
    // The arm is NAMED, and so is the cause — the pre-fix error said neither.
    expect(baselineIntegrity.controlArmFailures[0]?.detail).toContain('control arm (skill withheld)');
    expect(baselineIntegrity.controlArmFailures[0]?.detail).toContain('Executor timed out');
    expect(baselineIntegrity.summary).toContain('CONTROL ARM DID NOT RUN');
    expect(baselineIntegrity.comparable).toBe(false);
  });

  // The surviving eval was measured fine; withholding the RUN total is not a licence
  // to discard the per-eval numbers either side of the failure.
  it('keeps the eval whose control arm survived, with its own measured delta', async () => {
    const { tempDir } = await runWithDeadControlOnE2();
    const { baselineDelta } = readBaseline(tempDir);

    expect(baselineDelta.perEval).toEqual(
      expect.arrayContaining([expect.objectContaining({ evalId: 'e1', delta: 0 })]),
    );
    expect(baselineDelta.perEval).toEqual(
      expect.arrayContaining([expect.objectContaining({ evalId: 'e2', withoutTotal: 0, delta: null })]),
    );
  });

  /**
   * The GRADER half of the same synthesis, and the urgent one: the declared-count
   * assert is correct and must stay, but on the control arm it converted a grader
   * miscount from "delta withheld" into "whole run destroyed". Here the control
   * grader emits 3 entries for an eval that declares 1.
   */
  it('records a control-arm grader that miscounted, instead of failing the run', async () => {
    const tempDir = getTempDir();
    const miscounting = makeHarnessFakeSpawn({
      graderExpectationCount: (fragmentPath) => (fragmentPath.includes('/without/') ? 3 : 1),
    });
    const result = await runHarness(tempDir, getAuthoredDir(), miscounting.spawn, { baseline: true });

    expect(result.exitCode).toBe(0);
    expect(readResult(tempDir, GRADING_JSON)).toMatchObject({ summary: { passed: 1, total: 1 } });
    const { baselineIntegrity, baselineDelta } = readBaseline(tempDir);
    expect(baselineDelta.delta).toBeNull();
    expect(baselineIntegrity.controlArmFailures[0]?.detail).toContain('expectation entr');
  });

  /**
   * The all-dead case. With no WITHOUT-arm fragments at all, the artifact writer's
   * old `withoutArm.length > 0` gate wrote NO baseline.json — so the one run that
   * most needs to say "the control arm did not happen" said nothing, exactly like a
   * run where `--baseline` was never passed.
   */
  it('still writes baseline.json when EVERY control eval died', async () => {
    const tempDir = getTempDir();
    const result = await runHarness(tempDir, getAuthoredDir(), controlExecutorTimesOut().spawn, { baseline: true });

    expect(result.exitCode).toBe(0);
    const { summary, baselineIntegrity, baselineDelta } = readBaseline(tempDir);
    expect(summary).toEqual({ passed: 0, total: 0 });
    expect(baselineDelta.delta).toBeNull();
    expect(baselineIntegrity.controlArmFailures).toHaveLength(1);
  });

  /**
   * ...and it must not describe that run as CHECKED. With both control arms dead and
   * ZERO transcripts scanned, `baseline.json` said `"contaminated": false` with a full
   * `checked by: harness-path, sibling-arm, vat-private-dir, skill-content` — while
   * the shipped docs teach `signals` as exactly the discriminator between a clean
   * verdict and a blind one ("an empty list means nothing was looking"). The list was
   * full and nothing was looking.
   *
   * `signals` is a property of the paths this run ARMED, which is why it was computed
   * unconditionally — but the block it lands on is a claim about what was OBSERVED,
   * and with no transcript there is no observation to make a claim about.
   */
  it('claims NO armed detector when not one control transcript was scanned', async () => {
    const tempDir = getTempDir();
    await runHarness(tempDir, getAuthoredDir(), controlExecutorTimesOut().spawn, { baseline: true });

    const { baselineIntegrity } = readBaseline(tempDir);
    expect(baselineIntegrity.signals).toEqual([]);
    expect(baselineIntegrity.summary).toContain('NO detector was armed');
    expect(baselineIntegrity.summary).not.toContain('checked by:');
  });

  // The converse, so the assertion above is a discriminator rather than a constant:
  // a run whose control arm DID produce a transcript reports the detectors it ran.
  it('reports the armed detectors when a control transcript WAS scanned', async () => {
    const tempDir = getTempDir();
    await runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn, { baseline: true });

    const { baselineIntegrity } = readBaseline(tempDir);
    expect(baselineIntegrity.signals.length).toBeGreaterThan(0);
    expect(baselineIntegrity.summary).toContain('checked by:');
  });

  // The asymmetry, stated as a test: without a treatment result there is nothing to
  // salvage, so that failure still takes the run down.
  it('STILL hard-fails when the TREATMENT arm breaks, with the arm named', async () => {
    const treatmentDies = makeHarnessFakeSpawn({
      executorResultFor: (opts) => (opts.pluginDirs.length > 0 ? SPAWN_TIMED_OUT : undefined),
    });

    await expect(
      runHarness(getTempDir(), getAuthoredDir(), treatmentDies.spawn, { baseline: true }),
    ).rejects.toThrow(/treatment arm \(skill available\)/);
  });
});

/**
 * `baseline.json` must say how well it was able to look, and what its numbers cover.
 *
 * Both of these were fully built — schema'd, summarised, rendered, unit-tested — and
 * then never reached the artifact: `summarizeBaselineIntegrity`'s `degraded`
 * parameter was DEFAULTED to `[]` and the call site passed nothing, and `skipped` was
 * in scope at the artifact writer's call site and simply not passed. In both cases
 * the artifact read exactly like the healthy state.
 */
describe('runSkillTestHarness — baseline.json reports its own limits', () => {
  const { getTempDir, getAuthoredDir } = setupStubbedHarnessSubject('vat-bl-limits-', vi.mocked(stageHarness));

  /** A Bash `cd` into a variable the walker cannot evaluate — every later path is unanchored. */
  const UNTRACKABLE_CD = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd "$MYSTERY_DIR" && ls' } }],
    },
  });

  it('carries a DEGRADED contamination scan into baselineIntegrity, not just stderr', async () => {
    const tempDir = getTempDir();
    const degrading = makeHarnessFakeSpawn({
      // Control arm only — it is the only arm that is scanned at all.
      executorExtraStdout: (opts) => (opts.pluginDirs.length === 0 ? UNTRACKABLE_CD : undefined),
    });
    await runHarness(tempDir, getAuthoredDir(), degrading.spawn, { baseline: true });

    const { baselineIntegrity } = readBaseline(tempDir);
    expect(baselineIntegrity.degraded).toEqual([
      // The detail quotes the `cd` the walker gave up on — de-quoted, because it is
      // reported as the SHELL TOKEN the tokenizer produced, not as typed.
      { reason: 'cwd-untracked', detail: expect.stringContaining('cd $MYSTERY_DIR'), evalId: '1' },
    ]);
    // And the prose must not read like a clean scan — `contaminated: false` from a
    // blind scan is written with exactly the same bytes as one that looked.
    expect(baselineIntegrity.summary).toContain('DEGRADED SCAN');
    expect(baselineIntegrity.contaminated).toBe(false);
  });

  it('reports a clean structured scan as an EMPTY degraded list, so the two differ', async () => {
    const tempDir = getTempDir();
    await runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn, { baseline: true });

    const { baselineIntegrity } = readBaseline(tempDir);
    expect(baselineIntegrity.degraded).toEqual([]);
    expect(baselineIntegrity.summary).not.toContain('DEGRADED SCAN');
  });

  /**
   * A tier-0 failure truncates the suite for BOTH arms, so the arithmetic stays
   * sound — but the delta then covers only the tiers that ran, and neither the block
   * nor the printed line recorded that. `+0 (with skill: 0/1, without skill: 0/1)`
   * over one of three evals is indistinguishable from a complete one-eval suite.
   */
  it('records what fail-fast cut off, so a truncated delta cannot read as a complete one', async () => {
    const tempDir = getTempDir();
    writeEvalSuite(getAuthoredDir(), [{ id: 'cheap', tier: 0 }, { id: 'mid', tier: 1 }, { id: 'dear', tier: 2 }]);
    // The tier-0 TREATMENT eval fails, which is what the gate reads.
    const gating = makeHarnessFakeSpawn({ graderPassed: false });
    await runHarness(tempDir, getAuthoredDir(), gating.spawn, { baseline: true });

    const { baselineDelta } = readBaseline(tempDir);
    expect(baselineDelta.truncated).toEqual({
      gatedByTier: 0,
      firstSkippedTier: 1,
      totalSkipped: 2,
      evalIds: ['mid', 'dear'],
    });
    // Only the tier that ran is in the totals — that is the claim the field qualifies.
    expect(baselineDelta.perEval.map((e) => e.evalId)).toEqual(['cheap']);
  });

  it('reports `truncated: null` for a complete suite rather than omitting the field', async () => {
    const tempDir = getTempDir();
    await runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn, { baseline: true });

    expect(readBaseline(tempDir).baselineDelta.truncated).toBeNull();
  });
});

/**
 * The `--dry-run` spawn plan is the ONLY pre-spend number an operator ever sees, and
 * under `--baseline` it under-reported the run by exactly 2x — `buildDryRunSummary`
 * had no `baseline` field at all, so it printed the SUITE SIZE as the pair count.
 *
 * This is a WIRING test on purpose: `buildDryRunSummary` is pure and unit-tested
 * either way, so a unit test of it stays green while the orchestrator forgets to pass
 * `opts.baseline` — which is exactly the state the defect was found in. Mutating the
 * call site to `baseline: false` fails ZERO unit tests without this.
 */
describe('runSkillTestHarness — the --dry-run spawn plan', () => {
  const { getTempDir, getAuthoredDir } = setupStubbedHarnessSubject('vat-dryrun-', vi.mocked(stageHarness));

  it.each([
    ['doubles the plan under --baseline', true, '6 executor→grader spawn pairs', '12 claude sessions'],
    ['leaves a plain run at one pair per eval', false, '3 executor→grader spawn pairs', '6 claude sessions'],
  ])('%s', async (_label, baseline, pairsNeedle, sessionsNeedle) => {
    writeEvalSuite(getAuthoredDir(), [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
    const { summary } = await runHarness(getTempDir(), getAuthoredDir(), makeHarnessFakeSpawn().spawn, {
      dryRun: true,
      baseline,
    });

    expect(summary).toContain(pairsNeedle);
    expect(summary).toContain(sessionsNeedle);
  });
});

/**
 * "WHAT WOULD THIS COST NEXT TIME?" DESTROYED THE RUN YOU WERE ABOUT TO READ.
 *
 * `wipeStaleArtifacts` ran at Step 7 — BEFORE the dry-run short-circuit at Step 8,
 * and before every remaining pre-pipeline failure point. The harness root is a
 * deterministic function of the subject, so a real `--baseline` run left
 * `[baseline, friction, grading, provenance, tool-eval].json` and a subsequent
 * `--dry-run` against the same subject left `[provenance.json]` — the one file the
 * dry run itself rewrote.
 *
 * A dry run must touch NOTHING under `results/`: it neither wipes, nor writes
 * provenance, nor creates the directory.
 */
describe('runSkillTestHarness — a --dry-run must not touch results/', () => {
  const { getTempDir, getAuthoredDir } = setupStubbedHarnessSubject('vat-dryrun-safe-', vi.mocked(stageHarness));

  const REAL_RUN_ARTIFACTS = [BASELINE_JSON, 'friction.json', GRADING_JSON, 'provenance.json', 'tool-eval.json'];

  it('leaves every artifact of the previous run byte-identical', async () => {
    const tempDir = getTempDir();
    await runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn, { baseline: true });
    const before = snapshotResults(tempDir);
    expect(Object.keys(before)).toEqual(REAL_RUN_ARTIFACTS);

    await runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn, { dryRun: true });

    expect(snapshotResults(tempDir)).toEqual(before);
  });

  /**
   * The same wipe also ran ahead of Step 7.5, where declared-env token resolution
   * hard-fails — so a dry run that ERRORED took the prior run's grading.json and
   * baseline.json with it on the way out.
   */
  it('leaves them intact even when the dry run itself fails before spawning', async () => {
    const tempDir = getTempDir();
    await runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn, { baseline: true });
    const before = snapshotResults(tempDir);

    await expect(
      runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn, {
        dryRun: true,
        env: { FOO: '${bogusToken}' },
      }),
    ).rejects.toThrow();

    expect(snapshotResults(tempDir)).toEqual(before);
  });

  it('creates no results/ directory at all when none existed', async () => {
    const tempDir = getTempDir();
    await runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn, { dryRun: true });

    expect(existsSync(safePath.join(tempDir, 'harness', 'results'))).toBe(false);
  });

  // ...and the preview says WOULD, since it no longer writes the file it names.
  it('describes provenance as something a real run would write', async () => {
    const { summary } = await runHarness(getTempDir(), getAuthoredDir(), makeHarnessFakeSpawn().spawn, {
      dryRun: true,
    });
    expect(summary).toMatch(/Provenance would be written to: .*provenance\.json/);
  });

  // A REAL run still wipes — the cross-run leak that motivated the wipe is untouched
  // by moving it past the short-circuit.
  it('still wipes a prior run\'s artifacts on a REAL run', async () => {
    const tempDir = getTempDir();
    await runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn, { baseline: true });
    // A baseline.json a NON-baseline re-run must not leave lying around.
    expect(snapshotResults(tempDir)[BASELINE_JSON]).toBeDefined();

    await runHarness(tempDir, getAuthoredDir(), makeHarnessFakeSpawn().spawn);

    expect(snapshotResults(tempDir)[BASELINE_JSON]).toBeUndefined();
  });
});

/**
 * A CONTROL-ARM RATE LIMIT THAT OUTLIVES THE RETRY BUDGET STILL ANNIHILATED THE RUN.
 *
 * `runEvalWorker` rethrows a `RateLimitSignal` on BOTH arms — correctly, it is the
 * pipeline's retry protocol, and swallowing it would make one transient 429 a
 * permanently dead control arm. But the signal carried no exhausted-vs-retryable
 * discriminator, and `pipeline.ts` rethrows the IDENTICAL class once the budget is
 * spent: after five retries the run threw, both treatment executors and both
 * treatment graders having already run and been billed, and `results/` held
 * `provenance.json` and nothing else — verbatim the failure `runEvalWorker`'s own
 * docblock quotes as the thing it was written to eliminate.
 *
 * `--baseline` doubles the spawn count, so it is the run most likely to hit one.
 */
/** A rate-limit event plus a cut-off (non-zero) status — together, what makes the executor signal. */
const RATE_LIMIT_LINE = JSON.stringify({ type: 'rate_limit_event' });
const CUT_OFF = { status: 1, timedOut: false, stalled: false };

/**
 * A spawn stub that rate-limits ONE arm on every attempt, plus a count of how many
 * times that arm was actually spawned — which is what distinguishes "retried the
 * budget, then recorded it" from "swallowed the first 429".
 *
 * `pluginDirs.length === 0` is how a test picks the control arm; see the spawn stub.
 */
function alwaysRateLimits(isTargetArm: (pluginDirCount: number) => boolean): {
  stub: ReturnType<typeof makeHarnessFakeSpawn>;
  targetSpawns: () => number;
} {
  const executorSpawns: number[] = [];
  const stub = makeHarnessFakeSpawn({
    onExecutorSpawn: (o) => executorSpawns.push(o.pluginDirs.length),
    executorExtraStdout: (o) => (isTargetArm(o.pluginDirs.length) ? RATE_LIMIT_LINE : undefined),
    executorResultFor: (o) => (isTargetArm(o.pluginDirs.length) ? CUT_OFF : undefined),
  });
  return { stub, targetSpawns: () => executorSpawns.filter((n) => isTargetArm(n)).length };
}

const CONTROL_ARM = (pluginDirCount: number): boolean => pluginDirCount === 0;

describe('runSkillTestHarness — an EXHAUSTED control-arm rate limit', () => {
  const { getTempDir, getAuthoredDir } = setupStubbedHarnessSubject('vat-ratelimit-', vi.mocked(stageHarness));

  it('completes the run and writes the treatment artifacts the operator already paid for', async () => {
    const tempDir = getTempDir();
    const { stub } = alwaysRateLimits(CONTROL_ARM);

    const result = await runHarness(tempDir, getAuthoredDir(), stub.spawn, {
      baseline: true,
      fastRateLimitRetries: true,
    });

    expect(result.exitCode).toBe(0);
    expect(readResult(tempDir, GRADING_JSON)).toMatchObject({ summary: { passed: 1, total: 1 } });
    for (const name of OTHER_MERGED_ARTIFACTS) {
      expect(existsSync(safePath.join(tempDir, 'harness', 'results', name))).toBe(true);
    }
  });

  it('records it as a control-arm failure that names the arm and the cause', async () => {
    const tempDir = getTempDir();
    const { stub } = alwaysRateLimits(CONTROL_ARM);
    await runHarness(tempDir, getAuthoredDir(), stub.spawn, { baseline: true, fastRateLimitRetries: true });

    const { baselineIntegrity, baselineDelta } = readBaseline(tempDir);
    expect(baselineDelta.delta).toBeNull();
    expect(baselineDelta.controlArmFailures.map((f) => f.evalId)).toEqual(['1']);
    expect(baselineIntegrity.controlArmFailures[0]?.detail).toContain('control arm (skill withheld)');
    expect(baselineIntegrity.controlArmFailures[0]?.detail).toContain('rate-limited');
  });

  /**
   * The RETRYABLE half, which must not regress. Removing `runEvalWorker`'s
   * `RateLimitSignal` rethrow entirely failed ZERO tests — no test constructed a
   * control-arm rate limit at all — and swallowing it on the first 429 turns every
   * transient limit into a permanently dead control arm. Six spawns = the first
   * attempt plus the five the pipeline is budgeted for.
   */
  it('spends the whole retry budget on the control arm before giving up', async () => {
    const { stub, targetSpawns } = alwaysRateLimits(CONTROL_ARM);
    await runHarness(getTempDir(), getAuthoredDir(), stub.spawn, { baseline: true, fastRateLimitRetries: true });

    expect(targetSpawns()).toBe(6);
  });

  // The asymmetry holds here too: with no treatment result there is nothing to save.
  it('STILL hard-fails when the TREATMENT arm exhausts its retries, with the arm named', async () => {
    const { stub } = alwaysRateLimits((n) => n > 0);

    await expect(
      runHarness(getTempDir(), getAuthoredDir(), stub.spawn, { baseline: true, fastRateLimitRetries: true }),
    ).rejects.toThrow(/treatment arm \(skill available\)/);
  });
});

/**
 * THE RUN NONCE IS DOCUMENTED IN FOUR PLACES AS NEVER TOUCHING DISK.
 *
 * `spawn-claude.ts` ("keeps it off disk precisely so untrusted skill code cannot read
 * it back and forge a passing grading.json"), `prompt-invariants.ts` ("delivered only
 * via stdin, never written to disk"), `eval-grader.ts` (a whole docblock justifying
 * unlinking the fragment because "a fragment left on disk lets skill code … read the
 * echoed nonce at leisure"), and `run-harness.ts` ("travels only via grader stdin").
 * The merge carried it into the report and the harness wrote that report verbatim.
 */
describe('runSkillTestHarness — the run nonce reaches no artifact', () => {
  const { getTempDir, getAuthoredDir } = setupStubbedHarnessSubject('vat-nonce-disk-', vi.mocked(stageHarness));

  it('writes no runNonce into any results/ file', async () => {
    const tempDir = getTempDir();
    const stub = makeHarnessFakeSpawn();
    await runHarness(tempDir, getAuthoredDir(), stub.spawn, { baseline: true });

    // The nonce the graders were actually handed, so this cannot pass by looking for
    // a value the run never minted.
    const nonce = stub.graderNonces[0];
    expect(nonce, 'no grader was prompted, so the assertion below proves nothing').toBeTruthy();

    for (const [name, body] of Object.entries(snapshotResults(tempDir))) {
      expect(body, `${name} carries the run's integrity nonce`).not.toContain(nonce);
      expect(body, `${name} carries a runNonce field`).not.toContain('runNonce');
    }
  });
});
