/* eslint-disable @typescript-eslint/no-explicit-any -- test stubs use loose casts for partial mock results */
/* eslint-disable security/detect-non-literal-fs-filename -- test paths derived from our own temp harness dirs */
/**
 * Full-wiring test for the Harness-B grading integrity nonce.
 *
 * The invariant under test: runSkillTestHarness stamps a secret per-run nonce
 * into the experimenter prompt (delivered ONLY via the in-memory spawn `prompt`,
 * never to disk) and REQUIRES grading.json to echo it before trusting the verdict.
 * A grading.json that omits or mismatches the nonce — the signature of a forged /
 * left-behind grading written by untrusted skill code in the shared sandbox — is
 * rejected with a GradingNonceError (exit 1).
 *
 * Mirrors run-harness-ack-gate.test.ts: preflight and staging are stubbed so the
 * orchestrator reaches the real spawn/grade path with no `claude` install; the
 * spawn is replaced with a spy that plays the role of the experimenter — reading
 * the nonce off the prompt it is handed and writing a grading.json accordingly.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { safePath, spawnHeadlessClaude } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REDACTED_NONCE_PLACEHOLDER } from '../../src/skill-test/experimenter-prompt.js';
import { GradingNonceError } from '../../src/skill-test/grading-adapter.js';
import { runSkillTestHarness } from '../../src/skill-test/run-harness.js';
import { stageHarness } from '../../src/skill-test/staging.js';
import { setupStubbedHarnessSubject } from '../test-helpers.js';

vi.mock('../../src/skill-test/preflight.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // resolvedAuth must be non-null here (unlike the ack-gate test): this run is
    // acknowledged, so it proceeds past the env-assembly step which refuses a null.
    runPreflight: vi.fn(() => ({ passed: true, checks: [], resolvedAuth: { forwardedEnv: {} } })),
  };
});

vi.mock('../../src/skill-test/staging.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, stageHarness: vi.fn() };
});

vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, spawnHeadlessClaude: vi.fn() };
});

const NONCE_RE = /EXACTLY:\s*([a-f0-9]{32})/;

/** Extract the 32-hex per-run nonce the harness stamped into the prompt. */
function nonceFromPrompt(prompt: string): string {
  const m = NONCE_RE.exec(prompt);
  if (m?.[1] === undefined) throw new Error('no nonce found in spawn prompt');
  return m[1];
}

type NonceMode = 'echo' | 'omit' | 'wrong';

/** The runNonce the spy experimenter writes for a given mode (undefined → omit the field). */
function nonceForMode(mode: NonceMode, realNonce: string): string | undefined {
  if (mode === 'echo') return realNonce;
  if (mode === 'wrong') return 'f'.repeat(32);
  return undefined;
}

/**
 * Install a spy experimenter that writes the grading.json produced by `makeGrading`
 * (handed the real per-run nonce) into the harness results dir, then exits clean.
 * Shared by the nonce-integrity and verdict-exit-code stubs below.
 */
function stubSpawn(makeGrading: (nonce: string) => unknown): void {
  vi.mocked(spawnHeadlessClaude).mockImplementation(async (opts: any) => {
    const gradingPath = safePath.join(String(opts.cwd), 'results', 'grading.json');
    writeFileSync(gradingPath, JSON.stringify(makeGrading(nonceFromPrompt(String(opts.prompt)))) + '\n', 'utf8');
    return { status: 0, timedOut: false, stalled: false };
  });
}

/**
 * Make the spy experimenter write an all-pass grading.json. `nonceMode` controls
 * the integrity field: echo the real nonce, omit it, or write a wrong one.
 */
function stubExperimenter(nonceMode: NonceMode): void {
  stubSpawn((realNonce) => {
    const runNonce = nonceForMode(nonceMode, realNonce);
    return {
      expectations: [{ text: 'e', passed: true }],
      summary: { passed: 1, total: 1 },
      ...(runNonce === undefined ? {} : { runNonce }),
    };
  });
}

/** Make the spy experimenter write a FAILING (nonce-valid) grading: 1 of 2 passed. */
function stubFailingExperimenter(): void {
  stubSpawn((runNonce) => ({
    expectations: [{ text: 'a', passed: true }, { text: 'b', passed: false }],
    summary: { passed: 1, total: 2 },
    runNonce,
  }));
}

/** Run the acknowledged harness against a fixed harness output dir under `tempDir`. */
async function runHarness(
  tempDir: string,
  subjectStagedDir: string,
  extra?: { tolerateEvalFailure?: boolean },
): ReturnType<typeof runSkillTestHarness> {
  return runSkillTestHarness({
    skills: ['my-skill'],
    repoRoot: tempDir,
    out: safePath.join(tempDir, 'harness'),
    subjectSource: { path: subjectStagedDir },
    acknowledgedRunsSkillCode: true,
    ...(extra?.tolerateEvalFailure === undefined ? {} : { tolerateEvalFailure: extra.tolerateEvalFailure }),
  });
}

describe('runSkillTestHarness — grading integrity nonce (Harness B)', () => {
  const { getTempDir, getSubjectStagedDir } = setupStubbedHarnessSubject('vat-nonce-', vi.mocked(stageHarness));

  beforeEach(() => {
    vi.mocked(spawnHeadlessClaude).mockReset();
  });

  it('accepts a grading.json that echoes the run nonce (PASS)', async () => {
    stubExperimenter('echo');
    const result = await runHarness(getTempDir(), getSubjectStagedDir());
    expect(result.summary).toBe('PASS 1/1');
    expect(result.exitCode).toBe(0);
  });

  it('rejects a grading.json missing the run nonce (forged/left-behind)', async () => {
    stubExperimenter('omit');
    await expect(runHarness(getTempDir(), getSubjectStagedDir())).rejects.toThrow(GradingNonceError);
  });

  it('rejects a grading.json whose nonce does not match this run', async () => {
    stubExperimenter('wrong');
    await expect(runHarness(getTempDir(), getSubjectStagedDir())).rejects.toThrow(GradingNonceError);
  });

  it('never writes the raw nonce to the on-disk experimenter-prompt.txt (redacted)', async () => {
    stubExperimenter('echo');
    await runHarness(getTempDir(), getSubjectStagedDir());
    const promptPath = safePath.join(getTempDir(), 'harness', 'results', 'experimenter-prompt.txt');
    expect(existsSync(promptPath)).toBe(true);
    const persisted = readFileSync(promptPath, 'utf8');
    const realNonce = nonceFromPrompt(String(vi.mocked(spawnHeadlessClaude).mock.calls[0]?.[0]?.prompt));
    expect(persisted).not.toContain(realNonce);
    expect(persisted).toContain(REDACTED_NONCE_PLACEHOLDER);
  });
});

// End-to-end verdict → exit code (the fail-closed default of B). Reuses the same
// full-wiring stub, but the experimenter writes a nonce-valid FAILING grade — so the
// run reaches verdictExitCode only after every integrity gate has passed.
describe('runSkillTestHarness — eval verdict exit code (fail-closed default)', () => {
  const { getTempDir, getSubjectStagedDir } = setupStubbedHarnessSubject('vat-verdict-', vi.mocked(stageHarness));

  beforeEach(() => {
    vi.mocked(spawnHeadlessClaude).mockReset();
  });

  it('a completed run with a failing verdict exits EvalFailure (4) by DEFAULT (fail-closed)', async () => {
    stubFailingExperimenter();
    const result = await runHarness(getTempDir(), getSubjectStagedDir());
    expect(result.summary).toBe('FAIL 1/2');
    expect(result.exitCode).toBe(4); // SkillTestExitCode.EvalFailure
  });

  it('the tolerate-eval-failure opt-out downgrades a failing verdict to Ok (0)', async () => {
    stubFailingExperimenter();
    const result = await runHarness(getTempDir(), getSubjectStagedDir(), { tolerateEvalFailure: true });
    expect(result.summary).toBe('FAIL 1/2');
    expect(result.exitCode).toBe(0); // SkillTestExitCode.Ok
  });
});
