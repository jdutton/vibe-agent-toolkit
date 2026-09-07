/**
 * Filter for the one `ExperimentalWarning` `node:sqlite` emits at load.
 *
 * ## Whose obligation this is, and why it lands here
 *
 * `@vibe-agent-toolkit/projection-sqlite` imports `node:sqlite`, which loads
 * without a flag from Node 22.13.0 — but **unflagged is not silent**: Node
 * still emits one `ExperimentalWarning` per process. That package deliberately
 * does not suppress it, and says why in its own header: a blanket
 * `NODE_NO_WARNINGS` would hide real ones. It assigns the work instead —
 * *"any caller that turns this backend on by default has to filter that one
 * warning by name at its own boundary."*
 *
 * The CLI is that caller. `openEphemeralQueryStore()` is the query lane's
 * fallback when no store is selected, which is the default, so a user running
 * `vat resources query` gets the warning on a perfectly ordinary run with no
 * way to silence it short of silencing everything.
 *
 * Measured on Node v24.13.1 against the built CLI, before this filter existed:
 *
 * | Command | `ExperimentalWarning`s printed |
 * |---|---|
 * | `vat resources query "SELECT …"` | **1** |
 * | `vat resources check`, no checks declared | **0** |
 *
 * ⚠️ That second row corrects a claim in `projection-store.ts`, which says
 * `node:sqlite` is required "on every default run of those two commands".
 * True of `query`; too strong for `check`, which never opens a store when the
 * project declares no checks for it to evaluate. The obligation is real either
 * way — it just fires on one command rather than two.
 *
 * ## Why the predicate is deliberately narrow
 *
 * The failure being avoided is not "a warning printed"; it is "a warning
 * suppressed that someone needed to see". So the match requires BOTH the
 * `ExperimentalWarning` type and SQLite's own message, and every near miss —
 * another experimental builtin, a `DeprecationWarning` that mentions SQLite, an
 * untyped string — is passed straight through. The test suite spends most of
 * its assertions on what this does *not* swallow, because that is the property
 * worth defending.
 *
 * ⛔ Do not widen this to "any ExperimentalWarning". The next experimental
 * builtin VAT starts loading is one a maintainer should be told about.
 */

/** Node's own text for the SQLite warning, matched as a substring. */
const SQLITE_WARNING_FRAGMENT = 'SQLite is an experimental feature';

/** The warning type Node tags it with. */
const EXPERIMENTAL_WARNING_NAME = 'ExperimentalWarning';

/**
 * Does this warning look like the `node:sqlite` load warning, and nothing else?
 *
 * @param warning - The warning value `process.emitWarning` was called with
 * @param type - The `type` argument, when the caller passed a bare string
 * @returns `true` only for SQLite's experimental-load warning
 */
export function isSqliteExperimentalWarning(warning: unknown, type?: unknown): boolean {
  const isError = warning instanceof Error;
  const name = isError ? warning.name : type;
  if (name !== EXPERIMENTAL_WARNING_NAME) return false;

  const message = isError ? warning.message : warning;
  return typeof message === 'string' && message.includes(SQLITE_WARNING_FRAGMENT);
}

/** Restores the emitter this filter replaced. */
export type RestoreWarningEmitter = () => void;

/** The shape of `process.emitWarning`, as this module calls it. */
type EmitWarning = (...args: unknown[]) => void;

/** Marks a function as one of this module's filters, so a chain can be walked. */
const FILTER_BRAND = Symbol('sqliteWarningFilter');

/**
 * An installed filter, holding a MUTABLE link to the emitter beneath it.
 *
 * 🪤 Mutable on purpose. Save-and-assign restore is correct only for LIFO
 * restores, and nothing makes callers restore in that order: with A installed,
 * then B, `restoreA()` used to write A's saved emitter straight back over B's
 * filter — removing B and leaving A's own filter orphaned in the chain, alive
 * for the life of the process, silently eating the one warning it was built to
 * hide. Splicing a node out of the chain instead is order-independent.
 */
interface FilterEmitter {
  (...args: unknown[]): void;
  /** The emitter this filter delegates to. */
  previous: EmitWarning;
  readonly [FILTER_BRAND]: true;
}

/** Is this one of our filters, rather than the host's own emitter? */
function isFilterEmitter(value: unknown): value is FilterEmitter {
  return typeof value === 'function' && FILTER_BRAND in value;
}

/**
 * Wrap `process.emitWarning` so SQLite's load warning is dropped and every
 * other warning is emitted unchanged.
 *
 * Patching the emitter is what makes this filter *by name*. The alternatives
 * are both worse: `NODE_NO_WARNINGS` is global and hides real warnings, and
 * replacing the `'warning'` listener means re-implementing Node's default
 * formatting, which then drifts from it silently.
 *
 * @param host - The process-like object to patch; injected so the behaviour is
 *   testable without mutating the real process
 * @returns A function restoring the previous emitter
 */
export function installSqliteWarningFilter(
  host: Pick<NodeJS.Process, 'emitWarning'> = process,
): RestoreWarningEmitter {
  const filtered = ((...args: unknown[]): void => {
    if (isSqliteExperimentalWarning(args[0], args[1])) return;
    // Read through the node, not through a captured local: `previous` is
    // rewritten when a filter below this one is spliced out.
    Reflect.apply(filtered.previous, host, args);
  }) as FilterEmitter;

  // Stored UNBOUND so chain identity survives — a `.bind()` here would make each
  // filter delegate to a fresh wrapper, and no restore could then recognise the
  // node it needs to splice out.
  filtered.previous = host.emitWarning as EmitWarning;
  Object.defineProperty(filtered, FILTER_BRAND, { value: true });

  host.emitWarning = filtered as unknown as NodeJS.Process['emitWarning'];

  return () => {
    removeFromChain(host, filtered);
  };
}

/**
 * Take one filter out of the emitter chain, wherever it currently sits.
 *
 * Doing nothing when the filter is already gone is the correct answer, not a
 * swallowed failure: a second `restore()` call, or a host whose emitter was
 * replaced wholesale by something else, both mean this filter is no longer
 * installed — which is exactly what the caller asked for.
 */
function removeFromChain(host: Pick<NodeJS.Process, 'emitWarning'>, filter: FilterEmitter): void {
  if ((host.emitWarning as unknown) === filter) {
    host.emitWarning = filter.previous as NodeJS.Process['emitWarning'];
    return;
  }

  let node: unknown = host.emitWarning;
  while (isFilterEmitter(node)) {
    if (node.previous === (filter as unknown as EmitWarning)) {
      node.previous = filter.previous;
      return;
    }
    node = node.previous;
  }
}
