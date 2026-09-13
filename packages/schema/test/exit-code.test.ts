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
  exitCodeForSeverityCounts,
  isExitCode,
  type SeverityCounts,
} from '../src/index.js';

const counts = (errors: number, warnings: number, info = 0): SeverityCounts => ({ errors, warnings, info });

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

describe('exitCodeForSeverityCounts', () => {
  it('is OK when nothing is at error severity', () => {
    expect(exitCodeForSeverityCounts(counts(0, 0))).toBe(ExitCode.OK);
    expect(exitCodeForSeverityCounts(counts(0, 3, 9))).toBe(ExitCode.OK);
  });

  it('is FINDINGS when at least one error-severity finding exists', () => {
    expect(exitCodeForSeverityCounts(counts(1, 0))).toBe(ExitCode.FINDINGS);
  });

  it('under strict, a warning is enough to fail — and info still is not', () => {
    expect(exitCodeForSeverityCounts(counts(0, 1), { strict: true })).toBe(ExitCode.FINDINGS);
    expect(exitCodeForSeverityCounts(counts(0, 0, 5), { strict: true })).toBe(ExitCode.OK);
  });

  it('never answers ERROR — a completed run with findings is not a broken run', () => {
    for (const c of [counts(0, 0), counts(9, 9, 9), counts(0, 9)]) {
      expect(exitCodeForSeverityCounts(c, { strict: true })).not.toBe(ExitCode.ERROR);
    }
  });
});
