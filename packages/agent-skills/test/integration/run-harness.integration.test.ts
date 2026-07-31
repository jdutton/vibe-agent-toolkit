/* eslint-disable security/detect-non-literal-fs-filename -- test paths are our own controlled temp dirs */
/**
 * Integration test for the FULL `runSkillTestHarness` executor→grader pipeline
 * (issue #145 Task 9). A trivial fixture skill (2 evals) is staged into a REAL
 * temp harness; the per-eval executor and grader spawns are driven by an INJECTED
 * fake `claude` (opts.spawn) so no real install is needed. Preflight is stubbed to
 * pass (there is no `claude` binary in CI); staging runs for real.
 *
 * Asserts the load-bearing Task-9 invariants end to end:
 *  - VAT (not the model) writes grading.json + friction.json to results/;
 *  - the vat-only grader dir is OUTSIDE the skill's harness sandbox (forgery-proof);
 *  - all-pass → exit 0; an executor CLEAN failure + failing fragment → exit 4;
 *  - a forged grader-fragment nonce → exit 1 (never laundered into a verdict).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mapErrorToExitCode } from '../../src/skill-test/exit-codes.js';
import { runSkillTestHarness, type RunHarnessOptions } from '../../src/skill-test/run-harness.js';
import { isUnderRoot, makeHarnessFakeSpawn } from '../skill-test/spawn-stub.js';

// Force preflight to PASS without a real `claude`. Key order (resolvedAuth first) and the
// populated `checks` entry keep this factory structurally distinct from the sibling harness
// tests' preflight stubs, so the shared vi.mock boilerplate does not clone (duplication gate).
vi.mock('../../src/skill-test/preflight.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const runPreflight = vi.fn(() => ({
    resolvedAuth: { forwardedEnv: {} },
    checks: [{ name: 'stub', passed: true, message: 'preflight stubbed for integration' }],
    passed: true,
  }));
  return { ...actual, runPreflight };
});

const FIXTURE_SKILL = 'fixture-skill';
const GRADING_JSON = 'grading.json';
const SKILL_MD = '---\nname: fixture-skill\ndescription: A trivial fixture skill for the harness integration test.\n---\n\n# Fixture\n';

let tempDir: string;

/** Create the fixture skill dir (SKILL.md + a 2-eval evals.json) and return its path. */
function writeFixtureSkill(): string {
  return writeFixtureSkillWithEvals([
    { id: 'alpha', prompt: 'do alpha', expectations: ['alpha works'] },
    { id: 'beta', prompt: 'do beta', expectations: ['beta works'] },
  ]);
}

/** Create the fixture skill dir with a caller-supplied eval list; return its path. */
function writeFixtureSkillWithEvals(evals: unknown[]): string {
  const skillDir = safePath.join(tempDir, FIXTURE_SKILL);
  mkdirSyncReal(safePath.join(skillDir, 'evals'), { recursive: true });
  writeFileSync(safePath.join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
  writeFileSync(
    safePath.join(skillDir, 'evals', 'evals.json'),
    JSON.stringify({ skill_name: FIXTURE_SKILL, evals }) + '\n',
    'utf8',
  );
  return skillDir;
}

/** Base harness options: real staging of the fixture skill into a real `out` dir. */
function harnessOpts(skillDir: string, spawn: RunHarnessOptions['spawn']): RunHarnessOptions {
  return {
    subject: FIXTURE_SKILL,
    repoRoot: tempDir,
    out: safePath.join(tempDir, 'harness'),
    subjectSource: { path: skillDir },
    subjectScaffoldDir: skillDir,
    acknowledgedRunsSkillCode: true,
    allowUnverifiedSkillSource: true,
    ...(spawn === undefined ? {} : { spawn }),
  };
}

/** Run the harness, mapping a thrown harness error to its exit code (mirrors run.ts). */
async function runToExit(opts: RunHarnessOptions): Promise<{ exitCode: number; summary: string }> {
  try {
    const result = await runSkillTestHarness(opts);
    return { exitCode: result.exitCode, summary: result.summary };
  } catch (err) {
    return { exitCode: mapErrorToExitCode(err), summary: err instanceof Error ? err.message : String(err) };
  }
}

describe('runSkillTestHarness — executor→grader pipeline (integration)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-harness-int-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('all-pass: VAT writes grading.json + friction.json and the grader dir is OUTSIDE the harness root', async () => {
    const skillDir = writeFixtureSkill();
    const fake = makeHarnessFakeSpawn();
    const result = await runToExit(harnessOpts(skillDir, fake.spawn));

    expect(result.summary).toBe('PASS 2/2');
    expect(result.exitCode).toBe(0);

    const resultsDir = safePath.join(tempDir, 'harness', 'results');
    expect(existsSync(safePath.join(resultsDir, GRADING_JSON))).toBe(true);
    expect(existsSync(safePath.join(resultsDir, 'friction.json'))).toBe(true);
    const grading = JSON.parse(readFileSync(safePath.join(resultsDir, GRADING_JSON), 'utf8'));
    expect(grading.summary).toEqual({ passed: 2, total: 2 });

    // Security invariant: every grader spawn ran OUTSIDE the skill's harness sandbox.
    const harnessRoot = safePath.join(tempDir, 'harness');
    expect(fake.graderSandboxDirs.length).toBe(2);
    for (const dir of fake.graderSandboxDirs) {
      expect(isUnderRoot(dir, harnessRoot)).toBe(false);
    }
  });

  it('the vat-only grader dir name does NOT encode the integrity nonce (nonce stays stdin-only)', async () => {
    // Finding-#1 regression: the grader dir lives in the world-listable OS temp dir and its name
    // reaches the grader's --add-dir argv, so same-user skill code could `ls <tmp>` / read `ps`.
    // The dir MUST be named by an independent random token, never the integrity nonce — otherwise a
    // skill could harvest the nonce and forge a valid-nonce passing fragment.
    const skillDir = writeFixtureSkill();
    const fake = makeHarnessFakeSpawn();
    const result = await runToExit(harnessOpts(skillDir, fake.spawn));

    expect(result.exitCode).toBe(0);
    expect(fake.graderNonces.length).toBe(2);
    expect(fake.graderSandboxDirs.length).toBe(2);
    for (const nonce of fake.graderNonces) {
      expect(nonce).not.toBe(''); // the nonce really was delivered (via the prompt / stdin)
      for (const dir of fake.graderSandboxDirs) {
        expect(dir).not.toContain(nonce);
      }
    }
  });

  it('an executor CLEAN failure + failing fragment exits EvalFailure (4), never exit 1', async () => {
    const skillDir = writeFixtureSkill();
    const fake = makeHarnessFakeSpawn({ executorStatus: 1, graderPassed: false });
    const result = await runToExit(harnessOpts(skillDir, fake.spawn));
    expect(result.summary).toBe('FAIL 0/2');
    expect(result.exitCode).toBe(4);
  });

  it('composite verdict FAILs (exit 4) when output passes but a tool verdict fails, and VAT writes tool-eval.json', async () => {
    // One eval declaring toolExpectations. The fake grader passes the output
    // expectation but emits a FAILING tool verdict → output all-green but the
    // COMPOSITE verdict FAILs → exit 4, with the verdict living in tool-eval.json.
    const skillDir = writeFixtureSkillWithEvals([
      { id: 'gamma', prompt: 'do gamma', expectations: ['gamma works'], toolExpectations: { mustRun: ['csvsum'] } },
    ]);
    const fake = makeHarnessFakeSpawn({ graderPassed: true, graderToolPassed: false });
    const result = await runToExit(harnessOpts(skillDir, fake.spawn));

    // Output counts read all-green (1/1) but the tool suffix explains the composite FAIL.
    expect(result.summary).toBe('FAIL 1/1 (1 tool)');
    expect(result.exitCode).toBe(4);

    const resultsDir = safePath.join(tempDir, 'harness', 'results');
    const toolEvalPath = safePath.join(resultsDir, 'tool-eval.json');
    expect(existsSync(toolEvalPath)).toBe(true);
    const toolEval = JSON.parse(readFileSync(toolEvalPath, 'utf8'));
    expect(toolEval.evals).toHaveLength(1);
    expect(toolEval.evals[0]).toMatchObject({ evalId: 'gamma', passed: false });
    // Channel separation (C2): the tool verdict must NOT leak into grading.json.
    const grading = JSON.parse(readFileSync(safePath.join(resultsDir, GRADING_JSON), 'utf8'));
    expect(grading.summary).toEqual({ passed: 1, total: 1 });
    expect(JSON.stringify(grading)).not.toContain('mustRun');
  });

  it('tier-0 FAILURE gates tier 1: tier-1 evals are SKIPPED (not passed), exit 4, summary names the skipped tier', async () => {
    // Two tiers: a cheap foundational eval (tier 0) that FAILS, and an expensive
    // eval (tier 1) that WOULD pass. The gate must stop the run after tier 0 so
    // tier 1 never grades — its eval is SKIPPED (a distinct state, never passed).
    const skillDir = writeFixtureSkillWithEvals([
      { id: 'foundational', tier: 0, prompt: 'do foundational', expectations: ['foundational works'] },
      { id: 'expensive', tier: 1, prompt: 'do expensive', expectations: ['expensive works'] },
    ]);
    const fake = makeHarnessFakeSpawn({ graderPassedFor: (id) => (id === 'foundational' ? false : true) });
    const result = await runToExit(harnessOpts(skillDir, fake.spawn));

    // Fail-fast run = eval FAILURE → exit 4, and the summary names the skipped tier.
    expect(result.exitCode).toBe(4);
    expect(result.summary).toContain('FAIL');
    expect(result.summary).toContain('SKIPPED (fail-fast): tier 1 and above (1 eval) — gated by tier 0 failure');

    // Only tier 0 was graded — the tier-1 eval was SKIPPED, never counted as passed.
    const resultsDir = safePath.join(tempDir, 'harness', 'results');
    const grading = JSON.parse(readFileSync(safePath.join(resultsDir, GRADING_JSON), 'utf8'));
    expect(grading.summary).toEqual({ passed: 0, total: 1 });
    // Only 1 grader spawn ran (tier 0); the gate stopped tier 1 before launching it.
    expect(fake.graderSandboxDirs.length).toBe(1);
  });

  it('tier-0 all-pass: tier 1 runs and both tiers are graded (no skips, exit 0)', async () => {
    const skillDir = writeFixtureSkillWithEvals([
      { id: 'foundational', tier: 0, prompt: 'do foundational', expectations: ['foundational works'] },
      { id: 'expensive', tier: 1, prompt: 'do expensive', expectations: ['expensive works'] },
    ]);
    const fake = makeHarnessFakeSpawn();
    const result = await runToExit(harnessOpts(skillDir, fake.spawn));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe('PASS 2/2');
    expect(result.summary).not.toContain('SKIPPED');

    // Both tiers graded — the gate did not fire, so tier 1 ran too.
    const resultsDir = safePath.join(tempDir, 'harness', 'results');
    const grading = JSON.parse(readFileSync(safePath.join(resultsDir, GRADING_JSON), 'utf8'));
    expect(grading.summary).toEqual({ passed: 2, total: 2 });
    expect(fake.graderSandboxDirs.length).toBe(2);
  });

  it('a forged grader-fragment nonce is rejected (exit 1) and a PRIOR run\'s stale friction.json is wiped first', async () => {
    const skillDir = writeFixtureSkill();
    // Simulate a reused/interrupted harness: pre-seed a stale friction.json under
    // results/ (as a prior run — or a crash before cleanup — would leave behind).
    const resultsDir = safePath.join(tempDir, 'harness', 'results');
    mkdirSyncReal(resultsDir, { recursive: true });
    const frictionPath = safePath.join(resultsDir, 'friction.json');
    writeFileSync(
      frictionPath,
      JSON.stringify({ items: [{ severity: 'high', category: 'path-assumption', message: 'STALE from a prior run' }] }),
      'utf8',
    );

    // A forged nonce throws in the grader (pre-merge), so this run never writes its
    // own friction.json. The pre-pipeline wipe must still have removed the stale one
    // so the finally cannot echo a prior run's friction as if it were this run's.
    const fake = makeHarnessFakeSpawn({ forgeNonce: true });
    const result = await runToExit(harnessOpts(skillDir, fake.spawn));
    expect(result.exitCode).toBe(1);
    expect(existsSync(frictionPath)).toBe(false);
  });
});
