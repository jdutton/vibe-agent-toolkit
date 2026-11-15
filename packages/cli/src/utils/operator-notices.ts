/**
 * The ONE route for a notice addressed to the operator — a config-loader warning, a projection-store
 * notice — and the ONE predicate that says whether this process is a supervised checks child.
 *
 * ## 🔑 Each notice prints once per run, from the process that owes it
 *
 * `vat resources check` runs its checks in a supervised CHILD (`--supervised-by`), and `vat validate`
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
 * ## 🔑 "Once" belongs to the same scope
 *
 * A notice that would repeat — one config governing many skills, one unkeyable root asked about by
 * every nested population scope — carries a `once` key, and the ledger that remembers it lives in
 * the SAME scope as the audience: {@link withNoticeAudience} starts a fresh one, and so does the
 * outermost population scope ({@link withNoticeLedger}) — starting from what was printed before it,
 * so a config loaded both before and inside it warns once — so a second command in one process
 * says it again. There is one ledger mechanism, not one per notice kind. Outside every scope (a config
 * loaded before any population, a unit test) the ledger is the process's own, reset with the config
 * cache ({@link resetUnscopedNoticeLedger}).
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

/** One notice scope: who it prints for, and which `once` notices it has already printed. */
interface NoticeScope {
  readonly audience: NoticeAudience;
  readonly printed: Set<string>;
}

const noticeScope = new AsyncLocalStorage<NoticeScope>();

/** The `once` ledger outside every scope. */
const unscopedPrinted = new Set<string>();

/**
 * Is this process the child a supervisor spawned to run the checks?
 *
 * 🔑 The ONE predicate, read from the explicit argv: `--supervised-by` is what a supervisor hands
 * its child and nothing else passes (the child refuses it unless its parent is the supervisor the
 * value names). Every decision that turns on "am I the child" asks this — which process runs the
 * checks, which prints the "no checks of its own" warning, which notices it owes.
 *
 * @param argv - The command's parsed options
 * @param argv.supervisedBy - The hidden `--supervised-by` value, or undefined
 * @returns True in the supervised child
 */
export function isSupervisedChild<T extends { readonly supervisedBy: string | undefined }>(
  argv: T,
): argv is T & { readonly supervisedBy: string } {
  return argv.supervisedBy !== undefined;
}

/**
 * Run `work` with `audience` deciding which notices this process prints, and a fresh `once` ledger.
 *
 * @param audience - Which notices to print
 * @param work - The command's run
 * @returns Whatever `work` returned
 */
export function withNoticeAudience<T>(audience: NoticeAudience, work: () => T): T {
  return noticeScope.run({ audience, printed: new Set() }, work);
}

/**
 * Run `work` inside a notice scope: the enclosing one when there is one, else a fresh scope that
 * prints every notice — so `once` means once per command run, never once per process.
 *
 * 🚨 The fresh scope STARTS from what was already printed outside every scope, and copies it: a
 * command loads its config before it opens its population scope (`vat validate`, to choose its
 * phases) and again inside it, so a scope starting empty printed that config warning twice for one
 * run. A copy, not the set itself, so what the scope prints stays its own and the next run says it
 * again.
 *
 * @param work - The run
 * @returns Whatever `work` returned
 */
export function withNoticeLedger<T>(work: () => T): T {
  return noticeScope.getStore() === undefined
    ? noticeScope.run({ audience: EVERY_NOTICE, printed: new Set(unscopedPrinted) }, work)
    : work();
}

/** Forget the `once` notices printed outside every scope — with the config cache they describe. */
export function resetUnscopedNoticeLedger(): void {
  unscopedPrinted.clear();
}

/**
 * Write one notice to the operator's stderr — unless the enclosing scope says another process owes
 * it, or it carries a `once` key this scope has already printed.
 *
 * @param kind - What the notice is about
 * @param message - The notice, without a trailing newline
 * @param once - When set, print this notice at most once per scope for this key
 */
export function noticeToOperator(kind: NoticeKind, message: string, once?: string): void {
  const scope = noticeScope.getStore();
  if (!(scope?.audience ?? EVERY_NOTICE)[kind]) return;
  if (once !== undefined) {
    const printed = scope?.printed ?? unscopedPrinted;
    const key = `${kind}:${once}`;
    if (printed.has(key)) return;
    printed.add(key);
  }
  process.stderr.write(`${message}\n`);
}
