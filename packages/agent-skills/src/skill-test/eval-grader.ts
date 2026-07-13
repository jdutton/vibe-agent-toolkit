import { existsSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, spawnHeadlessClaude } from '@vibe-agent-toolkit/utils';

import { EvalFragmentError, parseEvalFragment, type EvalFragment } from './eval-fragment.js';
import type { ToolExpectations } from './eval-inputs.js';
import { InternalHarnessError } from './exit-codes.js';
import { assertGraderPromptInvariants, buildGraderPrompt } from './grader-prompt.js';
import { GradingNonceError } from './grading-adapter.js';

export interface RunGraderInput {
  evalId: string;
  /** The FULL captured transcript (stream-json) for this eval's executor run. */
  transcript: string;
  expectations: string[];
  expectedOutput?: string;
  /** Path to the vendored skill-creator grader rubric (references/grader.md). */
  rubricPath: string;
  /**
   * The eval's declared tool expectations (issue #145 Phase T). Optional — when
   * absent, `buildGraderPrompt` emits no tool-verdict instruction and the
   * returned fragment omits `tool`. See `grader-prompt.ts`'s
   * `BuildGraderPromptOptions.toolExpectations`.
   */
  toolExpectations?: ToolExpectations;
  /** Name → invocation hint for declared executables, a recognition aid alongside `toolExpectations`. */
  declaredExecutables?: Array<{ name: string; howInvoked: string; kind: string }>;
  /**
   * VAT-ONLY directory the grader fragment is written to — deliberately
   * OUTSIDE the skill-writable sandbox (never the executor's staged/workspace
   * dir) so untrusted skill code from Task 7's executor run cannot forge or
   * delete the fragment this run relies on.
   */
  graderOutDir: string;
  graderModel: string;
  /** Per-run integrity nonce the grader must echo back in the fragment. */
  nonce: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  stallMs?: number;
  /** Grader auth env — no skill secrets are needed beyond auth. */
  env: NodeJS.ProcessEnv;
  /** Injectable seam for tests; defaults to the real {@link spawnHeadlessClaude}. */
  spawn?: typeof spawnHeadlessClaude;
  /** Called with each stdout chunk as it streams (for progress echo). */
  onProgress?: (chunk: string) => void;
}

/**
 * Run ONE eval's grader: a blind `claude -p` spawn (grader model, NO
 * skill/plugin loaded) that reads the executor's captured transcript via its
 * prompt and writes a nonce'd fragment JSON to `graderOutDir` (issue #145
 * Task 8). `graderOutDir` is vat-only and separate from the skill sandbox the
 * executor ran in (Task 7) — the grader's `sandboxDir` --add-dir is
 * `graderOutDir` itself, and `pluginDirs: []` means no skill code ever runs
 * inside the grader's process, so skill code cannot forge or tamper with the
 * fragment this run trusts.
 *
 * The grader is vat infrastructure, not the thing under test: unlike the
 * executor (see eval-executor.ts), there is NO clean-failure path here. A
 * spawn rejection, watchdog kill (`timedOut`/`stalled`), non-zero exit, or a
 * missing fragment file all mean the grader failed to do its ONE job and are
 * thrown as {@link InternalHarnessError} (exit 1) — never laundered into a
 * passing (or even a valid failing) verdict.
 *
 * Once the fragment file exists, shape/JSON problems throw
 * {@link EvalFragmentError} (via {@link parseEvalFragment}) and a nonce that
 * doesn't match this run's expected nonce throws {@link GradingNonceError} —
 * both distinct from harness breakage because the grader DID run and produce
 * *something*, just not something we can trust.
 */
/**
 * Adapt the grader's stdout `onProgress` sink into the `onWarn` callback
 * {@link parseEvalFragment} expects (used only when it drops malformed friction
 * items). Extracted so the ternary does not add a branch to `runGraderForEval`'s
 * cognitive complexity budget.
 */
function fragmentWarnRouter(
  onProgress: RunGraderInput['onProgress'],
): ((message: string) => void) | undefined {
  if (onProgress === undefined) return undefined;
  return (message) => onProgress(`[skill-test] ${message}\n`);
}

export async function runGraderForEval(input: RunGraderInput): Promise<EvalFragment> {
  mkdirSyncReal(input.graderOutDir, { recursive: true });

  // evalId is validated `[A-Za-z0-9_-]+` upstream (eval-inputs.ts) so a plain
  // join is safe, but `joinUnderRoot` is used defensively — it costs nothing
  // and closes off any future path where an unvalidated id reaches here.
  const fragmentOut = safePath.joinUnderRoot(input.graderOutDir, `${input.evalId}.json`);

  const prompt = buildGraderPrompt({
    evalId: input.evalId,
    transcript: input.transcript,
    expectations: input.expectations,
    ...(input.expectedOutput === undefined ? {} : { expectedOutput: input.expectedOutput }),
    rubricPath: input.rubricPath,
    fragmentOut,
    nonce: input.nonce,
    ...(input.toolExpectations === undefined ? {} : { toolExpectations: input.toolExpectations }),
    ...(input.declaredExecutables === undefined ? {} : { declaredExecutables: input.declaredExecutables }),
  });
  // Defense-in-depth (parity with eval-executor.ts's build→assert→use pattern):
  // re-verify the built grader prompt still carries its required invariants
  // (STOP, fragment path, browser/iteration forbids, nonce directive) before
  // spawning, so a regressed buildGraderPrompt is caught here, not by a grader
  // that silently misbehaves.
  assertGraderPromptInvariants(prompt, input.transcript);

  const spawn = input.spawn ?? spawnHeadlessClaude;

  const onStdout = (chunk: string): void => {
    input.onProgress?.(chunk);
  };

  let spawnResult;
  try {
    spawnResult = await spawn({
      prompt,
      // No skill/plugin ever loads inside the grader's process — this is the
      // forgery-proofing half of the contract (the other half is that
      // graderOutDir is not the skill sandbox).
      pluginDirs: [],
      sandboxDir: input.graderOutDir,
      cwd: input.graderOutDir,
      env: input.env,
      timeoutMs: input.timeoutMs,
      onStdout,
      maxTurns: input.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd,
      model: input.graderModel,
      ...(input.stallMs === undefined ? {} : { stallMs: input.stallMs }),
    });
  } catch (err) {
    throw new InternalHarnessError(
      `Grader spawn failed for eval "${input.evalId}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The grader is vat infrastructure: any of these mean it failed to do its
  // ONE job, so all of them are harness breakage — there is no clean-failure
  // path here (contrast eval-executor.ts's cleanFailure).
  if (spawnResult.stalled) {
    throw new InternalHarnessError(
      `Grader stalled for eval "${input.evalId}" (no output for ${input.stallMs ?? 0}ms).`,
    );
  }
  if (spawnResult.timedOut) {
    throw new InternalHarnessError(
      `Grader timed out for eval "${input.evalId}" (limit ${input.timeoutMs}ms).`,
    );
  }
  if (spawnResult.status !== 0) {
    throw new InternalHarnessError(
      `Grader exited non-zero (status ${spawnResult.status}) for eval "${input.evalId}".`,
    );
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fragmentOut is our own derived path (joinUnderRoot-guarded)
  if (!existsSync(fragmentOut)) {
    throw new InternalHarnessError(
      `Grader exited (status ${spawnResult.status}) without writing a fragment at ${fragmentOut} for eval "${input.evalId}".`,
    );
  }

  let raw: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fragmentOut is our own derived path (joinUnderRoot-guarded)
    raw = JSON.parse(readFileSync(fragmentOut, 'utf-8'));
  } catch (err) {
    throw new EvalFragmentError(
      `grader fragment for eval "${input.evalId}" at ${fragmentOut} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fragment = parseEvalFragment(raw, fragmentWarnRouter(input.onProgress));

  // Integrity gate: a missing/wrong nonce means this fragment was not produced
  // by the grader we prompted for THIS run — most likely forged or left behind
  // by untrusted skill code — so the verdict cannot be trusted, hard error.
  if (fragment.runNonce !== input.nonce) {
    throw new GradingNonceError(
      `eval "${input.evalId}" fragment \`runNonce\` does not match this run`,
    );
  }

  return fragment;
}
