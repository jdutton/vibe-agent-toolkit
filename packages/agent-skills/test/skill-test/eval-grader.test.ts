import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath, type SpawnHeadlessOptions } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EvalFragmentError } from '../../src/skill-test/eval-fragment.js';
import { runGraderForEval, type RunGraderInput } from '../../src/skill-test/eval-grader.js';
import { GradingNonceError } from '../../src/skill-test/grading-adapter.js';

import {
  expectInternalHarnessError,
  makeSpawnStub,
  SPAWN_OK,
  SPAWN_STALLED,
  SPAWN_TIMED_OUT,
  type SpawnStub,
} from './spawn-stub.js';

const NONCE = 'nonce-abc-123';
const EVAL_ID = 'eval-1';
const ENOENT_ERROR = new Error('ENOENT: claude not found');

function validFragmentFor(evalId: string, nonce: string): Record<string, unknown> {
  return {
    runNonce: nonce,
    evalId,
    expectations: [{ text: 'does the thing', passed: true, evidence: 'saw it happen' }],
  };
}

function baseInput(graderOutDir: string, overrides: Partial<RunGraderInput> = {}): RunGraderInput {
  return {
    evalId: EVAL_ID,
    transcript: '{"type":"result","subtype":"success"}',
    expectations: ['does the thing'],
    rubricPath: '/vendored/skill-creator/references/grader.md',
    graderOutDir,
    graderModel: 'claude-grader-model',
    nonce: NONCE,
    maxTurns: 10,
    maxBudgetUsd: 1,
    timeoutMs: 60_000,
    env: {},
    ...overrides,
  };
}

/** Write `fragment` to `<graderOutDir>/<EVAL_ID>.json`. */
function writeFragment(graderOutDir: string, fragment: Record<string, unknown> | string): void {
  const fragmentOut = safePath.join(graderOutDir, `${EVAL_ID}.json`);
  const body = typeof fragment === 'string' ? fragment : JSON.stringify(fragment);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path
  writeFileSync(fragmentOut, body);
}

/** Spawn stub that writes `fragment` (if given) to the fragment path, then resolves `result`. */
function stubWritingFragment(
  graderOutDir: string,
  fragment: Record<string, unknown> | undefined,
  result = SPAWN_OK,
): SpawnStub {
  return makeSpawnStub({
    result,
    ...(fragment === undefined
      ? {}
      : { beforeReturn: (_opts: SpawnHeadlessOptions): void => { writeFragment(graderOutDir, fragment); } }),
  });
}

describe('runGraderForEval', () => {
  let graderOutDir: string;

  beforeEach(() => {
    graderOutDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-grader-out-'));
  });

  afterEach(() => {
    rmSync(graderOutDir, { recursive: true, force: true });
  });

  it('happy path: reads the written fragment and returns it', async () => {
    const fragment = validFragmentFor(EVAL_ID, NONCE);
    const { spawn, calls } = stubWritingFragment(graderOutDir, fragment);

    const result = await runGraderForEval(baseInput(graderOutDir, { spawn }));

    expect(result).toEqual(fragment);
    expect(calls).toHaveLength(1);
  });

  it('forgery-proofing: grader spawn receives pluginDirs: [] and sandboxDir === graderOutDir', async () => {
    const fragment = validFragmentFor(EVAL_ID, NONCE);
    const { spawn, calls } = stubWritingFragment(graderOutDir, fragment);

    await runGraderForEval(baseInput(graderOutDir, { spawn }));

    expect(calls[0]?.pluginDirs).toEqual([]);
    expect(calls[0]?.sandboxDir).toBe(graderOutDir);
    expect(calls[0]?.cwd).toBe(graderOutDir);
    expect(calls[0]?.model).toBe('claude-grader-model');
  });

  it('forwards stdout chunks to onProgress', async () => {
    const progressChunks: string[] = [];
    const { spawn } = makeSpawnStub({
      stdoutLines: ['some progress'],
      beforeReturn: () => { writeFragment(graderOutDir, validFragmentFor(EVAL_ID, NONCE)); },
    });

    await runGraderForEval(
      baseInput(graderOutDir, { spawn, onProgress: (chunk) => { progressChunks.push(chunk); } }),
    );

    expect(progressChunks.join('')).toContain('some progress');
  });

  it('non-zero grader exit: throws InternalHarnessError', async () => {
    const { spawn } = stubWritingFragment(graderOutDir, validFragmentFor(EVAL_ID, NONCE), {
      status: 1,
      timedOut: false,
      stalled: false,
    });

    await expectInternalHarnessError(() => runGraderForEval(baseInput(graderOutDir, { spawn })));
  });

  it('timedOut: throws InternalHarnessError', async () => {
    const { spawn } = stubWritingFragment(graderOutDir, undefined, SPAWN_TIMED_OUT);

    await expectInternalHarnessError(() => runGraderForEval(baseInput(graderOutDir, { spawn })));
  });

  it('stalled: throws InternalHarnessError', async () => {
    const { spawn } = stubWritingFragment(graderOutDir, undefined, SPAWN_STALLED);

    await expectInternalHarnessError(() => runGraderForEval(baseInput(graderOutDir, { spawn })));
  });

  it('spawn rejects: wraps as InternalHarnessError', async () => {
    const { spawn } = makeSpawnStub({ reject: ENOENT_ERROR });

    await expectInternalHarnessError(() => runGraderForEval(baseInput(graderOutDir, { spawn })));
    await expect(runGraderForEval(baseInput(graderOutDir, { spawn }))).rejects.toThrow(/ENOENT/);
  });

  it('status 0 but no fragment file written: throws InternalHarnessError', async () => {
    const { spawn } = stubWritingFragment(graderOutDir, undefined);

    await expectInternalHarnessError(() => runGraderForEval(baseInput(graderOutDir, { spawn })));
  });

  it('mismatched nonce: throws GradingNonceError', async () => {
    const { spawn } = stubWritingFragment(graderOutDir, validFragmentFor(EVAL_ID, 'forged-nonce'));

    await expect(runGraderForEval(baseInput(graderOutDir, { spawn }))).rejects.toBeInstanceOf(GradingNonceError);
  });

  it('bad fragment shape: throws EvalFragmentError', async () => {
    const { spawn } = stubWritingFragment(
      graderOutDir,
      { runNonce: NONCE, evalId: EVAL_ID, expectations: [] }, // empty expectations violates schema
    );

    await expect(runGraderForEval(baseInput(graderOutDir, { spawn }))).rejects.toBeInstanceOf(EvalFragmentError);
  });

  it('invalid JSON in fragment file: throws EvalFragmentError', async () => {
    const { spawn } = makeSpawnStub({
      beforeReturn: () => { writeFragment(graderOutDir, '{not valid json'); },
    });

    await expect(runGraderForEval(baseInput(graderOutDir, { spawn }))).rejects.toBeInstanceOf(EvalFragmentError);
  });

  describe('toolExpectations / declaredExecutables thread-through (issue #145 Phase T)', () => {
    it('reaches buildGraderPrompt when provided', async () => {
      const { spawn, calls } = stubWritingFragment(graderOutDir, validFragmentFor(EVAL_ID, NONCE));

      await runGraderForEval(
        baseInput(graderOutDir, {
          spawn,
          toolExpectations: { mustRun: ['dxa'], mustNotRun: ['rm'], sequence: ['parse', 'report'] },
          declaredExecutables: [{ name: 'dxa', howInvoked: 'uv run dxa.py', kind: 'python' }],
        }),
      );

      expect(calls[0]?.prompt).toContain('dxa');
      expect(calls[0]?.prompt).toContain('uv run dxa.py');
      expect(calls[0]?.prompt).toMatch(/"tool"/);
    });

    it('a fragment WITH a tool body parses end-to-end and is returned as-is', async () => {
      const fragment = {
        ...validFragmentFor(EVAL_ID, NONCE),
        tool: {
          mustRun: [{ name: 'dxa', ran: true, evidence: 'saw uv run dxa.py in tool_use' }],
          mustNotRun: [{ name: 'rm', ran: false }],
          sequence: [{ steps: ['parse', 'report'], satisfied: true }],
          passed: true,
        },
      };
      const { spawn } = stubWritingFragment(graderOutDir, fragment);

      const result = await runGraderForEval(
        baseInput(graderOutDir, {
          spawn,
          toolExpectations: { mustRun: ['dxa'], mustNotRun: ['rm'], sequence: ['parse', 'report'] },
        }),
      );

      expect(result).toEqual(fragment);
    });

    it('behavior is unchanged when both fields are absent (no tool marker in prompt)', async () => {
      const { spawn, calls } = stubWritingFragment(graderOutDir, validFragmentFor(EVAL_ID, NONCE));

      await runGraderForEval(baseInput(graderOutDir, { spawn }));

      expect(calls[0]?.prompt).not.toMatch(/"tool"/);
    });
  });
});
