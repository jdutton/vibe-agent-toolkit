/* eslint-disable security/detect-non-literal-fs-filename -- test paths derived from our own temp harness dirs */
/**
 * Full-wiring test for the per-eval grader integrity nonce (issue #145).
 *
 * runSkillTestHarness stamps ONE secret per-run nonce into every grader prompt
 * (delivered only via the in-memory spawn `prompt`, never to disk) and REQUIRES
 * each merged grader fragment to echo it. A fragment whose nonce is wrong/absent
 * — the signature of a forged / left-behind fragment written by untrusted skill
 * code in the shared sandbox — is rejected with a GradingNonceError (exit 1).
 *
 * The executor→grader pipeline is driven with an INJECTED fake spawn (opts.spawn),
 * so no real `claude` is needed; preflight + staging are stubbed so the
 * orchestrator reaches the real pipeline/merge/verdict path.
 */

import { existsSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { GradingNonceError } from '../../src/skill-test/grading-adapter.js';
import { runSkillTestHarness } from '../../src/skill-test/run-harness.js';
import { stageHarness } from '../../src/skill-test/staging.js';
import { setupStubbedHarnessSubject } from '../test-helpers.js';

import { makeHarnessFakeSpawn } from './spawn-stub.js';

vi.mock('../../src/skill-test/preflight.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // resolvedAuth must be non-null: this run is acknowledged, so it proceeds
    // past env-assembly (which refuses a null) into the pipeline.
    runPreflight: vi.fn(() => ({ passed: true, checks: [], resolvedAuth: { forwardedEnv: {} } })),
  };
});

vi.mock('../../src/skill-test/staging.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, stageHarness: vi.fn() };
});

type FakeSpawn = ReturnType<typeof makeHarnessFakeSpawn>['spawn'];

/** Run the acknowledged harness against a fixed harness output dir under `tempDir`. */
function runHarness(
  tempDir: string,
  subjectStagedDir: string,
  spawn: FakeSpawn,
  extra?: { tolerateEvalFailure?: boolean },
): ReturnType<typeof runSkillTestHarness> {
  return runSkillTestHarness({
    subject: 'my-skill',
    repoRoot: tempDir,
    out: safePath.join(tempDir, 'harness'),
    subjectSource: { path: subjectStagedDir },
    acknowledgedRunsSkillCode: true,
    spawn,
    ...(extra?.tolerateEvalFailure === undefined ? {} : { tolerateEvalFailure: extra.tolerateEvalFailure }),
  });
}

describe('runSkillTestHarness — per-eval grader integrity nonce', () => {
  const { getTempDir, getSubjectStagedDir } = setupStubbedHarnessSubject('vat-nonce-', vi.mocked(stageHarness));

  it('accepts nonce-valid fragments and writes grading.json from the merge (PASS)', async () => {
    const result = await runHarness(getTempDir(), getSubjectStagedDir(), makeHarnessFakeSpawn().spawn);
    expect(result.summary).toBe('PASS 1/1');
    expect(result.exitCode).toBe(0);
    const gradingPath = safePath.join(getTempDir(), 'harness', 'results', 'grading.json');
    expect(existsSync(gradingPath)).toBe(true);
    expect(JSON.parse(readFileSync(gradingPath, 'utf8')).summary).toEqual({ passed: 1, total: 1 });
  });

  it('rejects a fragment whose nonce does not match this run (forged/left-behind)', async () => {
    const forging = makeHarnessFakeSpawn({ forgeNonce: true });
    await expect(runHarness(getTempDir(), getSubjectStagedDir(), forging.spawn)).rejects.toThrow(GradingNonceError);
  });
});

// End-to-end verdict → exit code (the fail-closed default). The fake grader emits
// a nonce-valid FAILING fragment, so the run reaches verdictExitCode only after
// every integrity gate has passed.
describe('runSkillTestHarness — eval verdict exit code (fail-closed default)', () => {
  const { getTempDir, getSubjectStagedDir } = setupStubbedHarnessSubject('vat-verdict-', vi.mocked(stageHarness));

  it('a completed run with a failing verdict exits EvalFailure (4) by DEFAULT', async () => {
    const result = await runHarness(getTempDir(), getSubjectStagedDir(), makeHarnessFakeSpawn({ graderPassed: false }).spawn);
    expect(result.summary).toBe('FAIL 0/1');
    expect(result.exitCode).toBe(4);
  });

  it('the --allow-eval-failure opt-out downgrades a failing verdict to Ok (0)', async () => {
    const failing = makeHarnessFakeSpawn({ graderPassed: false });
    const result = await runHarness(getTempDir(), getSubjectStagedDir(), failing.spawn, { tolerateEvalFailure: true });
    expect(result.summary).toBe('FAIL 0/1');
    expect(result.exitCode).toBe(0);
  });
});
