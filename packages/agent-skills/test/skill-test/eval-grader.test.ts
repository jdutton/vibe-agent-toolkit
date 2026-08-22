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

  describe('costSink (spend aggregation, adopter follow-up)', () => {
    it('reports the grader session cost parsed from its transcript', async () => {
      const costs: (number | undefined)[] = [];
      const { spawn } = makeSpawnStub({
        stdoutLines: ['{"type":"result","subtype":"success","total_cost_usd":0.42}'],
        beforeReturn: () => { writeFragment(graderOutDir, validFragmentFor(EVAL_ID, NONCE)); },
      });

      await runGraderForEval(baseInput(graderOutDir, { spawn, costSink: (usd) => costs.push(usd) }));

      expect(costs).toEqual([0.42]);
    });

    it('reports undefined when the transcript carries no result cost', async () => {
      const costs: (number | undefined)[] = [];
      const { spawn } = stubWritingFragment(graderOutDir, validFragmentFor(EVAL_ID, NONCE));

      await runGraderForEval(baseInput(graderOutDir, { spawn, costSink: (usd) => costs.push(usd) }));

      expect(costs).toEqual([undefined]);
    });
  });

  describe('toolExpectations / declaredExecutables thread-through (issue #145 Phase T)', () => {
    it('reaches buildGraderPrompt when provided', async () => {
      // The eval declares toolExpectations, so the fragment must carry a `tool`
      // verdict whose `passed` agrees with its sub-checks (fixes #1/#3).
      const fragment = {
        ...validFragmentFor(EVAL_ID, NONCE),
        tool: {
          mustRun: [{ name: 'csvsum', ran: true }],
          mustNotRun: [{ name: 'rm', ran: false }],
          sequence: [{ steps: ['parse', 'report'], satisfied: true }],
          passed: true,
        },
      };
      const { spawn, calls } = stubWritingFragment(graderOutDir, fragment);

      await runGraderForEval(
        baseInput(graderOutDir, {
          spawn,
          toolExpectations: { mustRun: ['csvsum'], mustNotRun: ['rm'], sequence: ['parse', 'report'] },
          declaredExecutables: [{ name: 'csvsum', howInvoked: 'uv run csvsum.py', kind: 'python' }],
        }),
      );

      expect(calls[0]?.prompt).toContain('csvsum');
      expect(calls[0]?.prompt).toContain('uv run csvsum.py');
      expect(calls[0]?.prompt).toMatch(/"tool"/);
    });

    it('a fragment WITH a tool body parses end-to-end and is returned as-is', async () => {
      const fragment = {
        ...validFragmentFor(EVAL_ID, NONCE),
        tool: {
          mustRun: [{ name: 'csvsum', ran: true, evidence: 'saw uv run csvsum.py in tool_use' }],
          mustNotRun: [{ name: 'rm', ran: false }],
          sequence: [{ steps: ['parse', 'report'], satisfied: true }],
          passed: true,
        },
      };
      const { spawn } = stubWritingFragment(graderOutDir, fragment);

      const result = await runGraderForEval(
        baseInput(graderOutDir, {
          spawn,
          toolExpectations: { mustRun: ['csvsum'], mustNotRun: ['rm'], sequence: ['parse', 'report'] },
        }),
      );

      expect(result).toEqual(fragment);
    });

    it('behavior is unchanged when both fields are absent (no tool marker in prompt)', async () => {
      const { spawn, calls } = stubWritingFragment(graderOutDir, validFragmentFor(EVAL_ID, NONCE));

      await runGraderForEval(baseInput(graderOutDir, { spawn }));

      expect(calls[0]?.prompt).not.toMatch(/"tool"/);
    });

    it('toolExpectations declared but fragment omits `tool`: throws InternalHarnessError (fail-open fix #1)', async () => {
      // The grader was asked to judge tool expectations but returned no tool verdict —
      // an absent block must NOT launder into a silent pass.
      const { spawn } = stubWritingFragment(graderOutDir, validFragmentFor(EVAL_ID, NONCE));

      await expectInternalHarnessError(() =>
        runGraderForEval(baseInput(graderOutDir, { spawn, toolExpectations: { mustRun: ['csvsum'] } })),
      );
    });

    it('tool.passed disagrees with its own sub-checks: throws InternalHarnessError (fail-open fix #3)', async () => {
      // mustRun.ran=false recomputes to passed=false, but the grader claimed passed=true.
      const fragment = {
        ...validFragmentFor(EVAL_ID, NONCE),
        tool: { mustRun: [{ name: 'csvsum', ran: false }], passed: true },
      };
      const { spawn } = stubWritingFragment(graderOutDir, fragment);

      await expectInternalHarnessError(() =>
        runGraderForEval(baseInput(graderOutDir, { spawn, toolExpectations: { mustRun: ['csvsum'] } })),
      );
    });

    // `computeToolPassed` iterates the checks the GRADER emitted, not the ones
    // the eval declared — so both an omitted and an invented name silently move
    // the verdict. Fail-closed, like the two guards above it.
    const NAME_MISMATCHES: Array<{
      why: string;
      tool: Record<string, unknown>;
      toolExpectations?: RunGraderInput['toolExpectations'];
    }> = [
      {
        // With no mustRun entry the channel is vacuously true, so the verdict
        // reads passed:true for an executable nobody checked.
        why: 'OMITTING a declared mustRun check, which would launder a vacuous pass',
        tool: { mustRun: [], passed: true },
        toolExpectations: { mustRun: ['csvsum'] },
      },
      {
        why: 'INVENTING a mustRun check the eval never declared',
        tool: { mustRun: [{ name: 'csvsum', ran: true }, { name: 'totally-fine', ran: true }], passed: true },
        toolExpectations: { mustRun: ['csvsum'] },
      },
      {
        // mergeFragmentsToToolEval carries any `tool` body into tool-eval.json,
        // so an unsolicited verdict would land there as if vat had asked for it.
        why: 'a whole tool verdict when the eval declared NO expectations at all',
        tool: { mustRun: [{ name: 'invented', ran: true }], passed: true },
      },
      {
        why: 'mismatched sequence STEPS, not just top-level check names',
        tool: { sequence: [{ steps: ['parse', 'invented-step'], satisfied: true }], passed: true },
        toolExpectations: { sequence: ['parse', 'report'] },
      },
    ];

    it.each(NAME_MISMATCHES)('rejects $why', async ({ tool, toolExpectations }) => {
      const { spawn } = stubWritingFragment(graderOutDir, { ...validFragmentFor(EVAL_ID, NONCE), tool });

      await expectInternalHarnessError(() =>
        runGraderForEval(
          baseInput(graderOutDir, { spawn, ...(toolExpectations === undefined ? {} : { toolExpectations }) }),
        ),
      );
    });

    it('names still match when the grader decorates one with an escape sequence', async () => {
      // The fragment parse sanitizes the reported name; the declared side is
      // normalized the same way, so the comparison happens in one space and a
      // decorated name is neither a false mismatch nor a way past the check.
      const esc = String.fromCharCode(0x1b);
      const fragment = {
        ...validFragmentFor(EVAL_ID, NONCE),
        tool: { mustRun: [{ name: `${esc}[32mcsvsum${esc}[0m`, ran: true }], passed: true },
      };
      const { spawn } = stubWritingFragment(graderOutDir, fragment);

      const result = await runGraderForEval(
        baseInput(graderOutDir, { spawn, toolExpectations: { mustRun: ['csvsum'] } }),
      );

      expect(result.tool?.mustRun?.[0]?.name).toBe('csvsum');
    });

    it('a mustSucceed tool verdict whose `passed` agrees with its sub-checks parses through', async () => {
      const fragment = {
        ...validFragmentFor(EVAL_ID, NONCE),
        tool: { mustSucceed: [{ name: 'csvsum', succeeded: true, evidence: 'no is_error' }], passed: true },
      };
      const { spawn } = stubWritingFragment(graderOutDir, fragment);

      const result = await runGraderForEval(
        baseInput(graderOutDir, { spawn, toolExpectations: { mustSucceed: ['csvsum'] } }),
      );

      expect(result).toEqual(fragment);
    });
  });
});
