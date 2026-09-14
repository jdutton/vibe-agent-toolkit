/**
 * Per-tier test FILE duration budgets, and the ratchet allowlist of the files
 * that exceed their tier's budget today.
 *
 * `docs/writing-tests.md` promises unit < 100 ms, integration < 5 s, system
 * < 30 s. Those are per-TEST aspirations that nothing enforced; the enforceable
 * unit is the spec FILE, whose duration vitest already reports. The budgets
 * below are per file. `test-tier-budget-reporter.ts` reads them at the end of
 * every vitest run and fails the run when:
 *
 *   - a file NOT listed here runs over its tier's budget;
 *   - a file listed here runs over `max(budget, LISTED_HEADROOM_FACTOR ×
 *     measuredMs)` — an entry buys HEADROOM over what the file measured when
 *     listed, never exemption. Without this bound a listed file had no ceiling
 *     at all: it could take a minute and the reporter said nothing;
 *   - a file listed here runs under `STALE_FRACTION` of its OWN `measuredMs` —
 *     it is ten times faster than when it was listed, the entry is stale and
 *     must be deleted, so the list can only shrink.
 *
 * ⚠️ WHERE a duration is taken decides whether it is a measurement. Under
 * turbo (two workers per package, packages in parallel) the same file reads
 * 3–20× its own cost depending on what its neighbours are doing that second —
 * MEASURED on this tree and on CI: 120–540 ms files at 1 000–3 055 ms, a
 * different handful crossing on each of six consecutive runs. So the ratchet
 * is judged ONLY by the three root configs, which run one file at a time
 * (`fileParallelism: false`; `rootSerialReporters` in vitest.shared.ts), and
 * in CI by the coverage job, which is also where the entries are seeded from.
 * What is left for the factor and the fraction to absorb is the spread between
 * serial runs — the CI floor against a local box, about 2× either way, and the
 * same runner on different days:
 *
 *   - `LISTED_HEADROOM_FACTOR` (8×) covers that with room to spare, and the
 *     ceiling never drops below the tier budget, so a listed file is never
 *     held to less than an unlisted one;
 *   - a listed file is STALE only under `STALE_FRACTION` of what it measured
 *     when listed — a 10× improvement. A budget-relative stale line was tried
 *     first and flapped on the small entries.
 *
 * `measuredMs` is therefore a live input on both sides; `mechanisms` names the
 * integration-shaped work the file does, which is why it is listed. An entry
 * whose `measuredMs × LISTED_HEADROOM_FACTOR` is at or under its tier budget
 * bounds nothing an unlisted file is not already bound to: the allowlist test
 * refuses it, and the seed script prints `DELIST` for one that has become so.
 *
 * To re-seed a tier, save the serial root run's output and feed it in:
 *
 *     gh api repos/<owner>/<repo>/actions/jobs/<coverage job id>/logs > cov.log
 *     bun run seed:test-tier-budget unit cov.log   # or integration / system
 *
 * (locally, `bun run test:<tier>:serial > <log>` — but
 * the floor's numbers are the ones judged, so prefer the CI log). The seed
 * script prints, in this file's shape, every file that measured OVER its tier
 * budget plus every file already listed (with its fresh measurement),
 * classifying each file's reason by what its source does. It never proposes an
 * entry for a file under budget, and never reads a turbo log.
 * Review before pasting: the list may only shrink, so a re-seed is for
 * REPLACING entries that moved, never for adding a new slow file without a
 * reason.
 */

export type TestTier = 'unit' | 'integration' | 'system';

/** Per-FILE wall-clock budget for each tier, in milliseconds. */
export const TIER_BUDGET_MS: Readonly<Record<TestTier, number>> = {
  unit: 1_000,
  integration: 5_000,
  system: 30_000,
};

/**
 * A LISTED file may run up to this many times its own `measuredMs` (never
 * less than its tier budget) before the reporter fails the run. See the header
 * for the measured noise this covers.
 *
 * The 8× covers the spread between the serial runs that judge: the CI floor
 * against a local machine (about 2× either way), and the same runner on
 * different days. It was never wide enough for a turbo lane, where a file
 * reads 3–20× its own cost depending on its neighbours — which is why no
 * turbo lane judges (see `rootSerialReporters` in vitest.shared.ts).
 */
export const LISTED_HEADROOM_FACTOR = 8;

/**
 * A LISTED file that runs under this fraction of its own `measuredMs` is a
 * stale entry: the reporter fails the run until the entry is deleted.
 */
export const STALE_FRACTION = 0.1;

/**
 * The integration-shaped mechanisms a spec file can be slow for. The seed
 * script classifies a file by matching its source against one signature per
 * mechanism; `unclassified` is an honest "measured only" and a prompt for the
 * person listing the file to say why.
 */
export const MECHANISM = {
  tempTree: 'real temp tree',
  git: 'git subprocess',
  refusal: 'permission-refusal fixture',
  spawn: 'spawns a process',
  nativeModel: 'native model or vector store',
  network: 'network',
  workerPool: 'worker pool',
  projection: 'projection population',
  eslint: 'in-process ESLint',
  symlinks: 'real symlinks',
  unclassified: 'unclassified — measured only',
} as const;

export type Mechanism = (typeof MECHANISM)[keyof typeof MECHANISM];

export interface TestTierBudgetEntry {
  /** Repo-relative, forward-slash path of the spec file. */
  readonly file: string;
  /**
   * Duration measured when the entry was written, in milliseconds. Over the
   * tier's budget = the entry is an over-budget finding; under it = the file
   * merely hovers near enough that load noise could red the gate. The stale
   * line is `STALE_FRACTION` of this number.
   */
  readonly measuredMs: number;
  /** The integration-shaped work that makes the file slow — the reason it is listed. */
  readonly mechanisms: readonly Mechanism[];
  /** Free-text reason where the mechanism list does not say enough. */
  readonly note?: string;
}

/** Tier a spec file belongs to, by its filename suffix; `undefined` for a non-spec file. */
export function tierOf(file: string): TestTier | undefined {
  if (file.endsWith('.system.test.ts')) return 'system';
  if (file.endsWith('.integration.test.ts')) return 'integration';
  if (file.endsWith('.test.ts')) return 'unit';
  return undefined;
}

/**
 * Seeded from the SERIAL root-config runs — one vitest process, one file at a
 * time — the same runs that judge the ratchet (see `rootSerialReporters` in
 * vitest.shared.ts): the unit tier from the CI coverage job's log (Linux, the
 * Node floor), integration and system from the same configs. Re-seed with
 * `bun run seed:test-tier-budget <tier> <log>` from the coverage job's log.
 * Unit entries first, then integration, then system; slowest first within a tier.
 */
export const TEST_TIER_BUDGET_ALLOWLIST: readonly TestTierBudgetEntry[] = [
  { file: 'packages/claude-marketplace/test/org/org-api-client.test.ts', measuredMs: 11576, mechanisms: [MECHANISM.unclassified], note: '102 cases driving an injected https transport through connect/inactivity timeouts and retry delays on real timers' },
  { file: 'packages/dev-tools/test/eslint-allowlist-ratchets.test.ts', measuredMs: 9124, mechanisms: [MECHANISM.eslint] },
  { file: 'packages/resources/test/parse-pool.test.ts', measuredMs: 6201, mechanisms: [MECHANISM.tempTree, MECHANISM.workerPool] },
  { file: 'packages/claude-marketplace/test/permission-matcher.test.ts', measuredMs: 5845, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/resources/test/projection-blob-population-pool.test.ts', measuredMs: 2583, mechanisms: [MECHANISM.workerPool, MECHANISM.projection] },
  { file: 'packages/lab/test/parse-capture.test.ts', measuredMs: 2147, mechanisms: [MECHANISM.tempTree, MECHANISM.workerPool] },
  { file: 'packages/cli/test/commands/corpus/runner.test.ts', measuredMs: 1933, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal, MECHANISM.spawn] },
  { file: 'packages/resources/test/projection-crawl-source-refused-listing.test.ts', measuredMs: 1886, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/dev-tools/test/local-eslint-rule-enablement.test.ts', measuredMs: 1733, mechanisms: [MECHANISM.eslint] },
  { file: 'packages/cli/test/org-skill-upload-payload.test.ts', measuredMs: 1728, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/lab/test/io-capture.test.ts', measuredMs: 1599, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/lab/test/subject.test.ts', measuredMs: 1574, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/agent-skills/test/validators/packaging-validator.test.ts', measuredMs: 1396, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/cli/test/org-skills-adopter-findings.test.ts', measuredMs: 1347, mechanisms: [MECHANISM.tempTree, MECHANISM.refusal], note: 'import of the org/skills command module dominates' },
  { file: 'packages/lab/test/io-counter.test.ts', measuredMs: 1328, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn] },
  { file: 'packages/lab/test/perf-capture.test.ts', measuredMs: 1316, mechanisms: [MECHANISM.unclassified], note: 'repeats real child-process runs to build the statistic under test' },
  { file: 'packages/lab/test/instrument.test.ts', measuredMs: 1310, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn], note: 'local serial run; 762 ms on the floor' },
  { file: 'packages/cli/test/commands/audit/distributed-tree.test.ts', measuredMs: 1220, mechanisms: [MECHANISM.tempTree, MECHANISM.git], note: 'local serial run; 885 ms on the floor' },
  { file: 'packages/agent-skills/test/skill-source/url-source.test.ts', measuredMs: 1162, mechanisms: [MECHANISM.tempTree, MECHANISM.git], note: 'a real bare repo and a clone per resolve; 362–1162 ms across four floor runs' },
  { file: 'packages/agent-skills/test/skill-packager.test.ts', measuredMs: 1136, mechanisms: [MECHANISM.tempTree, MECHANISM.refusal] },
  { file: 'packages/resources/test/projection-filesystem-extent.test.ts', measuredMs: 1120, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/projection-sqlite/test/store.test.ts', measuredMs: 1025, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/cli/test/commands/resources-check-payload.test.ts', measuredMs: 1024, mechanisms: [MECHANISM.unclassified], note: 'import of the resources command module dominates; the 56 cases touch no disk' },
  { file: 'packages/lab/test/population-capture.test.ts', measuredMs: 1021, mechanisms: [MECHANISM.unclassified], note: 'captures a real projection population; local serial run; 836 ms on the floor' },
  // Integration: seeded from the coverage job's first serial run on the floor.
  { file: 'packages/cli/test/integration/cli-basics.integration.test.ts', measuredMs: 11713, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  { file: 'packages/dev-tools/test/integration/no-unsafe-backlog-ratchet.integration.test.ts', measuredMs: 10688, mechanisms: [MECHANISM.eslint] },
  { file: 'packages/cli/test/integration/projection-skill-extent-corpus.integration.test.ts', measuredMs: 7876, mechanisms: [MECHANISM.git, MECHANISM.projection] },
  { file: 'packages/claude-marketplace/test/integration/inventory-extent-corpus.integration.test.ts', measuredMs: 6584, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.projection] },
  { file: 'packages/cli/test/integration/module-load-budget.integration.test.ts', measuredMs: 6102, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  { file: 'packages/cli/test/integration/claude-budget.integration.test.ts', measuredMs: 5810, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  { file: 'packages/cli/test/integration/audit-unreadable-path.integration.test.ts', measuredMs: 5651, mechanisms: [MECHANISM.tempTree, MECHANISM.refusal], note: '4810 ms on the floor run before' },
  { file: 'packages/rag-lancedb/test/integration/indexing.integration.test.ts', measuredMs: 5483, mechanisms: [MECHANISM.tempTree, MECHANISM.nativeModel] },
  { file: 'packages/cli/test/integration/multi-plugin-marketplace.integration.test.ts', measuredMs: 5312, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn], note: 'local serial run; 4671 and 4942 ms on the floor' },
  // Two hover entries, listed by hand, not by the seed tool: within 2 % of the budget on a
  // floor run that read 15–20 % slower than the one before it, so the next such run crosses.
  { file: 'packages/resource-compiler/test/integration/transformer.integration.test.ts', measuredMs: 4953, mechanisms: [MECHANISM.tempTree], note: 'a real TypeScript program per case; 4008 and 4953 ms on the floor' },
  { file: 'packages/cli/test/integration/audit-git-url.integration.test.ts', measuredMs: 4906, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn], note: 'a real bare repo cloned by the audit pipeline; 4226 and 4906 ms on the floor' },
  // System: bootstrapped from a local serial run; the coverage job's system step (after the
  // integration step first passes) is the measurement to re-seed from.
  { file: 'packages/rag-lancedb/test/system/large-scale-filtering.system.test.ts', measuredMs: 43119, mechanisms: [MECHANISM.nativeModel] },
];
