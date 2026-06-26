/* eslint-disable @typescript-eslint/no-explicit-any -- test stubs use loose casts for partial mock results */
/**
 * Security-gate test for the §12 acknowledgment in runSkillTestHarness.
 *
 * The invariant under test: when preflight PASSES but the run-skill-code ack is
 * ABSENT, the harness must return exitCode 2 ("Security acknowledgment required")
 * AND must NEVER spawn the experimenter. The existing system test only ever exits
 * 2 because `claude` is absent in CI — it fails at preflight (Step 5) and never
 * reaches the ack gate (Step 6), so the gate itself was unverified.
 *
 * Here we force preflight to PASS (mocking runPreflight) and stub staging so the
 * orchestrator reaches Step 6 with no real `claude` install, then assert the gate
 * blocks the spawn. spawnHeadlessClaude (imported by run-harness from the utils
 * barrel) is replaced with a spy; reaching it would be a gate breach.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, spawnHeadlessClaude } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillTestExitCode } from '../../src/skill-test/exit-codes.js';
import { runSkillTestHarness } from '../../src/skill-test/run-harness.js';
import { stageHarness } from '../../src/skill-test/staging.js';

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

// Replace the experimenter spawn with a spy: reaching it is a gate breach.
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, spawnHeadlessClaude: vi.fn() };
});

describe('runSkillTestHarness — security ack gate', () => {
  let tempDir: string;
  let subjectStagedDir: string;

  beforeEach(() => {
    vi.mocked(spawnHeadlessClaude).mockClear();
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-ack-gate-'));

    // A staged subject that already carries evals/evals.json so bootstrap (exit 3)
    // does not fire before the ack gate (exit 2).
    subjectStagedDir = safePath.join(tempDir, 'staged-subject');
    mkdirSyncReal(safePath.join(subjectStagedDir, 'evals'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own temp fixture
    writeFileSync(safePath.join(subjectStagedDir, 'evals', 'evals.json'), '{"evals":[]}\n', 'utf8');

    vi.mocked(stageHarness).mockResolvedValue({
      manifest: { fingerprint: 'test', entries: [] },
      pluginDirs: [subjectStagedDir],
      subjectStagedDir,
      subjectPluginRoot: null,
    } as any);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('blocks the spawn and returns exit 2 when preflight passes but the ack is absent', async () => {
    const result = await runSkillTestHarness({
      skills: ['my-skill'],
      repoRoot: tempDir,
      workdir: tempDir,
      subjectSource: { path: subjectStagedDir },
      // acknowledgedRunsSkillCode intentionally absent; dryRun absent.
    });

    expect(result.exitCode).toBe(SkillTestExitCode.Preflight);
    expect(result.exitCode).toBe(2);
    expect(result.summary).toContain('Security acknowledgment required');
    // The gate must short-circuit BEFORE the experimenter is ever spawned.
    expect(vi.mocked(spawnHeadlessClaude)).not.toHaveBeenCalled();
  });
});
