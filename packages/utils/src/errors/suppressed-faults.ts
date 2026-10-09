/**
 * Faults raised while a failure was already being handled — a temporary
 * directory or a staged tree that would not go away after the work failed.
 *
 * The failure is rethrown UNCHANGED: never wrapped, never given a `cause`, never
 * mutated (it may be frozen, shared, or carry a classified fault of its own that
 * a cause walk must find first). The later fault is recorded beside it instead,
 * off the cause chain, so it can never pose as the failure's classification, and
 * a reporter reads it back with {@link suppressedFaultsOf} to name what was left.
 *
 * A reader walks the thrown value's cause chain (bounded, each error once), so a
 * record made on a failure survives a wrapper thrown in its place — a
 * rollback-incomplete error, a verb boundary's re-wrap. The walk only reads: it
 * never decides the failure's classification.
 *
 * The record is keyed by the error object in a `WeakMap` held under a
 * `Symbol.for` key on `globalThis`, so a `dist` copy and a `src` copy of this
 * module share one record (the reason `VatError` brands with `Symbol.for`).
 */

const REGISTRY_KEY = Symbol.for('vat.suppressed-faults');

/** Bound on the cause walk: a malformed chain must not hang an error path. */
const MAX_CAUSE_DEPTH = 10;

type Registry = WeakMap<object, unknown[]>;

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = holder[REGISTRY_KEY];
  if (existing !== undefined) return existing;
  const created: Registry = new WeakMap();
  holder[REGISTRY_KEY] = created;
  return created;
}

/**
 * Record `fault` as raised while `error` was being handled. A thrown value that is
 * not an object cannot carry a record: the fault is then a process warning, so it
 * is still never silent.
 */
export function recordSuppressedFault(error: unknown, fault: unknown): void {
  if (typeof error !== 'object' || error === null) {
    process.emitWarning(fault instanceof Error ? fault.message : String(fault), 'VatSuppressedFault');
    return;
  }
  const faults = registry().get(error);
  if (faults === undefined) registry().set(error, [fault]);
  else faults.push(fault);
}

/**
 * The faults recorded against `error`, and against every error on its cause chain,
 * while each was being handled — outermost error first, each one's oldest first —
 * each a leftover a report names as a warning. Empty when nothing was recorded.
 *
 * @param error - What a catch received
 */
export function suppressedFaultsOf(error: unknown): readonly unknown[] {
  const faults: unknown[] = [];
  const seen = new Set<object>();
  let link: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof link === 'object' && link !== null && !seen.has(link); depth++) {
    seen.add(link);
    faults.push(...(registry().get(link) ?? []));
    link = (link as { cause?: unknown }).cause;
  }
  return faults;
}
