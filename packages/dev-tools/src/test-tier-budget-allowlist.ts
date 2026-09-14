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
 * ⚠️ Durations are noisy, and by more than intuition says. MEASURED on this
 * tree: the same small file reads 2–4× slower under turbo (two workers per
 * package, packages in parallel) than in one serial vitest process; between a
 * QUIET turbo seed and a turbo tier run while the box carries other load, a
 * listed file read 3.3–7.3× its seed (eight files in one run, a different
 * eight the next); and CI runners are slower again than the dev box. The
 * factor and the fraction are what keep the ratchet from flapping on that
 * noise:
 *
 *   - `LISTED_HEADROOM_FACTOR` (8×) covers that swing with a little to spare,
 *     and the ceiling never drops below the tier budget, so a listed file is
 *     never held to less than an unlisted one. 3× was tried first and failed
 *     four consecutive gates on four different sets of files;
 *   - a listed file is STALE only under `STALE_FRACTION` of what it measured
 *     when listed — a 10× improvement. A budget-relative stale line was tried
 *     first and flapped: ten entries seeded at 100–200 ms under turbo ran at
 *     17–48 ms serially. Even the entry-relative line is crossed by a SERIAL
 *     run of the heaviest files (measured: 7 647 ms under turbo, 558 ms
 *     serially — 13×), so the stale side is judged only where the seeds come
 *     from, the per-package turbo runs; the three root configs' serial runs judge
 *     the ceilings only (`judgeStale: false`).
 *
 * `measuredMs` is therefore a live input on both sides; `mechanisms` names the
 * integration-shaped work the file does, which is why it is listed. An entry
 * whose `measuredMs × LISTED_HEADROOM_FACTOR` is at or under its tier budget
 * bounds nothing an unlisted file is not already bound to: the allowlist test
 * refuses it, and the seed script prints `DELIST` for one that has become so.
 *
 * To re-seed after an uncached run of a tier:
 *
 *     bun run test:unit                      # or test:integration / test:system
 *     bun run seed:test-tier-budget unit
 *
 * The seed script parses the per-package turbo logs and prints, in this
 * file's shape, every file that measured OVER its tier budget plus every file
 * already listed (with its fresh measurement), classifying each file's reason
 * by what its source does. It never proposes an entry for a file under budget.
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
 * ⚠️ Known gap: a file can swing 3–20× between a run alone and a loaded turbo
 * tier (spawn-heavy files worst), so 8× is a margin over LOAD, not a statement
 * about the file. An entry seeded from the turbo number then trips the stale
 * line (a tenth of it) wherever the file runs fast, and one seeded from the
 * run-alone number has no ceiling left for contention. The entries marked
 * `contention seed` are listed at `max(alone, turbo / 4)`: the ceiling clears
 * the turbo reading with half the headroom kept for run-to-run variance, and
 * the stale line stays under the fastest run seen. A per-mechanism factor or a
 * CPU-time measurement would be the honest instrument; until then an
 * `OVER HEADROOM` or `STALE ENTRY` on such an entry is contention, and the
 * remedy is to re-seed from both readings by the same rule.
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
 * Seeded from the turbo logs of one uncached macOS run of each tier (2 vitest
 * workers per package, packages in parallel), via `test-tier-budget-seed.ts`.
 * Unit entries first, then integration, then system; slowest first within a tier.
 */
export const TEST_TIER_BUDGET_ALLOWLIST: readonly TestTierBudgetEntry[] = [
  { file: 'packages/lab/test/subject.test.ts', measuredMs: 28847, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/resources/test/projection-crawl-source-refused-listing.test.ts', measuredMs: 26194, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/resources/test/projection-filesystem-extent.test.ts', measuredMs: 21860, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/lab/test/instrument.test.ts', measuredMs: 13661, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/utils/test/git-snapshot-cache.test.ts', measuredMs: 11915, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/utils/test/file-crawler-git-refused-listing.test.ts', measuredMs: 11843, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/claude-marketplace/test/org/org-api-client.test.ts', measuredMs: 11547, mechanisms: [MECHANISM.unclassified], note: '102 cases driving an injected https transport through connect/inactivity timeouts and retry delays on real timers' },
  { file: 'packages/cli/test/commands/audit/distributed-tree.test.ts', measuredMs: 11535, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/agent-skills/test/skill-source/url-source.test.ts', measuredMs: 11311, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/lab/test/parse-capture.test.ts', measuredMs: 10677, mechanisms: [MECHANISM.tempTree, MECHANISM.workerPool] },
  { file: 'packages/cli/test/utils/projection-store.test.ts', measuredMs: 10225, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal, MECHANISM.projection] },
  // Re-seeded from two consecutive full turbo unit tiers (8 789 / 10 031 ms);
  // 416 ms serially — a 21× contention swing on a git-spawning file, well past
  // the 2–4× the header describes for small files. Wall-clock under turbo is a
  // poor instrument for spawn-heavy files; see the `LISTED_HEADROOM_FACTOR` note.
  { file: 'packages/utils/test/git-tracker-snapshot-priming.test.ts', measuredMs: 8789, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn] },
  { file: 'packages/dev-tools/test/validate-repo-structure.test.ts', measuredMs: 7647, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/agent-skills/test/skill-test/run-harness-grading-nonce.test.ts', measuredMs: 6732, mechanisms: [MECHANISM.unclassified], note: 'runs the skill-test harness end to end against a fixture harness dir (real files, forged-grading cases)' },
  { file: 'packages/lab/test/io-capture.test.ts', measuredMs: 5699, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/resources/test/parse-pool.test.ts', measuredMs: 5480, mechanisms: [MECHANISM.tempTree, MECHANISM.workerPool] },
  { file: 'packages/claude-marketplace/test/permission-matcher.test.ts', measuredMs: 5430, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  // Generalised from the commands-import-boundary ratchet test to a table over
  // three allowlists (~170 files linted with a bare parser). Seeded from the
  // full turbo unit tier (4 663 ms); it reads 1 227 ms serially — the 3.8×
  // swing the header describes.
  { file: 'packages/dev-tools/test/eslint-allowlist-ratchets.test.ts', measuredMs: 4663, mechanisms: [MECHANISM.eslint] },
  { file: 'packages/cli/test/commands/corpus/runner.test.ts', measuredMs: 3709, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal, MECHANISM.spawn] },
  { file: 'packages/resources/test/projection-resource-population.test.ts', measuredMs: 3488, mechanisms: [MECHANISM.git, MECHANISM.projection] },
  { file: 'packages/lab/test/perf-capture.test.ts', measuredMs: 3472, mechanisms: [MECHANISM.unclassified], note: 'repeats real child-process runs to build the statistic under test' },
  { file: 'packages/agent-skills/test/skill-source/git-clone.test.ts', measuredMs: 3233, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/cli/test/commands/claude/plugin/tree-copy.test.ts', measuredMs: 3020, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/cli/test/commands/skills/build-staging.test.ts', measuredMs: 2822, mechanisms: [MECHANISM.tempTree, MECHANISM.refusal] },
  { file: 'packages/resources/test/projection-store-unlistable-freshness.test.ts', measuredMs: 2729, mechanisms: [MECHANISM.git, MECHANISM.refusal, MECHANISM.projection] },
  { file: 'packages/dev-tools/test/local-eslint-rule-enablement.test.ts', measuredMs: 2516, mechanisms: [MECHANISM.eslint] },
  { file: 'packages/cli/test/commands/inventory-shared-registry.test.ts', measuredMs: 2173, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/claude-marketplace/test/inventory/extract-skill.test.ts', measuredMs: 1999, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/resources/test/projection-blob-population-pool.test.ts', measuredMs: 1991, mechanisms: [MECHANISM.workerPool, MECHANISM.projection] },
  { file: 'packages/claude-marketplace/test/projection-plugin-extent.test.ts', measuredMs: 1985, mechanisms: [MECHANISM.projection] },
  { file: 'packages/lab/test/population-capture.test.ts', measuredMs: 1932, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/lab/test/io-counter.test.ts', measuredMs: 1898, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn] },
  { file: 'packages/utils/test/git-tracker-unlistable.test.ts', measuredMs: 1895, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/claude-marketplace/test/inventory/extract-plugin.test.ts', measuredMs: 1710, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/utils/test/git-run.test.ts', measuredMs: 1686, mechanisms: [MECHANISM.git, MECHANISM.spawn] },
  { file: 'packages/discovery/test/local-scanner.test.ts', measuredMs: 1591, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal, MECHANISM.spawn] },
  { file: 'packages/rag-lancedb/test/barrel-exports.test.ts', measuredMs: 1432, mechanisms: [MECHANISM.nativeModel], note: 'importing the barrel loads the native lancedb runtime' },
  { file: 'packages/cli/test/org-skills-adopter-findings.test.ts', measuredMs: 1242, mechanisms: [MECHANISM.tempTree], note: 'hover entry: import of the org/skills command module dominates' },
  { file: 'packages/lab/test/repeat.test.ts', measuredMs: 1166, mechanisms: [MECHANISM.unclassified], note: 'spawns a probe child process per repeat to record clear/run ordering' },
  { file: 'packages/projection-sqlite/test/barrel-exports.test.ts', measuredMs: 1160, mechanisms: [MECHANISM.unclassified], note: 'importing the barrel opens node:sqlite' },
  { file: 'packages/projection-sqlite/test/store.test.ts', measuredMs: 1126, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/cli/test/commands/skills/build-run-ledger.test.ts', measuredMs: 1090, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/agent-skills/test/skill-packager.test.ts', measuredMs: 1005, mechanisms: [MECHANISM.tempTree, MECHANISM.refusal] },
  { file: 'packages/resource-compiler/test/barrel-exports.test.ts', measuredMs: 958, mechanisms: [MECHANISM.unclassified], note: 'hover entry: the barrel pulls in the compiler pipeline' },
  { file: 'packages/lab/test/git-state.test.ts', measuredMs: 896, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
  { file: 'packages/resources/test/resource-registry-pool.test.ts', measuredMs: 890, mechanisms: [MECHANISM.workerPool] },
  { file: 'packages/resource-compiler/test/cli/stdio-blocking.test.ts', measuredMs: 870, mechanisms: [MECHANISM.spawn] },
  { file: 'packages/utils/test/eslint/rules/no-raw-node-path.test.ts', measuredMs: 764, mechanisms: [MECHANISM.eslint], note: 'RuleTester over every safePath spelling; contention seed: 3055 ms in the parallel enforcer, 536 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/resources/test/projection-content-promotion-guard.test.ts', measuredMs: 701, mechanisms: [MECHANISM.git, MECHANISM.projection] },
  { file: 'packages/resources/test/link-parser.test.ts', measuredMs: 623, mechanisms: [MECHANISM.tempTree], note: '101 parser cases; contention seed: 2491 ms in the parallel enforcer, 288 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/resources/test/projection-git-extent-symlink.test.ts', measuredMs: 585, mechanisms: [MECHANISM.git, MECHANISM.symlinks] },
  { file: 'packages/resources/test/parser-unavailable-error.test.ts', measuredMs: 569, mechanisms: [MECHANISM.refusal] },
  { file: 'packages/resources/test/projection-store-roundtrip.test.ts', measuredMs: 562, mechanisms: [MECHANISM.git, MECHANISM.projection], note: 'contention seed: 2246 ms in the parallel enforcer, 230 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/cli/test/commands/audit/nested-skill-crawl.test.ts', measuredMs: 556, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/resources/test/projection-filesystem-extent-symlink.test.ts', measuredMs: 552, mechanisms: [MECHANISM.symlinks] },
  { file: 'packages/utils/test/eslint/autofix-fixpoint.test.ts', measuredMs: 545, mechanisms: [MECHANISM.tempTree, MECHANISM.eslint], note: 'runs the linter to a fixpoint per case; contention seed: 2177 ms in the parallel enforcer, 385 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/resources/test/projection-untracked-symlink-extent.test.ts', measuredMs: 539, mechanisms: [MECHANISM.symlinks] },
  { file: 'packages/utils/test/timing-dump.test.ts', measuredMs: 524, mechanisms: [MECHANISM.tempTree, MECHANISM.workerPool] },
  { file: 'packages/utils/test/eslint/rules/prefer-startswith-over-regex.test.ts', measuredMs: 524, mechanisms: [MECHANISM.eslint], note: 'RuleTester, 81 cases; contention seed: 2096 ms in the parallel enforcer, 261 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/resources/test/projection-blob-population.test.ts', measuredMs: 518, mechanisms: [MECHANISM.projection], note: 'contention seed: 2069 ms in the parallel enforcer, 202 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/resources/test/parse-cache.test.ts', measuredMs: 509, mechanisms: [MECHANISM.tempTree, MECHANISM.projection], note: 'contention seed: 2033 ms in the parallel enforcer, 284 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/utils/test/unreadable-policy-required.test.ts', measuredMs: 509, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/cli/test/commands/resources-check-payload.test.ts', measuredMs: 497, mechanisms: [MECHANISM.unclassified] },
  { file: 'packages/agent-skills/test/validators/packaging-validator.test.ts', measuredMs: 489, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/agent-skills/test/skill-test/run-harness.test.ts', measuredMs: 477, mechanisms: [MECHANISM.tempTree, MECHANISM.refusal] },
  { file: 'packages/lab/test/run.test.ts', measuredMs: 454, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  { file: 'packages/resources/test/external-link-validator-auth.test.ts', measuredMs: 447, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn], note: 'contention seed: 1786 ms in the parallel enforcer, 200 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/agent-skills/test/files-config.test.ts', measuredMs: 435, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal] },
  { file: 'packages/resources/test/okf/validate.test.ts', measuredMs: 425, mechanisms: [MECHANISM.refusal] },
  { file: 'packages/rag-lancedb/test/index-resources-interrupted.test.ts', measuredMs: 420, mechanisms: [MECHANISM.nativeModel], note: 'contention seed: 1677 ms in the parallel enforcer, 197 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/cli/test/commands/skills/validate-non-skill-discovered.test.ts', measuredMs: 415, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/vat-example-cat-agents/test/conversational-demo.test.ts', measuredMs: 395, mechanisms: [MECHANISM.unclassified] },
  { file: 'packages/agent-skills/test/projection-skill-extent.test.ts', measuredMs: 392, mechanisms: [MECHANISM.tempTree, MECHANISM.projection] },
  { file: 'packages/agent-skills/test/builder.test.ts', measuredMs: 391, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/agent-skills/test/validators/referenced-path-missing.test.ts', measuredMs: 372, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/cli/test/org-skill-upload-payload.test.ts', measuredMs: 367, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/projection-sqlite/test/query.test.ts', measuredMs: 328, mechanisms: [MECHANISM.unclassified], note: 'opens an ephemeral node:sqlite store and writes two blobs per test, 67 tests; contention seed: 1312 ms in the parallel enforcer, 234 ms alone; listed at max(alone, parallel/4)' },
  // Seeded from the serial, coverage-instrumented CI run (`test:coverage`).
  { file: 'packages/agent-skills/test/skill-test/baseline-integrity.test.ts', measuredMs: 311, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn], note: '358 cases; contention seed: 1243 ms in the parallel enforcer, 267 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/rag-lancedb/test/index-resources-parser-load.test.ts', measuredMs: 297, mechanisms: [MECHANISM.nativeModel], note: 'contention seed: 1187 ms in the parallel enforcer, 147 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/rag/test/barrel-exports.test.ts', measuredMs: 286, mechanisms: [MECHANISM.unclassified], note: 'importing the barrel; contention seed: 1143 ms in the parallel enforcer, 140 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/utils/test/fs-utils.test.ts', measuredMs: 276, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn], note: 'contention seed: 1102 ms in the parallel enforcer, 121 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/rag/test/chunking/chunk-by-tokens.test.ts', measuredMs: 260, mechanisms: [MECHANISM.unclassified], note: 'pure chunker over a fake token counter; contention seed: 1037 ms in the parallel enforcer, 183 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/resources/test/content-transform.test.ts', measuredMs: 259, mechanisms: [MECHANISM.projection], note: '117 cases; contention seed: 1033 ms in the parallel enforcer, 141 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/cli/test/integration/cli-basics.integration.test.ts', measuredMs: 8109, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  // A typed program over the 23 `NO_UNSAFE_BACKLOG` files; measured serially.
  { file: 'packages/dev-tools/test/integration/no-unsafe-backlog-ratchet.integration.test.ts', measuredMs: 7020, mechanisms: [MECHANISM.eslint] },
  { file: 'packages/cli/test/integration/multi-plugin-marketplace.integration.test.ts', measuredMs: 6135, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn] },
  { file: 'packages/cli/test/integration/module-load-budget.integration.test.ts', measuredMs: 5489, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  { file: 'packages/claude-marketplace/test/integration/inventory-extent-corpus.integration.test.ts', measuredMs: 5019, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.projection] },
  { file: 'packages/cli/test/integration/audit-git-url.integration.test.ts', measuredMs: 3833, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn] },
  { file: 'packages/cli/test/integration/claude-budget.integration.test.ts', measuredMs: 3737, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  { file: 'packages/cli/test/integration/plugin-build-what-ships.integration.test.ts', measuredMs: 3654, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/resources/test/integration/git-crawl-io-cost.integration.test.ts', measuredMs: 3340, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn] },
  { file: 'packages/claude-marketplace/test/integration/projection-population.integration.test.ts', measuredMs: 2702, mechanisms: [MECHANISM.git, MECHANISM.projection] },
  { file: 'packages/cli/test/integration/severity-override-escape-hatch.integration.test.ts', measuredMs: 2686, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/cli/test/integration/audit-unreadable-path.integration.test.ts', measuredMs: 2584, mechanisms: [MECHANISM.tempTree, MECHANISM.refusal] },
  { file: 'packages/rag-lancedb/test/integration/indexing.integration.test.ts', measuredMs: 2454, mechanisms: [MECHANISM.tempTree, MECHANISM.nativeModel] },
  { file: 'packages/cli/test/integration/projection-store-cache-control.integration.test.ts', measuredMs: 2441, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  { file: 'packages/cli/test/integration/projection-store-equivalence.integration.test.ts', measuredMs: 2412, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn, MECHANISM.projection] },
  { file: 'packages/rag-lancedb/test/integration/line-tracking.integration.test.ts', measuredMs: 2204, mechanisms: [MECHANISM.nativeModel] },
  { file: 'packages/agent-skills/test/integration/baseline-control.integration.test.ts', measuredMs: 2193, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/cli/test/integration/projection-skill-extent-corpus.integration.test.ts', measuredMs: 2151, mechanisms: [MECHANISM.git, MECHANISM.projection] },
  { file: 'packages/cli/test/integration/resources-scan.integration.test.ts', measuredMs: 2135, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  { file: 'packages/resource-compiler/test/integration/transformer.integration.test.ts', measuredMs: 2091, mechanisms: [MECHANISM.tempTree] },
  { file: 'packages/projection-sqlite/test/integration/store-sharing.integration.test.ts', measuredMs: 2068, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn, MECHANISM.projection] },
  { file: 'packages/dev-tools/test/integration/dist-visibility.integration.test.ts', measuredMs: 2067, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
  { file: 'packages/cli/test/integration/audit-unloadable-config.integration.test.ts', measuredMs: 2066, mechanisms: [MECHANISM.tempTree, MECHANISM.refusal] },
  { file: 'packages/utils/test/integration/safe-exec.integration.test.ts', measuredMs: 2044, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.refusal, MECHANISM.spawn] },
  { file: 'packages/utils/test/integration/git-ignore-oracle-parity.integration.test.ts', measuredMs: 1787, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn], note: 'git check-ignore oracle over 12 planted trees; contention seed: 7148 ms in the parallel enforcer, 1173 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/resources/test/integration/crawl-source-parity.integration.test.ts', measuredMs: 1401, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.projection], note: 'populates a projection over a real temp tree through both crawl sources, 31 cases; contention seed: 5601 ms in the parallel enforcer, 800 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/utils/test/integration/git-utils.integration.test.ts', measuredMs: 1390, mechanisms: [MECHANISM.tempTree, MECHANISM.git, MECHANISM.spawn], note: 'contention seed: 5557 ms in the parallel enforcer, 769 ms alone; listed at max(alone, parallel/4)' },
  { file: 'packages/rag-lancedb/test/system/large-scale-filtering.system.test.ts', measuredMs: 45287, mechanisms: [MECHANISM.nativeModel] },
  { file: 'packages/cli/test/system/claude-context.system.test.ts', measuredMs: 16926, mechanisms: [MECHANISM.tempTree, MECHANISM.spawn] },
];
