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

/** The warning Node actually emits, verbatim from a real run on v24.13.1. */
const REAL_SQLITE_WARNING = 'SQLite is an experimental feature and might change at any time';

function experimental(message: string): Error {
  const warning = new Error(message);
  warning.name = 'ExperimentalWarning';
  return warning;
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

  it('forwards the extra arguments Node passes alongside a warning', () => {
    const original = vi.fn();
    const host = { emitWarning: original } as unknown as NodeJS.Process;

    const restore = installSqliteWarningFilter(host);
    host.emitWarning('a message', 'CustomWarning', 'CODE_X');
    restore();

    expect(original).toHaveBeenCalledWith('a message', 'CustomWarning', 'CODE_X');
  });
});
