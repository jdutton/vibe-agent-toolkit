#!/usr/bin/env tsx
/**
 * check-test-heap-budget — fails loud & NAMED when a vitest spec FILE's peak
 * heap balloons, instead of letting it surface as a silent CI OOM weeks
 * later. Re-runs `vitest --logHeapUsage` for a small, explicit set of
 * currently-heavy package/suite pairs (NOT a repo-wide re-run — that would
 * duplicate the turbo-cached test:integration/test:system work and double CI
 * time for no benefit).
 *
 * Runs as its own standalone CI job (.github/workflows/test-heap-guard.yml,
 * Linux only), NOT as part of `bun run validate` / the pre-commit hook —
 * it re-executes vitest directly rather than through turbo, so it can't
 * cache-hit even when the target packages are unchanged, and paying that
 * cost on every local commit was a bigger tax than the local-feedback value
 * (see PR #144 discussion). CI-only is an acceptable delay for this check:
 * it fails the PR, not silently ships.
 *
 * Scoped deliberately: rag-lancedb's real memory risk (LanceDB's Arrow
 * engine, onnxruntime models) lives in native addon memory, entirely
 * invisible to --logHeapUsage / --max-old-space-size — that risk is already
 * bounded by maxWorkers in vitest.shared.ts, not by this guard. This guard
 * covers the JS-heap risk (e.g. resource-compiler's TS Language Service).
 *
 * Run: `bun run guard:test-heap` (or `tsx packages/dev-tools/src/check-test-heap-budget.ts`).
 * Flags: --budget=<MB> (default 600), --cwd=<pkgDir> --suite=<integration|system>
 * (both repeatable; pairing a --cwd with a --suite overrides the default
 * target list entirely — pass one --cwd/--suite pair per target).
 * Exit 0 = clean, 1 = over budget or a measurement failure.
 */
import { safePath } from '@vibe-agent-toolkit/utils';

import { PROJECT_ROOT, isEntrypoint, log, safeExecResult } from './common.js';

/** Default per-FILE heap ceiling, in MB. ~1.5x headroom over the heaviest
 * measured file (resource-compiler's transformer.integration.test.ts, up to
 * 382MB across repeated runs — forks are reused across files under
 * maxWorkers:2, so heap varies with what ran earlier in the same fork; budget
 * headroom must cover that variance, not just one sample). Well under the
 * 1024MB per-fork execArgv cap in vitest.shared.ts. */
export const DEFAULT_BUDGET_MB = 600;

export type TestSuite = 'integration' | 'system';

export interface PackageHeapTarget {
  readonly dir: string;
  readonly suites: readonly TestSuite[];
}

/** Packages with a measured heap risk, and which suites to check for each.
 * resource-compiler has no system tests (integration only); cli has both. */
export const DEFAULT_TARGETS: readonly PackageHeapTarget[] = [
  { dir: 'packages/resource-compiler', suites: ['integration'] },
  { dir: 'packages/cli', suites: ['integration', 'system'] },
];

export interface HeapEntry {
  readonly file: string;
  readonly heapMB: number;
}

/**
 * Extract file path and heap size from a regex match result.
 * Ensures match has both capture groups before converting.
 */
function extractHeapEntry(match: RegExpExecArray): HeapEntry | null {
  const filePath = match[1];
  const heapStr = match[2];
  if (!filePath || !heapStr) {
    return null;
  }
  return { file: filePath, heapMB: Number(heapStr) };
}

/**
 * Parse `vitest run --logHeapUsage --reporter=verbose` output into per-file
 * heap entries, keeping each file's PEAK reading.
 *
 * 🚨 **The line shape changed in vitest 4 and this guard failed closed until it
 * was taught the new one.** Vitest 3's default reporter printed one summary
 * line per spec FILE and `--logHeapUsage` appended a heap column to it:
 *   ` ✓ test/integration/foo.integration.test.ts (11 tests) 4886ms 660 MB heap used`
 * Vitest 4's default reporter does not list passing files at all, so there was
 * nothing for the heap column to attach to and the parse returned ZERO entries
 * — which the caller correctly treats as a measurement failure rather than as a
 * pass. `--reporter=verbose` brings the lines back, but one per TEST:
 *   ` ✓ test/integration/foo.integration.test.ts > suite > case 310ms 182 MB heap used`
 *
 * ⇒ Group by file and keep the MAX. That is what "this file's heap" always
 * meant — the v3 line was itself a reading taken as the file finished, and a
 * per-test maximum is a strictly tighter measurement of the same quantity, so
 * the budget keeps its meaning instead of quietly acquiring a new one.
 *
 * Pure + exported so the unit test exercises it against captured fixtures
 * without a real vitest run.
 *
 * @param stdout - Combined vitest output
 * @returns One entry per spec file, carrying that file's peak heap reading
 */
export function parseHeapUsage(stdout: string): HeapEntry[] {
  // Anchored to the "<heap> MB heap used" tail so prose mentioning "MB" cannot
  // match, and to a `.test.ts`-shaped first token so the glyph alone is not
  // enough. Deliberately does NOT require the v3 `(N tests)` group: that group
  // is absent from every verbose per-test line, and requiring it is precisely
  // what made this parser silently see nothing under vitest 4.
  const lineRe = /[✓×❯]\s+(\S+\.test\.[cm]?tsx?)\b.*?\b(\d+)\s*MB heap used/;
  const peakByFile = new Map<string, number>();
  for (const rawLine of stdout.split('\n')) {
    const match = lineRe.exec(rawLine);
    if (!match) continue;
    const entry = extractHeapEntry(match);
    if (!entry) continue;
    const seen = peakByFile.get(entry.file);
    if (seen === undefined || entry.heapMB > seen) peakByFile.set(entry.file, entry.heapMB);
  }
  return [...peakByFile].map(([file, heapMB]) => ({ file, heapMB }));
}

/** vitest's end-of-run spec-FILE tally, as printed on the `Test Files` line. */
export interface TestFileSummary {
  /** Files SCHEDULED for this run — the number inside the trailing parens. */
  readonly total: number;
  /** Files whose every test was skipped; these print no heap line at all. */
  readonly skipped: number;
  /** Files vitest tallies as unimplemented — its fourth file category, spelled
   * `to`+`do` on the line; likewise no heap line. */
  readonly todo: number;
}

// `Test Files  1 failed | 2 passed | 1 skipped (4)`. Split in two on purpose:
// one regex claims the LINE (anchored to `Test Files` so the `Tests  N passed
// (N)` row one line below cannot match), a second pulls the SCHEDULED total off
// its tail. A single pattern spanning both needs a lazy group followed by
// optional whitespace, which backtracks — sonarjs/super-linear-regex reds it,
// and rightly: this parser is fed unbounded subprocess output.
const TEST_FILES_LINE_RE = /^[ \t]*Test Files(.*)$/gm;
const SCHEDULED_TOTAL_RE = /\((\d+)\)$/;
const WHITESPACE_RUN_RE = /\s+/;

/**
 * Read one `<count> <category>` pair out of the breakdown before the parens.
 * Tokenised rather than pattern-matched, so it is linear by construction.
 */
function readCategoryCount(breakdown: string, category: string): number {
  for (const part of breakdown.split('|')) {
    const [count, name] = part.trim().split(WHITESPACE_RUN_RE);
    if (name === category && count) return Number(count);
  }
  return 0;
}

/**
 * Parse vitest's `Test Files … (N)` line, or null when the run never printed one.
 *
 * ⭐ **This is the completeness signal, and it was sitting unread in the output
 * the guard already captured.** `N` is the number of spec files vitest
 * SCHEDULED, so comparing it against the number of files that actually produced
 * a heap reading answers "did I measure the whole suite?" directly — strictly
 * better than trusting an exit code, which a killed worker and a failing
 * assertion set identically.
 *
 * Pure + exported so the unit test drives it from captured output.
 */
export function parseTestFileSummary(stdout: string): TestFileSummary | null {
  // LAST match: a run that reprints the summary (watch mode, a retried batch)
  // ends with the tally that describes the output we just parsed. `.trim()`
  // takes the column padding the line regex deliberately does not consume (a
  // `[ \t]+` next to a `(.*)` overlaps and backtracks) and the `\r` of a CRLF
  // line ending, which `.` matches.
  const tail = [...stdout.matchAll(TEST_FILES_LINE_RE)].at(-1)?.[1]?.trim();
  if (!tail) return null;
  const totalMatch = SCHEDULED_TOTAL_RE.exec(tail);
  const totalStr = totalMatch?.[1];
  if (!totalStr) return null;
  const breakdown = tail.slice(0, totalMatch?.index);
  return {
    total: Number(totalStr),
    skipped: readCategoryCount(breakdown, 'skipped'),
    todo: readCategoryCount(breakdown, 'todo'),
  };
}

/**
 * Why this suite's measurement cannot be trusted, or null when every file that
 * was supposed to report a heap reading did.
 *
 * 🚨 **The scenario this exists for: a worker killed mid-file exits 1 through
 * `status`, not through `error`, and the files that already finished still
 * print their heap lines.** So `entries.length === 0` is false, no entry is over
 * budget, and the guard reported GREEN on exactly the run it exists to catch —
 * the unmeasured file being, by construction, the one that blew the memory.
 * The same shape covers a `maxBuffer` truncation, which likewise leaves SOME
 * heap lines parseable.
 *
 * ⚠️ A fully-skipped file prints `↓ file > name` with no heap column and is
 * absent from the measured set by design, so it is subtracted out of the
 * expectation rather than red-flagged — vitest counts it under `skipped` (and
 * an entirely-unimplemented file under its own category) on the very line this
 * reads.
 *
 * Pure + exported: the fail-closed branch is the whole point of the guard and
 * must be testable without spawning vitest.
 *
 * @param stdout - Combined vitest output
 * @param measuredFileCount - How many files `parseHeapUsage` produced entries for
 * @param exitStatus - vitest's exit status (-1 when it could not be determined)
 * @returns A human-readable reason, or null when the measurement is complete
 */
export function findIncompleteMeasurement(
  stdout: string,
  measuredFileCount: number,
  exitStatus: number,
): string | null {
  if (measuredFileCount === 0) {
    return `no per-file heap lines parsed (vitest exit ${exitStatus}) — did vitest run, or did a fork OOM above the 1024MB cap before printing its heap line?`;
  }
  const summary = parseTestFileSummary(stdout);
  if (!summary) {
    return `vitest printed no "Test Files … (N)" summary line (exit ${exitStatus}), so there is no way to tell whether the ${measuredFileCount} measured file(s) were all of them.`;
  }
  const expected = summary.total - summary.skipped - summary.todo;
  if (measuredFileCount < expected) {
    return `measured ${measuredFileCount} of ${expected} spec file(s) that should have reported heap (vitest exit ${exitStatus}; "Test Files … (${summary.total})" with ${summary.skipped} skipped, ${summary.todo} todo). A worker killed mid-file still prints heap lines for the files that finished, so the UNMEASURED file is the likeliest one over budget.`;
  }
  return null;
}

/** The entries that exceed the budget (strictly greater). Pure + exported. */
export function findHeapBudgetViolations(entries: readonly HeapEntry[], budgetMB: number): HeapEntry[] {
  return entries.filter((e) => e.heapMB > budgetMB);
}

interface CliOptions {
  budgetMB: number;
  targets: PackageHeapTarget[];
}

/**
 * Parse a --cwd/--suite pair and add to targets. Returns true if consumed
 * a pair (so caller can skip the next argument), false otherwise.
 */
function tryParseCwdSuitePair(
  arg: string,
  nextArg: string | undefined,
  customTargets: PackageHeapTarget[],
): boolean {
  const cwdMatch = /^--cwd=(.+)$/.exec(arg);
  if (!cwdMatch) {
    return false;
  }
  const dir = cwdMatch[1];
  if (!dir) {
    return false;
  }
  const suiteMatch = nextArg ? /^--suite=(integration|system)$/.exec(nextArg) : null;
  if (!suiteMatch) {
    throw new Error(
      `check-test-heap-budget: --cwd=${dir} must be immediately followed by --suite=<integration|system>`,
    );
  }
  const suite = suiteMatch[1];
  if (!suite) {
    return false;
  }
  customTargets.push({ dir, suites: [suite as TestSuite] });
  return true;
}

/** Exported so the unit test can exercise argv parsing without spawning the CLI. */
export function parseArgs(argv: readonly string[]): CliOptions {
  let budgetMB = DEFAULT_BUDGET_MB;
  const customTargets: PackageHeapTarget[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i += 1;
      continue;
    }
    const budgetMatch = /^--budget=(\d+)$/.exec(arg);
    if (budgetMatch) {
      const budgetStr = budgetMatch[1];
      if (budgetStr) {
        budgetMB = Number(budgetStr);
      }
      i += 1;
    } else {
      const nextArg = argv[i + 1];
      if (tryParseCwdSuitePair(arg, nextArg, customTargets)) {
        i += 2;
      } else {
        i += 1;
      }
    }
  }
  return { budgetMB, targets: customTargets.length > 0 ? customTargets : [...DEFAULT_TARGETS] };
}

/** One suite's raw measurement: everything vitest printed, plus how it exited. */
export interface SuiteRun {
  readonly output: string;
  /** vitest's exit status. -1 when spawnSync could not determine one. */
  readonly status: number;
}

/**
 * Run vitest with heap logging for one package+suite.
 *
 * Exported so a caller can drive a real run; the DECISION this feeds —
 * `findIncompleteMeasurement` — is pure and unit-tested separately, because a
 * function that spawns vitest can only ever be covered by an integration test.
 */
export function measureSuite(pkgDir: string, suite: TestSuite): SuiteRun {
  const cwd = safePath.join(PROJECT_ROOT, pkgDir);
  const configFile = suite === 'integration' ? 'vitest.integration.config.ts' : 'vitest.system.config.ts';
  // `--logHeapUsage` only ADDS the heap column to the default reporter — it
  // does not change what runs, so this is the real suite's peak per file.
  // safeExecResult resolves npx via which.sync + spawns shell-free (no S4036
  // search-path risk) and returns a result object rather than throwing,
  // matching how this guard reads stdout+stderr regardless of exit code.
  const result = safeExecResult('npx', ['vitest', 'run', '--config', configFile, '--logHeapUsage', '--no-color', '--reporter=verbose'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    // 🚨 EXPLICIT, because `--reporter=verbose` made the old default dangerous.
    // `spawnSync`'s default `maxBuffer` is 1 MiB, and exceeding it TRUNCATES
    // stdout while still handing back the bytes it did capture. Under vitest 3
    // this guard read one line per FILE and could not get near that; verbose
    // prints one line per TEST, measured at ~183 bytes each on this tree
    // (2.14 MB for 11,680 tests), so the limit lands around 5,700 tests. A
    // truncated stream still parses SOME heap lines, so it would sail past a
    // "no lines parsed" check and silently under-measure — the suite would
    // grow past the budget and this guard would report it as fine. (The
    // `Test Files … (N)` completeness check in `findIncompleteMeasurement` now
    // also catches that shape; this limit stops it arising in the first place.)
    maxBuffer: 256 * 1024 * 1024,
  });
  // Fail closed on a spawn-level failure — ENOBUFS above all, but any of them.
  // `spawnSync` reports these on `error` and NOT through the exit status, which
  // is why the status is carried out separately rather than conflated with it.
  if (result.error) {
    throw new Error(
      `check-test-heap-budget: could not capture vitest output for ${cwd} (${configFile}): `
      + `${result.error.message}. Refusing to measure a partial stream.`,
    );
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return { output: `${stdout}\n${stderr}`, status: result.status };
}

function main(): void {
  const { budgetMB, targets } = parseArgs(process.argv.slice(2));
  const allViolations: HeapEntry[] = [];
  let measuredFiles = 0;

  for (const target of targets) {
    for (const suite of target.suites) {
      const { output, status } = measureSuite(target.dir, suite);
      const parsed = parseHeapUsage(output);
      // Completeness BEFORE budget: a partial run's violations list is a
      // statement about the files that survived, not about the suite.
      const incomplete = findIncompleteMeasurement(output, parsed.length, status);
      if (incomplete) {
        log(`check-test-heap-budget: ${target.dir} (${suite}): ${incomplete} Failing closed.`, 'red');
        process.exitCode = 1;
        return;
      }
      const entries = parsed.map((e) => ({ ...e, file: `${target.dir}/${e.file}` }));
      measuredFiles += entries.length;
      allViolations.push(...findHeapBudgetViolations(entries, budgetMB));
    }
  }

  if (allViolations.length > 0) {
    log(`\ncheck-test-heap-budget: ${allViolations.length} spec file(s) over the ${budgetMB} MB per-file heap budget:`, 'red');
    // Sort a COPY (heaviest first) — Array.sort mutates in place.
    for (const v of [...allViolations].sort((a, b) => b.heapMB - a.heapMB)) {
      log(`  ${v.heapMB} MB  ${v.file}`, 'red');
    }
    log(
      '\nvitest isolates per file, so a file\'s peak heap is its whole live set. Split the ' +
        'file into per-concern spec files or cut per-test setup. A balloon here would ' +
        'otherwise OOM / time out the CI fork.\n',
      'red',
    );
    process.exitCode = 1;
    return;
  }

  log(`check-test-heap-budget: ${measuredFiles} spec file(s) all within the ${budgetMB} MB per-file heap budget across ${targets.length} package(s).`, 'green');
}

// Only run the CLI when invoked directly, not when imported by the unit test.
// `isEntrypoint`, not a raw `argv[1]` string compare: the compare has no
// realpath pass and is false through any symlinked invocation.
if (isEntrypoint(import.meta.url)) {
  main();
}
