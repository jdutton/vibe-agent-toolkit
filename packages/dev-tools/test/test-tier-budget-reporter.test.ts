/**
 * Unit tests for the per-tier duration budget: the pure judgement, the path
 * normalisation, and the reporter's two side effects (a printed verdict and a
 * non-zero exit code).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LISTED_HEADROOM_FACTOR,
  MECHANISM,
  STALE_FRACTION,
  TIER_BUDGET_MS,
  type TestTierBudgetEntry,
} from '../src/test-tier-budget-allowlist.js';
import {
  TestTierBudgetReporter,
  formatVerdicts,
  judgeSamples,
  repoRelative,
  type BudgetVerdict,
  type DurationSample,
  type ModuleLike,
  type ModuleState,
} from '../src/test-tier-budget-reporter.js';

const REPO_ROOT = '/repo';

function entry(file: string, measuredMs = 2_000): TestTierBudgetEntry {
  return { file, measuredMs, mechanisms: [MECHANISM.tempTree] };
}

function sample(file: string, durationMs: number, state: DurationSample['state'] = 'passed'): DurationSample {
  return { file, durationMs, state };
}

function judge(samples: DurationSample[], allowlist: TestTierBudgetEntry[] = []): BudgetVerdict[] {
  return judgeSamples(samples, allowlist, TIER_BUDGET_MS);
}

describe('repoRelative', () => {
  it('strips the repo root and keeps forward slashes', () => {
    expect(repoRelative('/repo/packages/x/test/a.test.ts', '/repo')).toBe('packages/x/test/a.test.ts');
  });

  it('tolerates a root given with a trailing slash', () => {
    expect(repoRelative('/repo/packages/x/test/a.test.ts', '/repo/')).toBe('packages/x/test/a.test.ts');
  });

  it('normalises a Windows root and compares the drive letter case-insensitively', () => {
    expect(repoRelative('c:/repo/packages/x/test/a.test.ts', 'C:\\repo\\')).toBe('packages/x/test/a.test.ts');
  });

  it('returns a module outside the root unchanged, so it is visibly wrong rather than silently trimmed', () => {
    expect(repoRelative('/elsewhere/a.test.ts', '/repo')).toBe('/elsewhere/a.test.ts');
  });
});

describe('judgeSamples', () => {
  it('passes an unlisted file under its tier budget', () => {
    expect(judge([sample('packages/x/test/fast.test.ts', 999)])).toEqual([]);
  });

  it('fails an unlisted unit file over 1 s as over-budget', () => {
    const verdicts = judge([sample('packages/x/test/slow.test.ts', 1_001)]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ kind: 'over-budget', file: 'packages/x/test/slow.test.ts', tier: 'unit', budgetMs: 1_000 });
  });

  it('applies the integration and system budgets by filename suffix', () => {
    const verdicts = judge([
      sample('packages/x/test/integration/a.integration.test.ts', 5_001),
      sample('packages/x/test/integration/b.integration.test.ts', 4_999),
      sample('packages/x/test/system/c.system.test.ts', 30_001),
      sample('packages/x/test/system/d.system.test.ts', 29_999),
    ]);
    expect(verdicts.map((v) => v.file)).toEqual([
      'packages/x/test/integration/a.integration.test.ts',
      'packages/x/test/system/c.system.test.ts',
    ]);
  });

  it('holds a LISTED file to LISTED_HEADROOM_FACTOR × its own measurement — an entry buys headroom, not exemption', () => {
    // 140 of 186 seeded entries were UNDER budget, and a listed file had no
    // upper bound at all: it could take 60 s and the reporter said nothing.
    const file = 'packages/x/test/slow.test.ts';
    const ceiling = 2_000 * LISTED_HEADROOM_FACTOR;
    expect(judge([sample(file, ceiling)], [entry(file, 2_000)])).toEqual([]);
    const verdicts = judge([sample(file, ceiling + 1)], [entry(file, 2_000)]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ kind: 'listed-over-headroom', file, tier: 'unit', budgetMs: ceiling });
  });

  it('never holds a listed file below its tier budget: a hover entry measured at 120 ms is bounded at 1 s, not 360 ms', () => {
    const file = 'packages/x/test/hover.test.ts';
    expect(judge([sample(file, 1_000)], [entry(file, 120)])).toEqual([]);
    expect(judge([sample(file, 1_001)], [entry(file, 120)])).toHaveLength(1);
  });

  it('fails a listed file that runs under a tenth of its own measurement, naming the entry to delete', () => {
    const file = 'packages/x/test/fixed.test.ts';
    const verdicts = judge([sample(file, 199)], [entry(file, 2_000)]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ kind: 'stale-entry', file, tier: 'unit', staleBelowMs: 200 });
  });

  it('passes a listed file anywhere from its stale line up to its headroom — a 4× swing between hosts is not a fix', () => {
    const file = 'packages/x/test/hover.test.ts';
    expect(judge([sample(file, 200)], [entry(file, 2_000)])).toEqual([]);
    expect(judge([sample(file, 500)], [entry(file, 2_000)])).toEqual([]);
    expect(judge([sample(file, 5_999)], [entry(file, 2_000)])).toEqual([]);
  });

  it('measures the stale line against the entry, not the budget: a hover entry measured at 120 ms is stale under 12 ms', () => {
    const file = 'packages/x/test/hover.test.ts';
    expect(judge([sample(file, 17)], [entry(file, 124)])).toEqual([]);
    expect(judge([sample(file, 11)], [entry(file, 124)])).toHaveLength(1);
  });

  it('judges only the ceilings when stale judgement is off — a serial run cannot measure staleness against a turbo seed', () => {
    const fast = 'packages/x/test/fast.test.ts';
    const slow = 'packages/x/test/slow.test.ts';
    const verdicts = judgeSamples(
      [sample(fast, 550), sample(slow, 70_000)],
      [entry(fast, 7_600), entry(slow, 7_600)],
      TIER_BUDGET_MS,
      { judgeStale: false },
    );
    expect(verdicts.map((v) => [v.kind, v.file])).toEqual([['listed-over-headroom', slow]]);
  });

  it('never calls a FAILED module stale — its duration is partial', () => {
    const file = 'packages/x/test/red.test.ts';
    expect(judge([sample(file, 1, 'failed')], [entry(file)])).toEqual([]);
  });

  it('still calls a FAILED module over budget — a red slow file is two findings, not one', () => {
    const file = 'packages/x/test/red-slow.test.ts';
    expect(judge([sample(file, 5_000, 'failed')])).toHaveLength(1);
  });

  it('ignores a SKIPPED module in both directions — a platform gate is not a measurement', () => {
    const file = 'packages/x/test/gated.test.ts';
    expect(judge([sample(file, 0, 'skipped')], [entry(file)])).toEqual([]);
    expect(judge([sample(file, 0, 'skipped')])).toEqual([]);
  });

  it('ignores a file that is not a spec file at all', () => {
    expect(judge([sample('packages/x/test/helpers.ts', 99_999)])).toEqual([]);
  });

  it('uses the exact tier budgets the documentation promises, and fractions that are fractions', () => {
    // Pinned here so a drift in either file reads as a failing test rather
    // than a quietly moved goalpost.
    expect(TIER_BUDGET_MS).toEqual({ unit: 1_000, integration: 5_000, system: 30_000 });
    expect(STALE_FRACTION).toBeGreaterThan(0);
    expect(STALE_FRACTION).toBeLessThan(1);
    // Headroom must exceed the measured turbo-vs-serial noise (2–4×) or the
    // ratchet flaps on load; and be finite, or a listed file is exempt again.
    expect(LISTED_HEADROOM_FACTOR).toBeGreaterThan(2);
    expect(Number.isFinite(LISTED_HEADROOM_FACTOR)).toBe(true);
  });
});

describe('formatVerdicts', () => {
  it('names the file, the tier, the measured and budget durations, and the remedy for each kind', () => {
    const text = formatVerdicts([
      { kind: 'over-budget', file: 'packages/x/test/slow.test.ts', tier: 'unit', durationMs: 2_345, budgetMs: 1_000, staleBelowMs: 0 },
      { kind: 'stale-entry', file: 'packages/x/test/fixed.test.ts', tier: 'unit', durationMs: 12, budgetMs: 1_000, staleBelowMs: 200 },
    ]);
    expect(text).toContain('packages/x/test/slow.test.ts');
    expect(text).toContain('2345 ms');
    expect(text).toContain('1000 ms');
    expect(text).toContain('unit');
    expect(text).toContain('test-tier-budget-allowlist.ts');
    expect(text).toContain('packages/x/test/fixed.test.ts');
    expect(text).toMatch(/delete/i);
  });
});

/** A duck-typed vitest TestModule: only what the reporter reads. */
function fakeModule(moduleId: string, durationMs: number, state: ModuleState = 'passed'): ModuleLike {
  return {
    moduleId,
    state: () => state,
    diagnostic: () => ({ duration: durationMs }),
  };
}

/** Feed one module through a fresh reporter and finish the run. */
async function runReporter(
  options: { repoRoot: string; allowlist: TestTierBudgetEntry[]; judgeStale?: boolean },
  moduleId: string,
  durationMs: number,
): Promise<{ reporter: TestTierBudgetReporter; write: ReturnType<typeof vi.fn> }> {
  const write = vi.fn();
  const reporter = new TestTierBudgetReporter({ ...options, write });
  reporter.onTestModuleEnd(fakeModule(moduleId, durationMs));
  await reporter.onTestRunEnd();
  return { reporter, write };
}

const A_FILE = 'packages/x/test/a.test.ts';

describe('TestTierBudgetReporter', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('leaves the exit code alone and prints nothing when every file is within budget', async () => {
    const { write } = await runReporter({ repoRoot: REPO_ROOT, allowlist: [] }, `${REPO_ROOT}/${A_FILE}`, 10);
    expect(write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('sets a non-zero exit code and prints the verdict when a file is over budget', async () => {
    const { write } = await runReporter({ repoRoot: REPO_ROOT, allowlist: [] }, `${REPO_ROOT}/${A_FILE}`, 1_500);
    expect(process.exitCode).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain(A_FILE);
  });

  it('resolves module ids against the repo root so allowlist entries match', async () => {
    // 5 000 ms: over the unit budget (so an unmatched id would red) and under
    // the entry's 6 000 ms headroom ceiling (so a matched one passes).
    const { write } = await runReporter({ repoRoot: `${REPO_ROOT}/`, allowlist: [entry(A_FILE)] }, `${REPO_ROOT}/${A_FILE}`, 5_000);
    expect(write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('skips the stale side when constructed with judgeStale: false, and still fails the headroom side', async () => {
    const listed = [entry(A_FILE, 7_600)];
    const stale = await runReporter({ repoRoot: REPO_ROOT, allowlist: listed, judgeStale: false }, `${REPO_ROOT}/${A_FILE}`, 550);
    expect(stale.write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
    const over = await runReporter({ repoRoot: REPO_ROOT, allowlist: listed, judgeStale: false }, `${REPO_ROOT}/${A_FILE}`, 70_000);
    expect(process.exitCode).toBe(1);
    expect(String(over.write.mock.calls[0]?.[0])).toContain('OVER HEADROOM');
  });

  it('forgets the previous run between runs, so watch mode judges each run on its own', async () => {
    const { reporter, write } = await runReporter({ repoRoot: REPO_ROOT, allowlist: [] }, `${REPO_ROOT}/${A_FILE}`, 1_500);
    process.exitCode = originalExitCode;
    write.mockClear();
    await reporter.onTestRunEnd();
    expect(write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });
});
