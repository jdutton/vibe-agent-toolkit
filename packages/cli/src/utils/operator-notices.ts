/**
 * The ONE route for a notice addressed to the operator — a config-loader warning, a projection-store
 * notice — and the ONE predicate that says whether this process is a supervised checks child.
 *
 * ## 🔑 Each notice prints once per run, from the process that owes it
 *
 * `vat resources check` runs its checks in a supervised CHILD (`--cost-log`), and `vat validate`
 * runs that same child as its `checks` phase. The child reads the same config and keys the same
 * store as the process that spawned it, and its stderr is inherited — so a notice both printed was
 * printed twice for one run.
 *
 * Who owes what:
 *
 * - **A config warning** — the invoking process. It loads the config itself in both invocations
 *   (`vat validate` to choose its phases, a standalone `vat resources check` to say whether the
 *   project declares checks of its own), so a supervised child never prints one.
 * - **The store notice** — whichever process keys the store first. `vat validate` opens its store
 *   scope before any phase runs, so a child started as its phase stays quiet; a standalone
 *   `vat resources check` opens no store at all — keying one is a git snapshot, unbounded work a
 *   supervisor must not do before its watchdog exists — so the child it started prints it.
 *
 * The audience is decided ONCE, at the command's entry, from its explicit argv
 * ({@link isSupervisedChild}), and entered as a scope ({@link withNoticeAudience}) the command's
 * whole run sits inside. Nothing sets it as a side effect, and it ends with the scope — so a unit
 * test, or a second command in one process, starts from "print everything".
 *
 * ⚠️ Only NOTICES go through here: news that does not change what the run decides. A refusal's
 * message, and anything that explains the document the child publishes, is the child's to print.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** What a notice is about — which decides which process owes it. */
export type NoticeKind = 'config' | 'store';

/** Which notices this process prints. Outside any scope, every one. */
export type NoticeAudience = Readonly<Record<NoticeKind, boolean>>;

/** Every notice — the audience of any process that is not a supervised child. */
export const EVERY_NOTICE: NoticeAudience = { config: true, store: true };

const audienceScope = new AsyncLocalStorage<NoticeAudience>();

/**
 * Is this process the child a supervisor spawned to run the checks?
 *
 * 🔑 The ONE predicate, read from the explicit argv: `--cost-log` is what a supervisor hands its
 * child and nothing else passes. Every decision that turns on "am I the child" asks this — which
 * process runs the checks, which prints the "no checks of its own" warning, which notices it owes.
 *
 * @param argv - The command's parsed options
 * @param argv.costLog - The hidden `--cost-log` value, or undefined
 * @returns True in the supervised child
 */
export function isSupervisedChild(argv: { readonly costLog: string | undefined }): boolean {
  return argv.costLog !== undefined;
}

/**
 * Run `work` with `audience` deciding which notices this process prints.
 *
 * @param audience - Which notices to print
 * @param work - The command's run
 * @returns Whatever `work` returned
 */
export function withNoticeAudience<T>(audience: NoticeAudience, work: () => T): T {
  return audienceScope.run(audience, work);
}

/**
 * Write one notice to the operator's stderr — unless the enclosing scope says another process owes
 * it.
 *
 * @param kind - What the notice is about
 * @param message - The notice, without a trailing newline
 */
export function noticeToOperator(kind: NoticeKind, message: string): void {
  if (!(audienceScope.getStore() ?? EVERY_NOTICE)[kind]) return;
  process.stderr.write(`${message}\n`);
}
