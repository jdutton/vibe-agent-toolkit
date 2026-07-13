/**
 * Security-gate test for the §12 acknowledgment in runSkillTestHarness.
 *
 * The invariant under test: when preflight PASSES but the run-skill-code ack is
 * ABSENT, the harness must return exitCode 2 ("Security acknowledgment required")
 * AND must NEVER reach the executor→grader pipeline. The existing system test only
 * ever exits 2 because `claude` is absent in CI — it fails at preflight (Step 5)
 * and never reaches the ack gate (Step 6), so the gate itself was unverified.
 *
 * Here we force preflight to PASS (mocking runPreflight) and stub staging so the
 * orchestrator reaches Step 6 with no real `claude` install, then assert the gate
 * blocks the run. spawnHeadlessClaude (the executor/grader default spawn, imported
 * by run-harness from the utils barrel) is replaced with a spy; reaching it would
 * be a gate breach.
 */

import { spawnHeadlessClaude } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillTestExitCode } from '../../src/skill-test/exit-codes.js';
import { runSkillTestHarness } from '../../src/skill-test/run-harness.js';
import { stageHarness } from '../../src/skill-test/staging.js';
import { setupStubbedHarnessSubject } from '../test-helpers.js';

// Force preflight to PASS without a real `claude` binary. resolvedAuth is null:
// the ack gate (Step 6) returns before any auth-dependent step, so it is unused.
vi.mock('../../src/skill-test/preflight.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runPreflight: vi.fn(() => ({ passed: true, checks: [], resolvedAuth: null })),
  };
});

// Stub staging so the orchestrator reaches the ack gate without real resolution.
// subjectStagedDir is filled per-test with a real temp dir that carries an eval
// suite (so the Step-4 bootstrap does not fire exit 3).
vi.mock('../../src/skill-test/staging.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, stageHarness: vi.fn() };
});

// Replace the default executor/grader spawn with a spy: reaching it is a gate breach.
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, spawnHeadlessClaude: vi.fn() };
});

describe('runSkillTestHarness — security ack gate', () => {
  // Shared lifecycle: fresh temp dir + staged subject (with evals) so bootstrap
  // (exit 3) does not fire before the ack gate (exit 2), and stageHarness stubbed.
  const { getTempDir, getSubjectStagedDir } = setupStubbedHarnessSubject('vat-ack-gate-', vi.mocked(stageHarness));

  beforeEach(() => {
    vi.mocked(spawnHeadlessClaude).mockClear();
  });

  it('blocks the spawn and returns exit 2 when preflight passes but the ack is absent', async () => {
    const tempDir = getTempDir();
    const result = await runSkillTestHarness({
      skills: ['my-skill'],
      repoRoot: tempDir,
      workdir: tempDir,
      subjectSource: { path: getSubjectStagedDir() },
      // acknowledgedRunsSkillCode intentionally absent; dryRun absent.
    });

    expect(result.exitCode).toBe(SkillTestExitCode.Preflight);
    expect(result.exitCode).toBe(2);
    expect(result.summary).toContain('Security acknowledgment required');
    // The gate must short-circuit BEFORE any executor/grader spawn.
    expect(vi.mocked(spawnHeadlessClaude)).not.toHaveBeenCalled();
  });
});
