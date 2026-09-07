/**
 * Unit tests for the `node:sqlite` ExperimentalWarning filter.
 *
 * `projection-sqlite` states the obligation and deliberately does not discharge
 * it itself: *"any caller that turns this backend on by default has to filter
 * that one warning by name at its own boundary, or every one of its invocations
 * prints it."* The CLI is that caller, so the CLI owes the filter.
 *
 * Measured on Node v24.13.1 before the filter existed:
 * - `vat resources query …` → **1** `ExperimentalWarning` on stderr, on the
 *   default path, with no way for a user to turn it off short of
 *   `NODE_NO_WARNINGS`, which would hide every other warning too.
 * - `vat resources check` with no checks declared → **0**. That command only
 *   reaches the store when it has at least one check to evaluate, so the
 *   docstring claim that `node:sqlite` loads on "every default run of those two
 *   commands" is true of `query` and too strong for `check`.
 *
 * 🔑 The predicate is narrow ON PURPOSE. A blanket suppression is the failure
 * mode being avoided, not the goal: the whole reason `projection-sqlite` refuses
 * to suppress the warning itself is that `NODE_NO_WARNINGS` hides real ones. So
 * the tests below spend most of their assertions proving what the filter does
 * NOT swallow.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  installSqliteWarningFilter,
  isSqliteExperimentalWarning,
} from '../src/utils/sqlite-experimental-warning.js';

/**
 * Stands in for `@vibe-agent-toolkit/projection-sqlite`, whose import of
 * `node:sqlite` is what emits the warning — at MODULE EVALUATION, which is the
 * moment `loadBackend()` has to have the filter installed for.
 *
 * The control warning alongside it is what keeps the wiring test below from
 * being vacuous: it proves the emitter was reachable and the module really
 * evaluated, so "nothing was printed" cannot pass because nothing ran.
 */
vi.mock('@vibe-agent-toolkit/projection-sqlite', () => {
  const sqlite = new Error('SQLite is an experimental feature and might change at any time');
  sqlite.name = 'ExperimentalWarning';
  const control = new Error('a control warning the filter must not swallow');
  control.name = 'ExperimentalWarning';

  process.emitWarning(sqlite);
  process.emitWarning(control);

  return {
    openEphemeralProjectionStore: (): unknown => ({ close: (): void => undefined }),
  };
});

/** The warning Node actually emits, verbatim from a real run on v24.13.1. */
const REAL_SQLITE_WARNING = 'SQLite is an experimental feature and might change at any time';

function experimental(message: string): Error {
  const warning = new Error(message);
  warning.name = 'ExperimentalWarning';
  return warning;
}

/** A host whose emitter is a spy, so what reached it can be asserted on. */
function trackedHost(): { host: NodeJS.Process; original: ReturnType<typeof vi.fn> } {
  const original = vi.fn();
  return { host: { emitWarning: original } as unknown as NodeJS.Process, original };
}

describe('isSqliteExperimentalWarning', () => {
  it('recognises the warning Node emits for node:sqlite', () => {
    expect(isSqliteExperimentalWarning(experimental(REAL_SQLITE_WARNING))).toBe(true);
  });

  it('recognises it when passed as a bare string with the type given separately', () => {
    expect(isSqliteExperimentalWarning(REAL_SQLITE_WARNING, 'ExperimentalWarning')).toBe(true);
  });

  it('does NOT swallow a different ExperimentalWarning', () => {
    expect(
      isSqliteExperimentalWarning(
        experimental('The Fetch API is an experimental feature. This feature could change at any time'),
      ),
    ).toBe(false);
  });

  it('does NOT swallow another experimental BUILTIN, which is the nearest miss', () => {
    expect(
      isSqliteExperimentalWarning(
        experimental('WASI is an experimental feature and might change at any time'),
      ),
    ).toBe(false);
  });

  it('does NOT swallow a non-experimental warning that happens to mention SQLite', () => {
    const deprecation = new Error(`${REAL_SQLITE_WARNING} — and is deprecated`);
    deprecation.name = 'DeprecationWarning';

    expect(isSqliteExperimentalWarning(deprecation)).toBe(false);
  });

  it('does NOT swallow a plain string warning with no type', () => {
    expect(isSqliteExperimentalWarning(REAL_SQLITE_WARNING)).toBe(false);
  });
});

describe('installSqliteWarningFilter', () => {
  it('drops the SQLite warning and leaves every other warning emitted', () => {
    const emitted: unknown[] = [];
    const original = vi.fn((warning: unknown) => {
      emitted.push(warning);
    });
    const host = { emitWarning: original } as unknown as NodeJS.Process;

    const restore = installSqliteWarningFilter(host);

    host.emitWarning(experimental(REAL_SQLITE_WARNING));
    host.emitWarning(experimental('The Fetch API is an experimental feature'));
    host.emitWarning(new Error('something else entirely'));

    restore();

    expect(emitted).toHaveLength(2);
    expect((emitted[0] as Error).message).toContain('Fetch API');
    expect((emitted[1] as Error).message).toBe('something else entirely');
  });

  it('restores the original emitter, so the filter is not permanent', () => {
    const original = vi.fn();
    const host = { emitWarning: original } as unknown as NodeJS.Process;

    const restore = installSqliteWarningFilter(host);
    expect(host.emitWarning).not.toBe(original);

    restore();
    expect(host.emitWarning).toBe(original);
  });

  it('is idempotent — installing twice still restores cleanly to the original', () => {
    const original = vi.fn();
    const host = { emitWarning: original } as unknown as NodeJS.Process;

    const restoreOuter = installSqliteWarningFilter(host);
    const restoreInner = installSqliteWarningFilter(host);

    restoreInner();
    restoreOuter();

    expect(host.emitWarning).toBe(original);
  });

  /**
   * 🪤 The test above restores inner-then-outer, which is the order that works.
   * The REVERSE order was unasserted and broken: save/restore by raw assignment
   * means the outer restore writes back an emitter that is no longer current,
   * and the inner filter is then installed forever.
   *
   * Executed against the previous implementation — A installs, B installs, A
   * restores, B restores — `host.emitWarning === original` was **false**, and
   * SQLite's warning stayed swallowed for the life of the process. Latent in
   * VAT today (instrumenting the real command shows one install at a time), but
   * this is an exported utility whose contract is "restored immediately
   * afterwards", and the call site's docstring says so in as many words.
   */
  describe('restoring out of LIFO order', () => {
    it('leaves NO filter behind when the outer install is restored first', () => {
      const { host, original } = trackedHost();

      const restoreA = installSqliteWarningFilter(host);
      const restoreB = installSqliteWarningFilter(host);

      restoreA();
      restoreB();

      expect(host.emitWarning).toBe(original);
    });

    it('stops swallowing the SQLite warning once both are restored', () => {
      const { host, original } = trackedHost();

      const restoreA = installSqliteWarningFilter(host);
      const restoreB = installSqliteWarningFilter(host);
      restoreA();
      restoreB();

      host.emitWarning(experimental(REAL_SQLITE_WARNING));

      // The property that actually matters: a leaked filter is invisible until
      // someone needed the warning it ate.
      expect(original).toHaveBeenCalledTimes(1);
    });

    it('keeps the still-installed filter working after the other one is removed', () => {
      const { host, original } = trackedHost();

      const restoreA = installSqliteWarningFilter(host);
      installSqliteWarningFilter(host);
      restoreA();

      host.emitWarning(experimental(REAL_SQLITE_WARNING));
      host.emitWarning(experimental('The Fetch API is an experimental feature'));

      expect(original).toHaveBeenCalledTimes(1);
      expect((original.mock.calls[0]?.[0] as Error).message).toContain('Fetch API');
    });

    /**
     * The case the chain walk CANNOT splice: a foreign wrapper installed above
     * us that delegates rather than replaces.
     *
     * An APM shim, another library's warning filter, an unrestored test spy —
     * none of them carry `FILTER_BRAND`, so the walk stops at the first one and
     * finds nothing to splice. Splicing through it is not possible: the foreign
     * wrapper holds its reference to the emitter beneath it in a closure, which
     * nothing outside it can rewrite.
     *
     * So `restore()` cannot remove the node — and must therefore make it inert.
     * The harm is not "the node is still in the chain"; it is that a filter
     * nobody can reach goes on eating the warning it was installed to hide, for
     * the life of the process. The docstring used to justify the no-op with a
     * host whose emitter was "replaced wholesale", which is a genuinely
     * different case (nothing reaches our filter at all, so it eats nothing).
     */
    it('stops filtering when a foreign delegating wrapper blocks the splice', () => {
      const { host, original } = trackedHost();

      const restore = installSqliteWarningFilter(host);
      const ours = host.emitWarning;

      // Installed AFTER us, delegating, unbranded — the shape the walk cannot
      // see past, and whose link to `ours` lives in a closure nothing can rewrite.
      const foreign = vi.fn((...args: unknown[]) => {
        Reflect.apply(ours, host, args);
      });
      host.emitWarning = foreign as unknown as NodeJS.Process['emitWarning'];

      restore();

      host.emitWarning(experimental(REAL_SQLITE_WARNING));

      expect(foreign).toHaveBeenCalledTimes(1);
      expect(original).toHaveBeenCalledTimes(1);
    });

    it('still filters while installed under a foreign delegating wrapper', () => {
      // The negative control for the case above: neutering must happen on
      // `restore()`, not on merely being wrapped.
      const { host, original } = trackedHost();

      installSqliteWarningFilter(host);
      const ours = host.emitWarning;
      host.emitWarning = ((...args: unknown[]) => {
        Reflect.apply(ours, host, args);
      }) as unknown as NodeJS.Process['emitWarning'];

      host.emitWarning(experimental(REAL_SQLITE_WARNING));

      expect(original).not.toHaveBeenCalled();
    });

    it('is safe to call a restore twice', () => {
      const { host, original } = trackedHost();

      const restore = installSqliteWarningFilter(host);
      restore();
      restore();

      expect(host.emitWarning).toBe(original);
    });
  });

  it('forwards the extra arguments Node passes alongside a warning', () => {
    const original = vi.fn();
    const host = { emitWarning: original } as unknown as NodeJS.Process;

    const restore = installSqliteWarningFilter(host);
    host.emitWarning('a message', 'CustomWarning', 'CODE_X');
    restore();

    expect(original).toHaveBeenCalledWith('a message', 'CustomWarning', 'CODE_X');
  });
});

/**
 * The predicate above is pinned beautifully and pinned ALONE.
 *
 * Measured: mutating `projection-store.ts` so the filter is never installed —
 * `const restoreWarnings = ((): void => undefined);` — left 10 of 10 tests in
 * this file passing, and `grep -rln "openEphemeralQueryStore" packages/cli/test`
 * returned nothing. Every assertion was about a pure function, and the product
 * claim ("`vat resources query` stops printing the ExperimentalWarning") rested
 * entirely on a call site no test reached. Deleting that call site was free.
 *
 * So this suite drives the real lane. The mocked backend emits its warning at
 * MODULE EVALUATION, exactly as `node:sqlite` does — which is the only moment
 * the filter has to be installed for, and the reason `loadBackend()` wraps the
 * `import()` rather than the query.
 */
describe('the query lane installs the filter where the backend loads', () => {
  it("swallows node:sqlite's load warning and restores the emitter afterwards", async () => {
    const emitted: unknown[] = [];
    const spy = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(((warning: unknown): void => {
        emitted.push(warning);
      }) as typeof process.emitWarning);

    try {
      const { openEphemeralQueryStore } = await import('../src/utils/projection-store.js');
      await openEphemeralQueryStore();

      // Not vacuous: the control warning proves the spy was reachable and the
      // module really evaluated. An empty `emitted` would pass a "nothing was
      // printed" assertion for the wrong reason.
      expect(emitted).toHaveLength(1);
      expect((emitted[0] as Error).message).toContain('a control warning');

      // "Restored immediately afterwards" is a claim `projection-store.ts` makes
      // in prose; this is the only thing checking it.
      expect(process.emitWarning).toBe(spy);
    } finally {
      spy.mockRestore();
    }
  });
});
