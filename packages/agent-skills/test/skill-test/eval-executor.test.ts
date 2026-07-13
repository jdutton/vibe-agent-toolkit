import type { SpawnResult } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { runExecutorForEval, type RunExecutorInput } from '../../src/skill-test/eval-executor.js';
import { RateLimitSignal } from '../../src/skill-test/pipeline.js';

import {
  expectInternalHarnessError,
  makeSpawnStub,
  SPAWN_OK,
  SPAWN_STALLED,
  SPAWN_TIMED_OUT,
  type SpawnStub,
} from './spawn-stub.js';

const RESULT_OK_LINE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 });
const RESULT_ERROR_LINE = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, num_turns: 1 });
const RATE_LIMIT_LINE = JSON.stringify({ type: 'rate_limit_event' });
const CLEAN_OK: SpawnResult = SPAWN_OK;
const SUBJECT_ONLY_DIR = '/h/subject-only';
const WORKSPACE_DIR = '/w/workspaces/eval-1';

function baseInput(overrides: Partial<RunExecutorInput> = {}): RunExecutorInput {
  return {
    evalId: 'eval-1',
    task: 'Summarize the report.',
    subjectStagedDir: '/h/subject',
    pluginDirs: ['/h/subject'],
    env: {},
    maxTurns: 10,
    maxBudgetUsd: 1,
    timeoutMs: 60_000,
    ...overrides,
  };
}

/** Spawn stub that emits `lines` (each newline-terminated) via onStdout, then resolves `result`. */
function stubSpawn(lines: string[], result: SpawnResult): SpawnStub {
  return makeSpawnStub({ stdoutLines: lines, result });
}

describe('runExecutorForEval', () => {
  it('happy path: captures transcript, parses it, cleanFailure false, forwards chunks to onProgress', async () => {
    const { spawn, calls } = stubSpawn([RESULT_OK_LINE], CLEAN_OK);
    const progressChunks: string[] = [];

    const outcome = await runExecutorForEval(
      baseInput({ spawn, onProgress: (chunk) => { progressChunks.push(chunk); } }),
    );

    expect(outcome.transcript).toContain(RESULT_OK_LINE);
    expect(outcome.parsed.result?.subtype).toBe('success');
    expect(outcome.cleanFailure).toBe(false);
    expect(outcome.spawnResult).toEqual(CLEAN_OK);
    expect(progressChunks.join('')).toContain(RESULT_OK_LINE);
    expect(calls).toHaveLength(1);
  });

  it('clean non-zero exit within budget: returns cleanFailure true, does NOT throw', async () => {
    const { spawn } = stubSpawn([RESULT_ERROR_LINE], { status: 1, timedOut: false, stalled: false });

    const outcome = await runExecutorForEval(baseInput({ spawn }));

    expect(outcome.cleanFailure).toBe(true);
    expect(outcome.spawnResult.status).toBe(1);
    expect(outcome.parsed.result?.isError).toBe(true);
  });

  it('timedOut: throws InternalHarnessError (harness breakage), never a success', async () => {
    const { spawn } = stubSpawn([], SPAWN_TIMED_OUT);

    await expectInternalHarnessError(() => runExecutorForEval(baseInput({ spawn })));
  });

  it('stalled: throws InternalHarnessError (harness breakage), never a success', async () => {
    const { spawn } = stubSpawn([], SPAWN_STALLED);

    await expectInternalHarnessError(() => runExecutorForEval(baseInput({ spawn })));
  });

  it('spawn rejects: wraps as InternalHarnessError', async () => {
    const { spawn } = makeSpawnStub({ reject: new Error('ENOENT: claude not found') });

    await expectInternalHarnessError(() => runExecutorForEval(baseInput({ spawn })));
    await expect(runExecutorForEval(baseInput({ spawn }))).rejects.toThrow(/ENOENT/);
  });

  it('rate-limit event with non-zero (cut-off) status: throws RateLimitSignal', async () => {
    const { spawn } = stubSpawn([RATE_LIMIT_LINE], { status: 1, timedOut: false, stalled: false });

    await expect(runExecutorForEval(baseInput({ spawn }))).rejects.toBeInstanceOf(RateLimitSignal);
  });

  it('rate-limit event but the run still completed (status 0): kept, returns normally', async () => {
    const { spawn } = stubSpawn([RATE_LIMIT_LINE, RESULT_OK_LINE], { status: 0, timedOut: false, stalled: false });

    const outcome = await runExecutorForEval(baseInput({ spawn }));

    expect(outcome.cleanFailure).toBe(false);
    expect(outcome.parsed.rateLimited).toBe(true);
  });

  it('uses subjectStagedDir for cwd/sandboxDir when workspaceDir is not set', async () => {
    const { spawn, calls } = stubSpawn([RESULT_OK_LINE], CLEAN_OK);

    await runExecutorForEval(baseInput({ spawn, subjectStagedDir: SUBJECT_ONLY_DIR }));

    expect(calls[0]?.cwd).toBe(SUBJECT_ONLY_DIR);
    expect(calls[0]?.sandboxDir).toBe(SUBJECT_ONLY_DIR);
  });

  it('uses workspaceDir for cwd/sandboxDir when set (overrides subjectStagedDir)', async () => {
    const { spawn, calls } = stubSpawn([RESULT_OK_LINE], CLEAN_OK);

    await runExecutorForEval(
      baseInput({ spawn, subjectStagedDir: SUBJECT_ONLY_DIR, workspaceDir: WORKSPACE_DIR }),
    );

    expect(calls[0]?.cwd).toBe(WORKSPACE_DIR);
    expect(calls[0]?.sandboxDir).toBe(WORKSPACE_DIR);
  });

  it('does NOT reject an adopter task that naturally contains a blinding-breaker phrase', async () => {
    const { spawn, calls } = stubSpawn([RESULT_OK_LINE], CLEAN_OK);

    // The task legitimately says "you are being evaluated" — the wired invariant
    // must not police adopter task text, so this reaches the spawn stub unimpeded.
    const outcome = await runExecutorForEval(
      baseInput({ spawn, task: 'Grade the essay; note you are being evaluated on tone.' }),
    );

    expect(calls).toHaveLength(1);
    expect(outcome.cleanFailure).toBe(false);
  });
});
