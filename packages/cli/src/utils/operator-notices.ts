/**
 * The ONE route for a notice addressed to the operator — a config-loader warning, a projection-store
 * notice — and the ONE switch that decides whether this process is the operator's to speak to.
 *
 * ## 🔑 A supervised child prints no notices; the invoked process prints each once
 *
 * `vat resources check` runs its checks in a supervised CHILD (`--cost-log`), and `vat validate`
 * runs that same child as its `checks` phase. The child reads the same config and keys the same
 * store as the process that spawned it, and its stderr is inherited — so every notice the child
 * printed was a second copy of one its parent had already printed (or, for the store notice, owes):
 * an unknown config key warned twice for one run.
 *
 * So the audience is decided once, by the one fact that says "you are the child": the progress log
 * a supervisor handed over. `createProgressWriter` — the only way the child gets the sink it reports
 * through — calls {@link becomeSupervisedChild}, so a child cannot report progress and still speak
 * to the operator. The invoked process (a standalone `vat resources check`, `--budget 0`, or the
 * orchestrator) is the one that prints.
 *
 * ⚠️ Only NOTICES go through here: news that does not change what the run decides. A refusal's
 * message, and anything that explains the document the child publishes, is the child's to print.
 */

let supervisedChild = false;

/**
 * Write one notice to the operator's stderr — unless this process is a supervised child, whose
 * invoking process prints the notice itself.
 *
 * @param message - The notice, without a trailing newline
 */
export function noticeToOperator(message: string): void {
  if (supervisedChild) return;
  process.stderr.write(`${message}\n`);
}

/**
 * Mark this process as a supervised child: from here on {@link noticeToOperator} is silent. Called
 * by the progress writer, never by a command directly.
 */
export function becomeSupervisedChild(): void {
  supervisedChild = true;
}

/** Test-facing seam: restore the invoked-process audience between in-process cases. */
export const __testing = {
  reset(): void {
    supervisedChild = false;
  },
};
