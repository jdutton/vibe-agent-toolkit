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
 * Make the spy experimenter write grading.json into the harness results dir.
 * `nonceMode` controls the integrity field: echo the real nonce, omit it, or
 * write a wrong one.
 */
function stubExperimenter(nonceMode: NonceMode): void {
  vi.mocked(spawnHeadlessClaude).mockImplementation(async (opts: any) => {
    const runNonce = nonceForMode(nonceMode, nonceFromPrompt(String(opts.prompt)));
    const grading = {
      expectations: [{ text: 'e', passed: true }],
      summary: { passed: 1, total: 1 },
      ...(runNonce === undefined ? {} : { runNonce }),
    };
    const gradingPath = safePath.join(String(opts.cwd), 'results', 'grading.json');
    writeFileSync(gradingPath, JSON.stringify(grading) + '\n', 'utf8');
    return { status: 0, timedOut: false, stalled: false };
  });
}

/** Run the acknowledged harness against a fixed harness output dir under `tempDir`. */
async function runHarness(tempDir: string, subjectStagedDir: string): ReturnType<typeof runSkillTestHarness> {
  return runSkillTestHarness({
    skills: ['my-skill'],
    repoRoot: tempDir,
    out: safePath.join(tempDir, 'harness'),
    subjectSource: { path: subjectStagedDir },
    acknowledgedRunsSkillCode: true,
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
