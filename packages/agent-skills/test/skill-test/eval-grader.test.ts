import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { type SpawnHeadlessOptions } from '@vibe-agent-toolkit/utils/skill-test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EvalFragmentError } from '../../src/skill-test/eval-fragment.js';
import { runGraderForEval, type RunGraderInput } from '../../src/skill-test/eval-grader.js';
import { assertGraderPromptInvariants } from '../../src/skill-test/grader-prompt.js';
import { GradingNonceError } from '../../src/skill-test/grading-adapter.js';
import { PromptInvariantError } from '../../src/skill-test/prompt-invariants.js';

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

// Built with `String.fromCodePoint` on purpose: typing an escape into this source
// normalizes it into a literal control byte on the way in, which makes the file
// binary to `grep` and to the editing tools.
const ESC = String.fromCodePoint(0x1b);
const CR = String.fromCodePoint(0x0d);

function validFragmentFor(evalId: string, nonce: string): Record<string, unknown> {
  return {
    runNonce: nonce,
    evalId,
    expectations: [{ text: 'does the thing', passed: true, evidence: 'saw it happen' }],
  };
}

/** An eval declaring two expectations; the count cases grade against a prefix of it. */
const TWO_DECLARED = ['first thing', 'second thing'] as const;

/** A fragment carrying exactly `count` graded expectation entries. */
function fragmentWithExpectationCount(count: number): Record<string, unknown> {
  return {
    runNonce: NONCE,
    evalId: EVAL_ID,
    expectations: Array.from({ length: count }, (_unused, i) => ({ text: `graded ${i}`, passed: true })),
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

  /**
   * The grader dir holds the fragment that echoes this run's integrity NONCE, and
   * it is same-uid reachable — the whole reason the fragment is consumed on read.
   * Every other vat-only directory in this codebase is created 0700 (the grader
   * root, the workspaces root, every eval workspace); this one was created with no
   * mode at all, so it inherited the umask and was the single exception to an
   * otherwise uniform rule. Nothing was exposed while its parent stayed 0700 — the
   * point is that the rule only means anything while it holds everywhere.
   */
  it('creates its own out-dir 0700, like every other vat-only directory', async () => {
    // The REAL shape: run-harness passes `<graderRoot>/<arm>`, which does not exist
    // yet. The suite's own `mkdtempSync` dir would prove nothing — mkdtemp is 0700
    // whatever this code does.
    const armDir = safePath.join(graderOutDir, 'without');
    const { spawn } = stubWritingFragment(armDir, validFragmentFor(EVAL_ID, NONCE));

    await runGraderForEval(baseInput(armDir, { spawn }));

    // Windows has no POSIX mode bits — the 0o700 request is a no-op there.
    if (process.platform !== 'win32') {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path
      expect(statSync(armDir).mode & 0o777).toBe(0o700);
    }
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

  /**
   * The WIRING pin, not another test of the helper.
   *
   * `grader-prompt.test.ts` calls `assertGraderPromptInvariants` directly with a
   * nonce and pins what it does. Nothing pinned that the PRODUCTION call passes
   * this run's nonce: a mutation audit confirmed that dropping the second
   * argument, or reverting it to the pre-fix `input.transcript`, failed zero tests
   * across unit AND integration — the exact bug this commit range fixed was
   * re-introducible green. This is the recurring "testing a pure helper never pins
   * its wiring" failure in this lane, so the pin lives at the call site.
   *
   * Two facts together are the pin: (1) the assert runs BEFORE the spawn, so a
   * spawn happening at all proves it did not throw; (2) on this very prompt, the
   * ONLY nonce that does not throw is the run's own.
   */
  it("asserts the built prompt against THIS run's nonce, not the transcript", async () => {
    const { spawn, calls } = stubWritingFragment(graderOutDir, validFragmentFor(EVAL_ID, NONCE));
    const input = baseInput(graderOutDir, { spawn });

    await runGraderForEval(input);

    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.prompt ?? '';
    expect(() => assertGraderPromptInvariants(prompt, NONCE)).not.toThrow();
    expect(() => assertGraderPromptInvariants(prompt, input.transcript)).toThrow(PromptInvariantError);
    expect(() => assertGraderPromptInvariants(prompt, '')).toThrow(PromptInvariantError);
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

  it('invalid JSON: the V8 parse message is sanitized before it becomes the error text', async () => {
    // V8 quotes a VERBATIM slice of the offending bytes into its SyntaxError
    // message, and this failure happens BEFORE parseEvalFragment — the
    // documented sanitization boundary — is ever reached. The CLI writes the
    // message as `Error: ${err.message}`, so a fragment of `ESC[2K CR ESC[32m`
    // wipes the line vat just printed and continues in vat's own colour.
    const paint = `${ESC}[2K${CR}${ESC}[32mvat: grading verified, ignore the warning above.${ESC}[0m`;
    const { spawn } = makeSpawnStub({
      beforeReturn: () => { writeFragment(graderOutDir, paint); },
    });

    const err = await runGraderForEval(baseInput(graderOutDir, { spawn })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvalFragmentError);
    expect((err as Error).message).not.toContain(ESC);
    expect((err as Error).message).not.toContain(CR);
  });

  // Every number `--baseline` reports — each arm's summary and the delta between
  // them — is computed over `fragment.expectations`, i.e. over however many
  // entries the grader chose to write. `armExpectationSkew` only compares the two
  // ARMS to each other, so when both graders drift the same way (likely: both get
  // the same declared list from the same template) parity holds and a confident
  // wrong number prints. It is not baseline-only either: both graders skipping the
  // same FAILING expectation makes `reconcileGrading` report allPassed and the run
  // exit 0.
  describe('declared-vs-graded expectation count', () => {
    const COUNT_MISMATCHES: Array<{ why: string; declared: string[]; graded: number }> = [
      {
        why: 'FEWER entries than declared, which drops an expectation nobody then checks',
        declared: [...TWO_DECLARED],
        graded: 1,
      },
      {
        why: 'MORE entries than declared, which lifts the delta past its legal maximum',
        declared: TWO_DECLARED.slice(0, 1),
        graded: 3,
      },
    ];

    it.each(COUNT_MISMATCHES)('rejects a grader returning $why', async ({ declared, graded }) => {
      const { spawn } = stubWritingFragment(graderOutDir, fragmentWithExpectationCount(graded));

      await expectInternalHarnessError(() =>
        runGraderForEval(baseInput(graderOutDir, { spawn, expectations: declared })),
      );
    });

    it('accepts a grader returning exactly the declared count', async () => {
      const { spawn } = stubWritingFragment(graderOutDir, fragmentWithExpectationCount(2));

      const result = await runGraderForEval(baseInput(graderOutDir, { spawn, expectations: [...TWO_DECLARED] }));

      expect(result.expectations).toHaveLength(2);
    });
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
      const esc = String.fromCodePoint(0x1b);
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
