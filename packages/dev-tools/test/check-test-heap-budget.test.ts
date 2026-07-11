/**
 * Unit tests for check-test-heap-budget.ts parse/decision logic.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGET_MB,
  DEFAULT_TARGETS,
  findHeapBudgetViolations,
  parseArgs,
  parseHeapUsage,
} from '../src/check-test-heap-budget.js';

const SAMPLE_STDOUT = `
 RUN  v3.2.4 /repo/packages/resource-compiler

 ✓ test/integration/markdown-compiler.integration.test.ts (12 tests) 75ms 38 MB heap used
 ✓ test/integration/language-service.integration.test.ts (8 tests) 2261ms 359 MB heap used
 ✓ test/integration/transformer.integration.test.ts (10 tests) 4072ms 382 MB heap used

 Test Files  3 passed (3)
      Tests  30 passed (30)
`;

describe('parseHeapUsage', () => {
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
