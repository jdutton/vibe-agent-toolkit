import {
  parseStreamJsonTranscript,
  spawnHeadlessClaude,
  type ParsedTranscript,
  type SpawnResult,
} from '@vibe-agent-toolkit/utils';

import { assertExecutorPromptInvariants, buildExecutorPrompt } from './executor-prompt.js';
import { InternalHarnessError } from './exit-codes.js';
import { RateLimitSignal } from './pipeline.js';

export interface RunExecutorInput {
  evalId: string;
  task: string;
  /**
   * Absolute staged subject dir, named in the prompt so the executor can find
   * the files it is meant to work with. OMITTED for the skill-absent (WITHOUT)
   * arm of a `--baseline` run — see {@link import('./executor-prompt.js').BuildExecutorPromptOptions}.
   */
  subjectStagedDir?: string;
  /**
   * `<workspacesRoot>/<id>` — ALWAYS present, and empty when the eval declares
   * no input `files`. It used to be absent in that case, which made the executor
   * fall back to running IN the staged subject dir: for the skill-absent arm that
   * put the control's cwd inside the skill it was supposed to be denied. Both arms
   * now get the same per-eval workspace, so cwd is never a confound.
   */
  workspaceDir: string;
  pluginDirs: string[];
  env: NodeJS.ProcessEnv;
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  stallMs?: number;
  /** Injectable seam for tests; defaults to the real {@link spawnHeadlessClaude}. */
  spawn?: typeof spawnHeadlessClaude;
  /** Called with each stdout chunk as it streams (for progress echo). */
  onProgress?: (chunk: string) => void;
}

export interface ExecutorOutcome {
  /** Full captured stdout (stream-json), held IN MEMORY only — never written to disk. */
  transcript: string;
  parsed: ParsedTranscript;
  spawnResult: SpawnResult;
  /** true = the executor exited non-zero WITHIN budget — a valid eval failure, not a harness break. */
  cleanFailure: boolean;
}

/**
 * Run ONE eval's executor: a blind `claude -p` spawn that performs `task`
 * against the staged subject (issue #145). The executor's entire stream-json
 * stdout is accumulated in memory (never written to a skill-writable disk
 * path — the "stop discarding stdout" fix) and echoed to `onProgress` chunk
 * by chunk for visibility.
 *
 * Encodes the R1 exit bifurcation at the executor boundary:
 * - A spawn error (the promise rejects), or our own watchdog firing
 *   (`timedOut`/`stalled`), is HARNESS breakage → thrown as
 *   {@link InternalHarnessError} (exit 1).
 * - A mid-stream rate-limit that cuts the run off before it completes (status
 *   !== 0) is NOT a harness failure but also not gradeable → thrown as
 *   {@link RateLimitSignal} so the caller's pool can back off and retry this
 *   eval. A rate-limit event that the run still completed past (status 0) is
 *   kept and returned normally.
 * - Anything else — including a clean non-zero exit within budget — is a
 *   valid eval OUTCOME, not a harness break: returned with `cleanFailure`
 *   reflecting whether the executor exited non-zero. Never laundered into a
 *   thrown error; the grader decides whether the transcript passes.
 */
export async function runExecutorForEval(input: RunExecutorInput): Promise<ExecutorOutcome> {
  const workDir = input.workspaceDir;
  const prompt = buildExecutorPrompt({
    task: input.task,
    ...(input.subjectStagedDir === undefined ? {} : { subjectPath: input.subjectStagedDir }),
    workspaceDir: input.workspaceDir,
  });
  // Defense-in-depth (parity with run-harness's build→assert→use pattern):
  // re-verify the built prompt didn't accidentally blind-break the executor
  // before spawning. Only OUR scaffolding is policed — the adopter task is
  // excluded, so a legit task containing denylist words does not trip this.
  assertExecutorPromptInvariants(prompt, input.task);

  const spawn = input.spawn ?? spawnHeadlessClaude;

  let transcript = '';
  const onStdout = (chunk: string): void => {
    transcript += chunk;
    input.onProgress?.(chunk);
  };

  let spawnResult: SpawnResult;
  try {
    spawnResult = await spawn({
      prompt,
      pluginDirs: input.pluginDirs,
      sandboxDir: workDir,
      cwd: workDir,
      env: input.env,
      timeoutMs: input.timeoutMs,
      onStdout,
      maxTurns: input.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.stallMs === undefined ? {} : { stallMs: input.stallMs }),
    });
  } catch (err) {
    throw new InternalHarnessError(
      `Executor spawn failed for eval "${input.evalId}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Watchdog kills (our own harness code, not the executor) are harness
  // breakage regardless of what the executor produced before being killed.
  if (spawnResult.stalled) {
    throw new InternalHarnessError(
      `Executor stalled for eval "${input.evalId}" (no output for ${input.stallMs ?? 0}ms).`,
    );
  }
  if (spawnResult.timedOut) {
    throw new InternalHarnessError(
      `Executor timed out for eval "${input.evalId}" (limit ${input.timeoutMs}ms).`,
    );
  }

  const parsed = parseStreamJsonTranscript(transcript);

  // A rate-limit that cut the run off before completion (non-zero status) is
  // not gradeable — signal the pool to back off and retry. A rate-limit event
  // the run otherwise completed past (status 0) is kept as-is.
  if (parsed.rateLimited && spawnResult.status !== 0) {
    throw new RateLimitSignal(`Executor rate-limited for eval "${input.evalId}".`);
  }

  return {
    transcript,
    parsed,
    spawnResult,
    cleanFailure: spawnResult.status !== 0,
  };
}
