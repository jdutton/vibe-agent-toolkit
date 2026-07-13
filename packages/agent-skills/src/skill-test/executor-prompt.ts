import { PromptInvariantError } from './prompt-invariants.js';

export interface BuildExecutorPromptOptions {
  /** The eval's `prompt` field, verbatim — the task the executor must perform. */
  task: string;
  /** Path to the staged subject (skill/plugin under test). */
  subjectPath: string;
  /** `<workspacesRoot>/<id>` when the eval declares input `files` — the project the executor should operate on. */
  workspaceDir?: string;
}

/**
 * Build the prompt handed to the blind executor subagent (issue #145 —
 * transcript-grounded eval rewrite). The executor is a real worker, not a
 * participant in an eval: it receives the task and its working context ONLY,
 * phrased exactly as a genuine user request. It must NEVER be told (directly
 * or by implication) that it is being tested, evaluated, or graded — that
 * knowledge would change its behavior and invalidate the eval.
 *
 * `subjectPath` is where the skill/plugin under test is staged (context the
 * executor's environment provides); `workspaceDir`, when the eval declares
 * input `files`, is the project the executor is actually meant to operate on.
 *
 * Pure function: same inputs always produce the same prompt.
 */
export function buildExecutorPrompt(opts: BuildExecutorPromptOptions): string {
  const lines = [opts.task, '', `The relevant files are located at ${opts.subjectPath}.`];
  if (opts.workspaceDir !== undefined) {
    lines.push(`Your working directory is ${opts.workspaceDir} — the project to operate on.`);
  }
  return lines.join('\n');
}

/**
 * Phrases that, if present in an executor prompt, would break the blind
 * setup by revealing to the executor that it is participating in an eval.
 * Kept intentionally tight: this is a denylist of known blinding-breakers,
 * not a general "sounds suspicious" heuristic, so it stays predictable for
 * prompt authors overriding the default.
 */
const BLINDING_BREAKERS = ['being tested', 'this is an eval', 'you are being evaluated', 'grading'];

/**
 * Invariants for the executor prompt. Two guarantees:
 *
 * 1. **Task-present**: `task` must be non-empty and appear verbatim in
 *    `prompt` — the executor is a real worker, so the adopter's task text
 *    must actually reach it.
 * 2. **No blinding-breaker in OUR scaffolding**: the denylist
 *    ({@link BLINDING_BREAKERS}) is scanned ONLY against the prompt's
 *    scaffolding — the prompt with the adopter's `task` text removed. The
 *    adopter's task is arbitrary and may legitimately contain words like
 *    "grading" or "you are being evaluated" (e.g. an essay-grading skill);
 *    policing it would be a false positive. The invariant's real job is to
 *    catch OUR builder accidentally telling the executor it is under test.
 *
 * Throws `PromptInvariantError` on violation.
 */
export function assertExecutorPromptInvariants(prompt: string, task: string): void {
  if (task.trim() === '') {
    throw new PromptInvariantError('must include the task text (task is empty)');
  }
  if (!prompt.includes(task)) {
    throw new PromptInvariantError('must include the task text (task not present in prompt)');
  }
  // Exclude the adopter task from the scan: only OUR scaffolding is policed.
  // A space join avoids fusing the surrounding words across the excised task.
  const scaffolding = prompt.split(task).join(' ').toLowerCase();
  for (const breaker of BLINDING_BREAKERS) {
    if (scaffolding.includes(breaker)) {
      throw new PromptInvariantError(
        `must not reveal to the executor that it is being tested/evaluated/graded (found "${breaker}")`,
      );
    }
  }
}
