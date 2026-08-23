import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { mkdirSyncReal, parseStreamJsonTranscript, safePath, spawnHeadlessClaude } from '@vibe-agent-toolkit/utils';

import { EvalFragmentError, parseEvalFragment, type EvalFragment } from './eval-fragment.js';
import type { ToolExpectations } from './eval-inputs.js';
import { InternalHarnessError } from './exit-codes.js';
import { assertGraderPromptInvariants, buildGraderPrompt } from './grader-prompt.js';
import { sanitizeGraderText } from './grader-text.js';
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
  // 0700, like every other vat-only directory this codebase creates (the grader
  // root in `resolveGraderOutDir`, the workspaces root and every eval workspace in
  // `stageEvalWorkspaces`). This is the per-ARM subdirectory of an already-0700
  // parent, so nothing is exposed today — traversal into it is blocked one level
  // up. It is made explicit because the rule is only worth anything while it is
  // uniform: an unmoded `mkdir` here is the one place a reader would have to prove
  // the parent's mode to know the fragment (which echoes the run's integrity nonce)
  // is unreadable, and the day this dir is created somewhere else that proof is
  // gone. Fragments are consumed-on-read anyway; this is the resting-state half.
  mkdirSyncReal(input.graderOutDir, { recursive: true, mode: 0o700 });

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
  // (STOP, fragment path, browser/iteration forbids, nonce directive, and the
  // untrusted-data fences) before spawning, so a regressed buildGraderPrompt is
  // caught here, not by a grader that silently misbehaves. The nonce is handed
  // over so the assertion can cut out every fenced region — transcript, subject
  // manifest, and the suite's own expectations/expected_output — and none of
  // that attacker-controlled text can satisfy an invariant on the builder's
  // behalf.
  assertGraderPromptInvariants(prompt, input.nonce);

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

  assertExpectationCountDeclared(input.evalId, input.expectations, fragment.expectations);
  assertToolVerdictConsistent(input.evalId, input.toolExpectations, fragment.tool);

  // The grader's only input is the executor transcript, which untrusted skill code
  // controls, and `evalId` is schema-typed as any non-empty string. It is echoed
  // verbatim into the run summary and into `baseline.json` — including the
  // CONTAMINATED banner — so a grader talked into emitting an id containing
  // newlines and ANSI escapes can paint a reassuring "known false positive, the
  // delta is valid" line directly beneath vat's own warning. VAT knows which eval
  // it asked about; take the id from the request, never from the answer.
  return { ...fragment, evalId: input.evalId };
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
    // V8 embeds a VERBATIM slice of the offending bytes in its SyntaxError
    // message, unescaped — and this is one of the few grader-controlled strings
    // that reaches an operator WITHOUT passing `parseEvalFragment`, the
    // documented text boundary, because the parse it would have gone through is
    // the one that just failed. The CLI writes it as `Error: ${err.message}`, so
    // an unsanitized fragment of `ESC[2K CR ESC[32m…` wipes the line vat just
    // printed and continues in vat's own colour (and a <=16-byte file gets its
    // whole `ESC[2J ESC[H` echoed, clearing the screen).
    throw new EvalFragmentError(
      `grader fragment for eval "${evalId}" at ${fragmentOut} is not valid JSON: ` +
        sanitizeGraderText(err instanceof Error ? err.message : String(err)),
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
 * The OUTPUT channel's declared-vs-reported check — the exact thing
 * {@link assertToolCheckNamesDeclared} does for the TOOL channel, applied to the
 * channel every reported number is computed from.
 *
 * Each arm's `summary`, the pass/fail verdict `reconcileGrading` produces, and
 * the `--baseline` delta between the arms are all computed over
 * `fragment.expectations` — i.e. over however many entries the grader chose to
 * write. The prompt ASKS for "one per expectation above" and, until this check,
 * nothing verified it:
 *
 * - **Omission laundered a pass, on EVERY run.** A grader that skips a FAILING
 *   expectation leaves a fragment where the survivors all passed, so
 *   `reconcileGrading` reports `allPassed: true` and the run exits 0.
 * - **Invention inflated the delta.** A suite declaring 1 expectation whose two
 *   graders each emit 3 of their own yields `Baseline delta: +3` where the
 *   maximum legal lift is +1.
 *
 * The existing `armExpectationSkew` cannot see either: it compares the two ARMS
 * to each other, and both graders receive the same declared list from the same
 * template, so they drift together and parity holds while a confident wrong
 * number prints.
 *
 * COUNT, not text. The grader is asked to echo each expectation's `text`, but it
 * routinely reworks the wording, and a reworded text is not a wrong verdict —
 * whereas a missing or extra ENTRY always is, because the entry is the unit
 * every score counts.
 *
 * Fail-closed like its siblings below: this is vat's own grading infrastructure
 * failing its one job, not adopter data being audited.
 *
 * FAIL-CLOSED IS NOT FAIL-THE-RUN, and the distinction is the caller's to make, not
 * this function's. Throwing here is unconditional and stays that way: a fragment
 * whose entry count does not match the declaration is not a verdict, and returning
 * it "leniently" for the control arm would put an unchecked number straight into the
 * delta — which is the hole this check was added to close. What changed is where the
 * throw lands. `runEvalWorker` (run-harness.ts) catches a CONTROL-arm throw, records
 * it as a control-arm failure, and lets the run finish; a TREATMENT-arm throw still
 * propagates and fails the run. So a control-arm grader miscount now withholds the
 * delta as `null` with the reason attached, instead of destroying fully-billed
 * treatment work that was never in doubt. Do not soften this assert to get that
 * behaviour — it is already there, one level up, where the arm is known.
 */
function assertExpectationCountDeclared(
  evalId: string,
  declared: readonly string[],
  reported: EvalFragment['expectations'],
): void {
  if (reported.length === declared.length) return;
  throw new InternalHarnessError(
    `Grader for eval "${evalId}" returned ${reported.length} expectation entr${reported.length === 1 ? 'y' : 'ies'} ` +
      `for an eval that declares ${declared.length}. Every score vat reports — each arm's summary and the ` +
      `--baseline delta between them — is computed over the entries the grader emitted, so an invented or ` +
      `omitted entry silently changes it.`,
  );
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
 * - Fix #4: the check NAMES must be exactly the eval's declared ones. See
 *   {@link assertToolCheckNamesDeclared}.
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
  assertToolCheckNamesDeclared(evalId, toolExpectations, tool);
}

/** Render grader-supplied names for an error message, already sanitized by the fragment parse. */
function quoteNames(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(', ');
}

/**
 * One channel's check names must be EXACTLY the declared ones — no invention,
 * no omission.
 *
 * `computeToolPassed` iterates the checks the GRADER emitted, not the ones the
 * eval declared, so both directions are load-bearing and neither is cosmetic:
 *
 * - **Omission laundered a pass.** Drop the `mustRun` entry for an executable
 *   that never ran and the channel is vacuously true — the verdict reads
 *   `passed: true` for an expectation nobody checked.
 * - **Invention gates on a name vat never asked about.** A grader talked into
 *   emitting `{name: "totally-fine", ran: true}` adds a check the eval does not
 *   declare, and it counts toward the verdict exactly like a real one.
 *
 * Names are compared AFTER {@link sanitizeGraderText} on both sides. The
 * reported side is already sanitized (parseEvalFragment); normalizing the
 * declared side too means the comparison happens in one space, so an adopter
 * who declared a name containing a tab does not get an unexplainable mismatch.
 *
 * Fail-closed like its siblings above: this is vat's own grading infrastructure
 * failing to do its one job, not adopter data being audited.
 */
function assertToolCheckNamesDeclared(
  evalId: string,
  toolExpectations: RunGraderInput['toolExpectations'],
  tool: EvalFragment['tool'],
): void {
  if (tool === undefined) return;
  const declared = toolExpectations ?? {};
  assertChannelNames(evalId, 'mustRun', declared.mustRun, (tool.mustRun ?? []).map((c) => c.name));
  assertChannelNames(evalId, 'mustNotRun', declared.mustNotRun, (tool.mustNotRun ?? []).map((c) => c.name));
  assertChannelNames(evalId, 'mustSucceed', declared.mustSucceed, (tool.mustSucceed ?? []).map((c) => c.name));
  assertChannelNames(evalId, 'sequence', declared.sequence, (tool.sequence ?? []).flatMap((c) => c.steps));
}

function assertChannelNames(
  evalId: string,
  channel: string,
  declared: readonly string[] | undefined,
  reported: readonly string[],
): void {
  const declaredSet = new Set((declared ?? []).map(sanitizeGraderText));
  const reportedSet = new Set(reported);
  const invented = [...reportedSet].filter((name) => !declaredSet.has(name));
  const missing = [...declaredSet].filter((name) => !reportedSet.has(name));
  if (invented.length === 0 && missing.length === 0) return;
  const problems: string[] = [];
  if (invented.length > 0) problems.push(`invented ${quoteNames(invented)}`);
  if (missing.length > 0) problems.push(`omitted ${quoteNames(missing)}`);
  throw new InternalHarnessError(
    `Grader for eval "${evalId}" emitted \`tool.${channel}\` checks that do not match the eval's ` +
      `declared toolExpectations: ${problems.join('; ')}. The verdict is computed from the checks the ` +
      `grader emitted, so an invented or omitted name silently changes it.`,
  );
}
