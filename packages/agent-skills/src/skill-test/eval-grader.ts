import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { mkdirSyncReal, parseStreamJsonTranscript, safePath, spawnHeadlessClaude } from '@vibe-agent-toolkit/utils';

import { EvalFragmentError, parseEvalFragment, type EvalFragment } from './eval-fragment.js';
import type { ToolExpectations } from './eval-inputs.js';
import { InternalHarnessError } from './exit-codes.js';
import { assertGraderPromptInvariants, buildGraderPrompt } from './grader-prompt.js';
import { GradingNonceError } from './grading-adapter.js';
import { computeToolPassed } from './tool-eval-schema.js';

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
  /**
   * Reports this grader session's `total_cost_usd` (parsed from its stream-json
   * transcript's terminal result; `undefined` when the transcript carried none,
   * e.g. a mock spawn). Called once after a successful grader spawn so the run can
   * aggregate total spend across all executor+grader sessions (adopter follow-up).
   */
  costSink?: (totalCostUsd: number | undefined) => void;
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

  // Accumulate the grader's stream-json stdout so we can read its terminal
  // `total_cost_usd` for run-wide spend aggregation (adopter follow-up). Held in
  // memory only, like the executor's transcript — never written to disk.
  let graderTranscript = '';
  const onStdout = (chunk: string): void => {
    graderTranscript += chunk;
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

  // Report the grader session's cost for run-wide spend aggregation. Parsed from
  // the in-memory transcript (not the fragment) so it reflects real API spend even
  // under subscription auth; `undefined` when the transcript carried no result.
  input.costSink?.(parseStreamJsonTranscript(graderTranscript).result?.totalCostUsd);

  const raw = readAndConsumeFragmentFile(fragmentOut, input.evalId, spawnResult.status);
  const fragment = parseEvalFragment(raw, fragmentWarnRouter(input.onProgress));

  // Integrity gate: a missing/wrong nonce means this fragment was not produced
  // by the grader we prompted for THIS run — most likely forged or left behind
  // by untrusted skill code — so the verdict cannot be trusted, hard error.
  if (fragment.runNonce !== input.nonce) {
    throw new GradingNonceError(
      `eval "${input.evalId}" fragment \`runNonce\` does not match this run`,
    );
  }

  assertToolVerdictConsistent(input.evalId, input.toolExpectations, fragment.tool);

  return fragment;
}

/**
 * Read the grader's fragment JSON into memory and unlink it immediately —
 * consume-on-read. Split out of {@link runGraderForEval} to keep its cognitive
 * complexity within budget. Throws {@link InternalHarnessError} if the grader
 * wrote no fragment, {@link EvalFragmentError} if it is not valid JSON.
 *
 * The unlink is the security-relevant half: the grader dir is same-uid (see
 * `resolveGraderOutDir`), so a fragment left on disk lets skill code that
 * survived the process-group kill read the echoed nonce at leisure and forge
 * LATER fragments. Consuming it on read leaves no persisted copy — exposure
 * shrinks to each fragment's own read window (no cross-eval harvest). The read
 * here is the ONLY read of the file; all downstream logic runs off the returned
 * value. Best-effort: a failed unlink is not a run failure (end-of-run cleanup
 * removes the whole dir), and true isolation from same-uid code is issue #149.
 */
function readAndConsumeFragmentFile(fragmentOut: string, evalId: string, status: number): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fragmentOut is our own derived path (joinUnderRoot-guarded)
  if (!existsSync(fragmentOut)) {
    throw new InternalHarnessError(
      `Grader exited (status ${status}) without writing a fragment at ${fragmentOut} for eval "${evalId}".`,
    );
  }
  let raw: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fragmentOut is our own derived path (joinUnderRoot-guarded)
    raw = JSON.parse(readFileSync(fragmentOut, 'utf-8'));
  } catch (err) {
    throw new EvalFragmentError(
      `grader fragment for eval "${evalId}" at ${fragmentOut} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fragmentOut is our own derived path (joinUnderRoot-guarded)
    unlinkSync(fragmentOut);
  } catch {
    // Swallow: cleanup removes the grader dir regardless.
  }
  return raw;
}

/**
 * Fail-open guards on the grader's tool verdict, split out of
 * {@link runGraderForEval} to keep its cognitive complexity within budget:
 *
 * - Fix #1: the eval DECLARED tool expectations, so the grader was asked to
 *   judge them and emit a `tool` verdict — a fragment WITHOUT one means the
 *   grader silently skipped half its job. That is grader breakage (exit 1),
 *   never a laundered pass: an absent tool block must not merge as "there were
 *   no tool expectations to check".
 * - Fix #3: the grader self-reports `tool.passed`, but we never trust it —
 *   recompute from the sub-checks via {@link computeToolPassed}. A `passed`
 *   that disagrees with its own sub-checks is grader malfunction (a false green
 *   or a false red), surfaced loudly rather than merged. Mirrors
 *   `reconcileGrading`'s summary/expectations reconciliation (grading-adapter.ts).
 */
function assertToolVerdictConsistent(
  evalId: string,
  toolExpectations: RunGraderInput['toolExpectations'],
  tool: EvalFragment['tool'],
): void {
  if (toolExpectations !== undefined && tool === undefined) {
    throw new InternalHarnessError(
      `Grader for eval "${evalId}" was asked to judge declared tool expectations but returned no \`tool\` verdict in its fragment.`,
    );
  }
  if (tool !== undefined && computeToolPassed(tool) !== tool.passed) {
    throw new InternalHarnessError(
      `Grader for eval "${evalId}" emitted a tool verdict whose \`passed\` (${tool.passed}) ` +
        `disagrees with its own sub-checks (recomputed ${computeToolPassed(tool)}).`,
    );
  }
}
