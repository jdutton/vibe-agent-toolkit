/**
 * Unit tests for check-test-heap-budget.ts parse/decision logic.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGET_MB,
  DEFAULT_TARGETS,
  findHeapBudgetViolations,
  findIncompleteMeasurement,
  parseArgs,
  parseHeapUsage,
  parseTestFileSummary,
} from '../src/check-test-heap-budget.js';

const SAMPLE_STDOUT = `
 RUN  v3.2.4 /repo/packages/resource-compiler

 ✓ test/integration/markdown-compiler.integration.test.ts (12 tests) 75ms 38 MB heap used
 ✓ test/integration/language-service.integration.test.ts (8 tests) 2261ms 359 MB heap used
 ✓ test/integration/transformer.integration.test.ts (10 tests) 4072ms 382 MB heap used

 Test Files  3 passed (3)
      Tests  30 passed (30)
`;

/**
 * What vitest 4 actually prints under `--logHeapUsage --reporter=verbose`:
 * one line per TEST, with no `(N tests)` group, several of them per file.
 *
 * Captured from a real `packages/resource-compiler` integration run — the two
 * files interleave because they run in parallel forks, which is why grouping
 * cannot assume a file's lines are contiguous.
 */
const V4_VERBOSE_STDOUT = `
 RUN  v4.1.11 /repo/packages/resource-compiler

 ✓ test/integration/transformer.integration.test.ts > transformer > default import 310ms 182 MB heap used
 ✓ test/integration/language-service.integration.test.ts > LSP > fragment completions 174ms 113 MB heap used
 ✓ test/integration/transformer.integration.test.ts > transformer > namespace import 200ms 244 MB heap used
 ✓ test/integration/language-service.integration.test.ts > LSP > go-to-definition 141ms 116 MB heap used
 ✓ test/integration/transformer.integration.test.ts > transformer > named imports 181ms 162 MB heap used

 Test Files  2 passed (2)
`;

describe('parseHeapUsage', () => {
  it('keeps each file PEAK from vitest 4 verbose per-test lines', () => {
    // 🚨 The regression this exists for. Vitest 4's DEFAULT reporter prints no
    // line at all for a passing file, so the v3 parser — which required a
    // `(N tests)` group — matched nothing and the guard failed closed on every
    // run. `--reporter=verbose` restores the lines as one per TEST, so a file
    // now contributes SEVERAL readings and the guard must reduce them.
    //
    // 🪤 The fixture interleaves two files and puts each file's maximum in a
    // DIFFERENT position (transformer's peak 244 is in the middle, LSP's peak
    // 116 is last). A "keep the first" or "keep the last" reduction gets one of
    // them wrong, so the two candidate bugs produce different answers here
    // rather than both passing.
    const entries = parseHeapUsage(V4_VERBOSE_STDOUT);

    expect(entries).toEqual([
      { file: 'test/integration/transformer.integration.test.ts', heapMB: 244 },
      { file: 'test/integration/language-service.integration.test.ts', heapMB: 116 },
    ]);
  });

  it('parses per-file heap entries from vitest --logHeapUsage output', () => {
    const entries = parseHeapUsage(SAMPLE_STDOUT);

    expect(entries).toEqual([
      { file: 'test/integration/markdown-compiler.integration.test.ts', heapMB: 38 },
      { file: 'test/integration/language-service.integration.test.ts', heapMB: 359 },
      { file: 'test/integration/transformer.integration.test.ts', heapMB: 382 },
    ]);
  });

  it('returns an empty array when no heap lines are present', () => {
    expect(parseHeapUsage('no matching content here\n')).toEqual([]);
  });

  it('tolerates a FAILED file summary line (extra content before the close paren)', () => {
    const stdout = ' × test/integration/broken.integration.test.ts (2 tests | 1 failed) 500ms 45 MB heap used\n';
    expect(parseHeapUsage(stdout)).toEqual([
      { file: 'test/integration/broken.integration.test.ts', heapMB: 45 },
    ]);
  });

  it('does not match prose that merely mentions "MB" without the exact heap-used tail', () => {
    const stdout = ' ✓ test/integration/foo.integration.test.ts (1 test) 10ms uploaded 5 MB of fixtures\n';
    expect(parseHeapUsage(stdout)).toEqual([]);
  });
});

/**
 * The VERIFIED green-on-a-broken-run scenario, derived from the clean fixture
 * above rather than retyped: the same two-file run with one worker SIGKILLed
 * mid-file. Everything language-service printed is gone, and vitest's tally
 * drops to `1 passed` while the SCHEDULED total in parens stays at 2.
 *
 * 🚨 Deriving it is the point. A hand-written second fixture could drift from
 * the first and then "prove" the guard against output no vitest ever emits;
 * this one is provably the clean run minus a worker.
 */
const ONE_OF_TWO_FILES_TALLY = 'Test Files  1 passed (2)';
const KILLED_WORKER_STDOUT = V4_VERBOSE_STDOUT.split('\n')
  .filter((line) => !line.includes('language-service'))
  .join('\n')
  .replace('Test Files  2 passed (2)', ONE_OF_TWO_FILES_TALLY);

/**
 * The same one-of-two shortfall, but vitest itself accounts for the missing
 * file: it was fully SKIPPED, so it printed `↓ file > name` with no heap column
 * and is absent from the measured set by design, not by dying.
 *
 * Two variants because the exit status must NOT be the completeness signal:
 * the clean one exits 0, and the second has a genuinely failing sibling file so
 * the run exits 1 while still measuring everything it could.
 */
const SKIPPED_FILE_STDOUT = KILLED_WORKER_STDOUT.replace(
  ONE_OF_TWO_FILES_TALLY,
  'Test Files  1 passed | 1 skipped (2)',
);
const SKIPPED_WITH_FAILING_SIBLING_STDOUT = KILLED_WORKER_STDOUT.replace(
  ONE_OF_TWO_FILES_TALLY,
  'Test Files  1 failed | 1 skipped (2)',
);

describe('parseTestFileSummary', () => {
  it('reads the scheduled total and the categories that print no heap line', () => {
    const stdout = ' Test Files  1 failed | 2 passed | 3 skipped | 1 todo (7)\n      Tests  9 passed (9)\n';

    expect(parseTestFileSummary(stdout)).toEqual({ total: 7, skipped: 3, todo: 1 });
  });

  it('reads a summary with no breakdown categories beyond passed', () => {
    expect(parseTestFileSummary(V4_VERBOSE_STDOUT)).toEqual({ total: 2, skipped: 0, todo: 0 });
  });

  it('returns null when the run printed no Test Files line at all', () => {
    expect(parseTestFileSummary(' ✓ test/a.test.ts > x 1ms 5 MB heap used\n')).toBeNull();
  });

  it('does not mistake the Tests line for the Test Files line', () => {
    // 🪤 `Tests  30 passed (30)` is one row below and matches the same shape
    // apart from the anchor. Reading it would report 30 scheduled FILES.
    expect(parseTestFileSummary('      Tests  30 passed (30)\n')).toBeNull();
  });
});

describe('findIncompleteMeasurement', () => {
  it('FAILS CLOSED when a worker died mid-file: one heap line, two files scheduled', () => {
    // 🚨 The verified defect. Exit is 1 via `status` (not `error`), the file
    // that finished still printed its heap lines, so `entries.length === 0` is
    // false and no surviving entry is over budget — the guard reported GREEN on
    // exactly the run it exists to catch, and the unmeasured file is the one
    // that blew the memory.
    // Pin the fixture's SHAPE first, so this can never quietly become a test of
    // some other output: exactly one file measured, two files scheduled.
    expect(parseHeapUsage(KILLED_WORKER_STDOUT)).toHaveLength(1);
    expect(KILLED_WORKER_STDOUT).toContain(ONE_OF_TWO_FILES_TALLY);

    const reason = findIncompleteMeasurement(KILLED_WORKER_STDOUT, parseHeapUsage(KILLED_WORKER_STDOUT).length, 1);

    expect(reason, 'the guard reported GREEN on a run that measured 1 of 2 files').not.toBeNull();
    expect(reason).toContain('measured 1 of 2');
  });

  it('passes a complete run', () => {
    expect(findIncompleteMeasurement(V4_VERBOSE_STDOUT, parseHeapUsage(V4_VERBOSE_STDOUT).length, 0)).toBeNull();
  });

  it('passes a run whose TESTS failed but whose files were all measured', () => {
    // 🪤 A non-zero exit is not by itself incompleteness — a suite may fail
    // loudly while printing every heap line. Reading the exit code alone would
    // red this, which is why the file COUNT is the signal and the status is
    // only reported alongside it.
    const failed = V4_VERBOSE_STDOUT.replace('Test Files  2 passed (2)', 'Test Files  1 failed | 1 passed (2)');

    expect(findIncompleteMeasurement(failed, parseHeapUsage(failed).length, 1)).toBeNull();
  });

  it.each([
    ['a clean run', SKIPPED_FILE_STDOUT, 0],
    ['a run whose other file FAILED (exit 1)', SKIPPED_WITH_FAILING_SIBLING_STDOUT, 1],
  ])('does not red on a legitimately SKIPPED file in %s', (_label, stdout, status) => {
    // 🪤 This is the guard's other failure direction, and the expensive one: a
    // gate that fires on healthy runs gets suppressed. A skipped file prints
    // `↓ file > name` with NO heap column, so it is missing from the measured
    // set exactly like a file whose worker died — only the `Test Files` line
    // tells them apart. The exit-1 row additionally pins that "fail closed on
    // any non-zero exit" is NOT an acceptable implementation of this fix.
    expect(findIncompleteMeasurement(stdout, parseHeapUsage(stdout).length, status)).toBeNull();
  });

  it('fails closed when nothing at all was measured', () => {
    expect(findIncompleteMeasurement(' Test Files  no tests\n', 0, 0)).toContain('no per-file heap lines parsed');
  });

  it('fails closed when the run printed no Test Files summary to check against', () => {
    // A run killed before it could tally is unverifiable, not clean.
    const truncated = KILLED_WORKER_STDOUT.split('\n').filter((line) => !line.includes('Test Files')).join('\n');

    const reason = findIncompleteMeasurement(truncated, parseHeapUsage(truncated).length, 1);

    expect(reason, 'an unverifiable run reported GREEN').not.toBeNull();
    expect(reason).toContain('no "Test Files');
  });
});

describe('findHeapBudgetViolations', () => {
  const entries = [
    { file: 'a.test.ts', heapMB: 100 },
    { file: 'b.test.ts', heapMB: 600 },
    { file: 'c.test.ts', heapMB: 601 },
  ];

  it('returns only entries strictly over budget', () => {
    expect(findHeapBudgetViolations(entries, 600)).toEqual([{ file: 'c.test.ts', heapMB: 601 }]);
  });

  it('returns an empty array when nothing is over budget', () => {
    expect(findHeapBudgetViolations(entries, 1000)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = [...entries];
    findHeapBudgetViolations(entries, 0);
    expect(entries).toEqual(copy);
  });
});

describe('parseArgs', () => {
  const FOO_DIR = 'packages/foo';

  it('falls back to the default budget and targets when no args are given', () => {
    expect(parseArgs([])).toEqual({ budgetMB: DEFAULT_BUDGET_MB, targets: [...DEFAULT_TARGETS] });
  });

  it('overrides the budget via --budget=', () => {
    expect(parseArgs(['--budget=250'])).toEqual({ budgetMB: 250, targets: [...DEFAULT_TARGETS] });
  });

  it('parses a --cwd/--suite pair, replacing the default target list', () => {
    expect(parseArgs([`--cwd=${FOO_DIR}`, '--suite=integration'])).toEqual({
      budgetMB: DEFAULT_BUDGET_MB,
      targets: [{ dir: FOO_DIR, suites: ['integration'] }],
    });
  });

  it('parses multiple --cwd/--suite pairs alongside a --budget= override', () => {
    expect(
      parseArgs(['--budget=100', `--cwd=${FOO_DIR}`, '--suite=system', '--cwd=packages/bar', '--suite=integration']),
    ).toEqual({
      budgetMB: 100,
      targets: [
        { dir: FOO_DIR, suites: ['system'] },
        { dir: 'packages/bar', suites: ['integration'] },
      ],
    });
  });

  it('throws when --cwd= is not immediately followed by --suite=', () => {
    expect(() => parseArgs([`--cwd=${FOO_DIR}`])).toThrow(
      `--cwd=${FOO_DIR} must be immediately followed by --suite=<integration|system>`,
    );
  });

  it('throws when --cwd= is followed by an invalid --suite= value', () => {
    expect(() => parseArgs([`--cwd=${FOO_DIR}`, '--suite=bogus'])).toThrow(
      `--cwd=${FOO_DIR} must be immediately followed by --suite=<integration|system>`,
    );
  });
});
