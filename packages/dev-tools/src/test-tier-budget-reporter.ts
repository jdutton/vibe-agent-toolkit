/**
 * test-tier-budget-reporter — a vitest reporter that fails the run when a
 * spec FILE runs over its tier's duration budget, unless the file is on the
 * ratchet allowlist; and fails it the other way when a listed file has become
 * fast enough that its entry is stale.
 *
 * Wired into every tier through `vitest.shared.ts` (so all package configs and
 * the root configs carry it), NOT enabled on win32 — see the comment at the
 * wiring site. The budgets, the allowlist and the two fractions that make the
 * check tolerate load noise live in `test-tier-budget-allowlist.ts`; this file
 * only measures and judges.
 *
 * ⚠️ A reporter cannot mark a test failed after the fact. It fails the run by
 * setting `process.exitCode`, which vitest never resets to 0 — it only ever
 * sets it to 1 on a failure of its own. vibe-validate's vitest extractor will
 * then report "0 test failures" with a non-zero exit, so the verdict printed
 * here is the whole explanation; it is written to stderr, unbuffered, once.
 *
 * The judgement is pure and exported (`judgeSamples`) so it is unit-tested
 * without a vitest run inside a vitest run. The reporter class is thin.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import type { Reporter, TestModule } from 'vitest/node';

import {
  LISTED_HEADROOM_FACTOR,
  STALE_FRACTION,
  TEST_TIER_BUDGET_ALLOWLIST,
  TIER_BUDGET_MS,
  tierOf,
  type TestTier,
  type TestTierBudgetEntry,
} from './test-tier-budget-allowlist.js';

/** The three module states the judgement distinguishes; anything else is "not measured". */
export type ModuleState = 'passed' | 'failed' | 'skipped' | 'pending' | 'queued';

/** What the reporter reads off a vitest `TestModule` — duck-typed so tests can fake it. */
export interface ModuleLike {
  readonly moduleId: string;
  state: () => ModuleState;
  diagnostic: () => { readonly duration: number };
}

export interface DurationSample {
  /** Repo-relative, forward-slash path. */
  readonly file: string;
  readonly durationMs: number;
  readonly state: ModuleState;
}

export interface BudgetVerdict {
  readonly kind: 'over-budget' | 'listed-over-headroom' | 'stale-entry';
  readonly file: string;
  readonly tier: TestTier;
  readonly durationMs: number;
  /** The tier budget for an unlisted file; the entry's headroom ceiling for a listed one. */
  readonly budgetMs: number;
  /** The entry's stale line (`STALE_FRACTION` × its `measuredMs`); 0 for an unlisted file. */
  readonly staleBelowMs: number;
}

function toForwardSlash(p: string): string {
  return p.replaceAll('\\', '/');
}

function withTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
}

const DRIVE_LETTER_RE = /^[a-z]:\//i;

/**
 * The module id relative to the repo root, forward-slashed.
 *
 * Vitest hands over an absolute, forward-slashed id; on Windows its drive letter
 * may differ in case from the one `fileURLToPath` produced for the root, so a
 * drive-lettered pair is compared case-insensitively (keyed on the path shape,
 * not on `process.platform`, so the unit test exercises it on every host). A
 * module outside the root comes back unchanged — a visibly absolute path in a
 * verdict is the honest failure.
 */
export function repoRelative(moduleId: string, repoRoot: string): string {
  const id = toForwardSlash(moduleId);
  const root = withTrailingSlash(toForwardSlash(repoRoot));
  const driveLettered = DRIVE_LETTER_RE.test(id) && DRIVE_LETTER_RE.test(root);
  const matches = driveLettered ? id.toLowerCase().startsWith(root.toLowerCase()) : id.startsWith(root);
  return matches ? id.slice(root.length) : id;
}

function judgeOne(
  sample: DurationSample,
  listed: ReadonlyMap<string, TestTierBudgetEntry>,
  budgets: Readonly<Record<TestTier, number>>,
  judgeStale: boolean,
): BudgetVerdict | undefined {
  const tier = tierOf(sample.file);
  if (tier === undefined || sample.state === 'skipped' || sample.state === 'pending' || sample.state === 'queued') {
    return undefined;
  }
  const budgetMs = budgets[tier];
  const entry = listed.get(sample.file);
  if (entry) {
    // Stale is relative to the entry's own measurement — see the allowlist
    // header for the measured noise that rules out a budget-relative line. A
    // failed module's duration is partial: it says nothing about staleness.
    const staleBelowMs = entry.measuredMs * STALE_FRACTION;
    if (judgeStale && sample.state === 'passed' && sample.durationMs < staleBelowMs) {
      return { kind: 'stale-entry', file: sample.file, tier, durationMs: sample.durationMs, budgetMs, staleBelowMs };
    }
    // An entry buys headroom over its own measurement, never exemption: a
    // listed file used to have no ceiling at all.
    const ceilingMs = Math.max(budgetMs, entry.measuredMs * LISTED_HEADROOM_FACTOR);
    if (sample.durationMs > ceilingMs) {
      return { kind: 'listed-over-headroom', file: sample.file, tier, durationMs: sample.durationMs, budgetMs: ceilingMs, staleBelowMs };
    }
    return undefined;
  }
  if (sample.durationMs > budgetMs) {
    return { kind: 'over-budget', file: sample.file, tier, durationMs: sample.durationMs, budgetMs, staleBelowMs: 0 };
  }
  return undefined;
}

export interface JudgeOptions {
  /**
   * Judge the STALE side (a listed file under `STALE_FRACTION` of its own
   * `measuredMs`). Required — no default, because the run that omits it is
   * exactly the serial run that must not judge it. The seeds are taken from the per-package turbo
   * runs, where a heavy file reads up to 13× slower than in one serial vitest
   * process (measured: 7 647 ms under turbo, 558 ms serially), so a serial run
   * — the root config's coverage run, or a bare `bunx vitest run` from the
   * root — cannot tell a stale entry from a quiet host and judges only the
   * ceilings.
   */
  readonly judgeStale: boolean;
}

/**
 * Judge every measured file against its tier budget and the allowlist.
 *
 * Pure: the reporter feeds it what vitest reported, the unit test feeds it
 * literals. Both directions of the ratchet live here and nowhere else.
 */
export function judgeSamples(
  samples: readonly DurationSample[],
  allowlist: readonly TestTierBudgetEntry[],
  budgets: Readonly<Record<TestTier, number>>,
  options: JudgeOptions,
): BudgetVerdict[] {
  const { judgeStale } = options;
  const listed = new Map(allowlist.map((e) => [e.file, e]));
  const verdicts: BudgetVerdict[] = [];
  for (const sample of samples) {
    const verdict = judgeOne(sample, listed, budgets, judgeStale);
    if (verdict) verdicts.push(verdict);
  }
  return verdicts;
}

const ALLOWLIST_FILE = 'packages/dev-tools/src/test-tier-budget-allowlist.ts';

function describeVerdict(v: BudgetVerdict): string {
  if (v.kind === 'over-budget') {
    return `  OVER BUDGET  ${v.file}\n`
      + `               ${Math.round(v.durationMs)} ms against the ${v.tier} tier's ${v.budgetMs} ms per-file budget.\n`
      + `               Either the file does integration-shaped work and belongs in a slower tier, or add it to\n`
      + `               ${ALLOWLIST_FILE} with the reason it is slow (the list may only shrink).`;
  }
  if (v.kind === 'listed-over-headroom') {
    return `  OVER HEADROOM  ${v.file}\n`
      + `               ${Math.round(v.durationMs)} ms against this entry's ${Math.round(v.budgetMs)} ms ceiling (${LISTED_HEADROOM_FACTOR}× what it measured when listed, never under the ${v.tier} budget).\n`
      + `               The file regressed past the noise an entry covers: fix it, or re-measure and update its measuredMs in\n`
      + `               ${ALLOWLIST_FILE} with the reason the new number is right.`;
  }
  return `  STALE ENTRY  ${v.file}\n`
    + `               ${Math.round(v.durationMs)} ms is under this entry's ${Math.round(v.staleBelowMs)} ms stale line (a tenth of what it measured when listed) — the file is fast now.\n`
    + `               Delete its entry from ${ALLOWLIST_FILE}.`;
}

/** The verdict block the reporter prints, one paragraph per finding. */
export function formatVerdicts(verdicts: readonly BudgetVerdict[]): string {
  const header = `\ntest-tier-budget: ${verdicts.length} spec file(s) violate the per-file duration ratchet\n`;
  return `${header}${verdicts.map((v) => describeVerdict(v)).join('\n')}\n`;
}

export interface TestTierBudgetReporterOptions {
  /** Absolute repo root; module ids are made relative to it. */
  readonly repoRoot: string;
  /** Defaults to the committed allowlist; injectable for tests. */
  readonly allowlist?: readonly TestTierBudgetEntry[];
  /** Defaults to stderr; injectable for tests. */
  readonly write?: (text: string) => void;
  /** See `JudgeOptions.judgeStale` — required: turbo lane `true`, serial root run `false`. */
  readonly judgeStale: boolean;
}

export class TestTierBudgetReporter implements Reporter {
  private readonly repoRoot: string;
  private readonly allowlist: readonly TestTierBudgetEntry[];
  private readonly write: (text: string) => void;
  private readonly judgeStale: boolean;
  private samples: DurationSample[] = [];

  constructor(options: TestTierBudgetReporterOptions) {
    this.repoRoot = options.repoRoot;
    this.allowlist = options.allowlist ?? TEST_TIER_BUDGET_ALLOWLIST;
    this.write = options.write ?? ((text) => process.stderr.write(text));
    this.judgeStale = options.judgeStale;
  }

  onTestModuleEnd(testModule: ModuleLike | TestModule): void {
    this.samples.push({
      file: repoRelative(testModule.moduleId, this.repoRoot),
      durationMs: testModule.diagnostic().duration,
      state: testModule.state(),
    });
  }

  onTestRunEnd(): Promise<void> {
    const verdicts = judgeSamples(this.samples, this.allowlist, TIER_BUDGET_MS, { judgeStale: this.judgeStale });
    // Each run is judged on its own: watch mode calls this once per re-run.
    this.samples = [];
    if (verdicts.length > 0) {
      this.write(formatVerdicts(verdicts));
      process.exitCode = ExitCode.FINDINGS;
    }
    return Promise.resolve();
  }
}
