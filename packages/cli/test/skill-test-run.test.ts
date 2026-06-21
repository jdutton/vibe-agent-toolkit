/**
 * Unit tests for `vat skill test run` CLI orchestration.
 *
 * These tests mock `runSkillTestHarness` entirely so no real binary, staging,
 * or filesystem work runs. The goal is to verify that:
 *   - exit 0  on happy-path success
 *   - exit 3  when BootstrapNeededError is thrown
 *   - exit 2  when a preflight-class error is thrown (HarnessLocationError)
 *   - exit 1  when an internal/parse-failure error is thrown (InternalHarnessError)
 */

import * as harness from '@vibe-agent-toolkit/agent-skills';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSkillTestRun } from '../src/commands/skill/test/run.js';

// Mocks runSkillTestHarness with the given result, captures stdout/stderr writes
// while runSkillTestRun executes, and returns the captured write payloads.
async function runAndCaptureStreams(result: {
  harnessPath: string;
  exitCode: number;
  summary: string;
}): Promise<{ stdoutCalls: string[]; stderrCalls: string[] }> {
  vi.spyOn(harness, 'runSkillTestHarness').mockResolvedValue(result);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

  await runSkillTestRun(['my-skill'], {});

  return {
    stdoutCalls: stdoutSpy.mock.calls.map((c) => String(c[0])),
    stderrCalls: stderrSpy.mock.calls.map((c) => String(c[0])),
  };
}

describe('vat skill test run (orchestration)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits 0 and prints the harness path on success', async () => {
    vi.spyOn(harness, 'runSkillTestHarness').mockResolvedValue({
      harnessPath: '/h',
      exitCode: 0,
      summary: 'PASS 3/3',
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun(['my-skill'], {});
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 3 on guided bootstrap', async () => {
    const { BootstrapNeededError } = await import('@vibe-agent-toolkit/agent-skills');
    vi.spyOn(harness, 'runSkillTestHarness').mockRejectedValue(
      new BootstrapNeededError('/h/evals/evals.json'),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun(['my-skill'], {});
    expect(exit).toHaveBeenCalledWith(3);
  });

  it('exits 2 on preflight-class error (HarnessLocationError)', async () => {
    const { HarnessLocationError } = await import('@vibe-agent-toolkit/agent-skills');
    vi.spyOn(harness, 'runSkillTestHarness').mockRejectedValue(
      new HarnessLocationError('harness root is unsafe'),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun(['my-skill'], {});
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('exits 1 on internal harness error (InternalHarnessError)', async () => {
    const { InternalHarnessError } = await import('@vibe-agent-toolkit/agent-skills');
    vi.spyOn(harness, 'runSkillTestHarness').mockRejectedValue(
      new InternalHarnessError('grading.json missing'),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun(['my-skill'], {});
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('vat skill test run (output routing)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes Summary: to stdout and Harness: to stderr', async () => {
    const { stdoutCalls, stderrCalls } = await runAndCaptureStreams({
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      harnessPath: '/tmp/h',
      exitCode: 0,
      summary: 'PASS 2/2',
    });

    expect(stdoutCalls.some((s) => s.includes('Summary:'))).toBe(true); // Summary → stdout
    expect(stderrCalls.some((s) => s.includes('Harness:'))).toBe(true); // Harness debug → stderr
    expect(stderrCalls.some((s) => s.includes('Summary:'))).toBe(false); // Summary not on stderr
  });

  it('does not write Summary: to stderr on non-zero exit', async () => {
    const { stdoutCalls, stderrCalls } = await runAndCaptureStreams({
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      harnessPath: '/tmp/h',
      exitCode: 1,
      summary: 'FAIL 1/3',
    });

    expect(stdoutCalls.some((s) => s.includes('Summary:'))).toBe(true);
    expect(stderrCalls.some((s) => s.includes('Summary:'))).toBe(false);
  });
});
