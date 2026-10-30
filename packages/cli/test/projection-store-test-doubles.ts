/**
 * Shared doubles for the `projection-store` suites — the unit file
 * (`test/utils/projection-store.test.ts`) and the real-git integration file
 * (`test/integration/projection-store-git.integration.test.ts`).
 *
 * Each suite registers the backend mock itself (`vi.mock` is per file), with a
 * factory that imports THIS module and returns `backend.moduleExports()`. The
 * factory and the test's own static import resolve to one module instance, so
 * the state a test inspects is the state the mocked backend wrote.
 *
 * Deliberately free of any import of `src/utils/projection-store.js` or
 * `@vibe-agent-toolkit/projection-sqlite`: the mock factory loads this module,
 * and a module that loaded the subject from inside the subject's own mock
 * factory would be a cycle.
 */

import { detachGitEnv } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, vi } from 'vitest';

/** A read-only window onto one fake store's lifetime. */
interface FakeStoreHandle {
  /**
   * How many times `close()` reached the store.
   *
   * Counted rather than merely flagged: the real backend promises close is
   * idempotent, which means a double-close in the subject would leave no trace
   * anywhere else.
   */
  readonly closeCount: () => number;
  /** Whether the connection is still usable — what "the store outlived the frame that built the source" actually means. */
  readonly isOpen: () => boolean;
}

interface StoreRecord {
  closeCount: number;
  closed: boolean;
}

const stores: StoreRecord[] = [];

/**
 * 🪤 A closed fake REJECTS every later call rather than quietly succeeding.
 * That mirrors the real contract ("a store that has been closed rejects further
 * calls rather than silently reopening — a reopen would hide a lifetime bug in
 * the caller"), and without it the "still usable later" test could not fail: a
 * permissive fake answers a closed store's reads happily and the lifetime bug
 * it exists to catch would sail through green.
 */
function makeStore(): unknown {
  const record: StoreRecord = { closeCount: 0, closed: false };
  stores.push(record);
  const refuseIfClosed = (): void => {
    if (record.closed) throw new Error('store is closed');
  };
  // Run inside a promise executor so a refusal arrives as a REJECTION, as it
  // would from the real async backend, rather than as a synchronous throw.
  const guarded = <T>(value: T) => (): Promise<T> =>
    new Promise((resolve) => {
      refuseIfClosed();
      resolve(value);
    });
  return {
    writeBlobFacts: guarded(undefined),
    readBlobFacts: guarded({}),
    writeExtent: guarded(undefined),
    readExtent: guarded(undefined),
    close: () => {
      record.closeCount += 1;
      record.closed = true;
      return Promise.resolve();
    },
  };
}

// `options` records the ARGUMENT, not just the count. Without it every
// assertion passes for a build that dropped the `directory` argument entirely —
// and such a build silently writes the developer's own live cache, which is
// exactly what `VAT_PROJECTION_STORE_DIR` exists to prevent. The count alone
// cannot see that.
const openCalls = { count: 0, options: [] as unknown[] };

/** The mock backend, and the state the tests inspect it through. */
export const backend = {
  stores,
  openCalls,
  /** The module namespace a `vi.mock('@vibe-agent-toolkit/projection-sqlite', …)` factory returns. */
  moduleExports: (): Record<string, unknown> => ({
    openSqliteProjectionStore: (options: unknown) => {
      openCalls.count += 1;
      openCalls.options.push(options);
      return makeStore();
    },
  }),
};

/**
 * The most recently opened fake store, as a lifetime handle.
 *
 * Throws rather than returning `undefined` when nothing was opened: a test that
 * expected a store and got none must fail on that fact, not slide into
 * comparing `undefined` against `undefined` and pass.
 */
export function lastStore(): FakeStoreHandle {
  const record = stores.at(-1);
  if (record === undefined) throw new Error('no store was opened');
  return {
    closeCount: () => record.closeCount,
    isOpen: () => !record.closed,
  };
}

/** Capture everything written to stderr for one call. */
export function captureStderr(): { readonly written: string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return { written, restore: () => spy.mockRestore() };
}

/**
 * Register the per-test isolation both suites need: a detached git env, the
 * fake backend reset, the process's "once" notice ledger reset, and every
 * named env variable restored exactly.
 *
 * @param options.envNames - The process-global variables a test may set
 * @param options.resetUnscopedNoticeLedger - The subject's ledger reset, passed in so this module never imports the subject
 */
export function isolateProjectionStoreTests(options: {
  readonly envNames: readonly string[];
  readonly resetUnscopedNoticeLedger: () => void;
}): void {
  let restoreGitEnv: () => void = () => undefined;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    // 🪤 A git child inherits `GIT_DIR` / `GIT_INDEX_FILE` from whatever spawned
    // this run — a hook, an outer `vat validate` — and would then snapshot the
    // OUTER repository while the fixture sat untouched.
    restoreGitEnv = detachGitEnv();
    for (const name of options.envNames) saved.set(name, process.env[name]);
    stores.length = 0;
    openCalls.count = 0;
    openCalls.options.length = 0;
    // The process's own "once" ledger: a notice printed outside every scope by an earlier test
    // would otherwise silence the same notice in every later scope of this worker.
    options.resetUnscopedNoticeLedger();
  });

  afterEach(() => {
    // Restored rather than deleted: these variables are process-global, and a
    // test that leaks one turns every later test in the same worker into a
    // different test. "Passes in isolation, fails in the suite" is the
    // signature. The sharpest: a leaked `VAT_CACHE=0` silently disables the
    // parse cache, and a leaked `VAT_PROJECTION_STORE_DIR` pointing at a
    // deleted temp directory makes every later store open somewhere no
    // assertion looks.
    for (const name of options.envNames) {
      delete process.env[name];
      const value = saved.get(name);
      if (value !== undefined) process.env[name] = value;
    }
    restoreGitEnv();
    vi.restoreAllMocks();
  });
}
