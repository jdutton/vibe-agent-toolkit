/**
 * The one exit-code contract every `vat` verb (and `vat-lab`, and every
 * dev-tools script) ends on.
 *
 * Five vocabularies used to exist — `vat skill test` read 1 as "the harness
 * broke", `vat audit` exited 0 over `status: error`, `vat doctor` folded a
 * crash into 1 — and the orchestrator's `statusFromExitCode` read all of them
 * as one. These tests pin the three values and the two derivations, so a verb
 * that wants a fourth meaning has to argue with a test rather than add a
 * literal.
 */

import { describe, expect, it } from 'vitest';

import {
  ExitCode,
  errorDiagnostics,
  exitCodeForReport,
  exitCodeOfChild,
  isExitCode,
  type ExitDeterminingDocument,
  type Gate,
  type SeverityCounts,
} from '../src/index.js';

const counts = (errors: number, warnings: number, info = 0): SeverityCounts => ({ errors, warnings, info });

const LENIENT: Gate = { strict: false };
const STRICT: Gate = { strict: true };

/** A completed document with these counts — the status derived as `buildReport` derives it. */
function completed(summary: SeverityCounts, gate: Gate = LENIENT): ExitDeterminingDocument {
  const total = summary.errors + summary.warnings + summary.info;
  return { status: total === 0 ? 'ok' : 'findings', summary, gate };
}

describe('ExitCode', () => {
  it('is exactly the three-way contract: 0 ok, 1 findings, 2 error', () => {
    expect(ExitCode).toEqual({ OK: 0, FINDINGS: 1, ERROR: 2 });
  });

  it('is frozen — a verb cannot grow a fourth member at runtime', () => {
    expect(Object.isFrozen(ExitCode)).toBe(true);
  });
});

describe('isExitCode', () => {
  it('accepts the three members', () => {
    expect([0, 1, 2].every((code) => isExitCode(code))).toBe(true);
  });

  it('rejects every other number — 3 and 4 were codes once, and are not now', () => {
    expect([-1, 3, 4, 255, 1.5, Number.NaN].some((code) => isExitCode(code))).toBe(false);
  });
});

describe('exitCodeForReport — a COMPLETED document', () => {
  it('is OK when nothing is at error severity', () => {
    expect(exitCodeForReport(completed(counts(0, 0)))).toBe(ExitCode.OK);
    expect(exitCodeForReport(completed(counts(0, 3, 9)))).toBe(ExitCode.OK);
  });

  it('is FINDINGS when at least one error-severity finding exists', () => {
    expect(exitCodeForReport(completed(counts(1, 0)))).toBe(ExitCode.FINDINGS);
  });

  it('under a strict gate, a warning is enough to fail — and info still is not', () => {
    expect(exitCodeForReport(completed(counts(0, 1), STRICT))).toBe(ExitCode.FINDINGS);
    expect(exitCodeForReport(completed(counts(0, 0, 5), STRICT))).toBe(ExitCode.OK);
  });

  it('never answers ERROR — a completed run with findings is not a broken run', () => {
    for (const c of [counts(0, 0), counts(9, 9, 9), counts(0, 9)]) {
      expect(exitCodeForReport(completed(c, STRICT))).not.toBe(ExitCode.ERROR);
    }
  });
});

describe('exitCodeForReport — the document decides, not the call site', () => {
  it('is ERROR for a document whose status is `error`, whatever its counts say', () => {
    // 🔑 `error` means the command could not do its job. A verb that published
    // that and exited 1 told a CI wrapper "the tree failed its gate" about a
    // run that never examined the tree.
    expect(exitCodeForReport({ status: 'error', summary: counts(0, 0), gate: LENIENT })).toBe(ExitCode.ERROR);
    expect(exitCodeForReport({ status: 'error', summary: counts(3, 0), gate: LENIENT })).toBe(ExitCode.ERROR);
  });

  it('fails warnings only when the DOCUMENT says strict', () => {
    // 🪤 `findings` means the list is non-empty, not that the gate failed. A
    // straight `findings → 1` table would fail every run with one warning —
    // and the gate that decides it is READ FROM THE DOCUMENT, so a reader of
    // the published report derives the same code the process ended on.
    const warningsOnly = counts(0, 1);
    expect(exitCodeForReport({ status: 'findings', summary: warningsOnly, gate: STRICT })).toBe(ExitCode.FINDINGS);
    expect(exitCodeForReport({ status: 'findings', summary: warningsOnly, gate: LENIENT })).toBe(ExitCode.OK);
    expect(exitCodeForReport({ status: 'error', summary: warningsOnly, gate: STRICT })).toBe(ExitCode.ERROR);
    expect(exitCodeForReport({ status: 'error', summary: warningsOnly, gate: LENIENT })).toBe(ExitCode.ERROR);
  });

  it('takes no options — the gate has exactly one source', () => {
    expect(exitCodeForReport).toHaveLength(1);
  });

  it('answers each of the three values for exactly one kind of document', () => {
    const answers = [
      exitCodeForReport({ status: 'ok', summary: counts(0, 0), gate: LENIENT }),
      exitCodeForReport({ status: 'findings', summary: counts(1, 0), gate: LENIENT }),
      exitCodeForReport({ status: 'error', summary: counts(0, 0), gate: LENIENT }),
    ];
    expect(answers).toStrictEqual([ExitCode.OK, ExitCode.FINDINGS, ExitCode.ERROR]);
  });
});

describe('exitCodeOfChild', () => {
  it('forwards a child that ended on the contract', () => {
    expect([0, 1, 2].map((code) => exitCodeOfChild(code))).toStrictEqual([0, 1, 2]);
  });

  it('reads anything else — a signal death, an abort code — as ERROR, never forwarded verbatim', () => {
    // 🚨 134 is Node's own fatal abort. Forwarded verbatim it is a fourth exit
    // code, and `null` (a signal) coerced to 0 is a crash that reads as a pass.
    for (const code of [null, 134, 3, -1]) expect(exitCodeOfChild(code)).toBe(ExitCode.ERROR);
  });
});

describe('errorDiagnostics', () => {
  it('returns the stack of an Error, not just its message', () => {
    const diagnostics = errorDiagnostics(new Error('boom'));
    expect(diagnostics).toContain('Error: boom');
    expect(diagnostics.split('\n').length).toBeGreaterThan(1);
  });

  it('falls back to name and message when an Error carries no stack', () => {
    // Cross-realm and hand-built errors reach here with `stack` undefined;
    // `stack` is optional in the type, so the fallback is not theoretical.
    const stackless = new RangeError('out of range');
    stackless.stack = undefined;
    expect(errorDiagnostics(stackless)).toBe('RangeError: out of range');
  });

  it('inspects a thrown non-Error rather than discarding it', () => {
    expect(errorDiagnostics({ code: 'ENOENT' })).toContain("code: 'ENOENT'");
    expect(errorDiagnostics('a bare string')).toContain('a bare string');
    expect(errorDiagnostics(undefined)).toContain('undefined');
  });
});
