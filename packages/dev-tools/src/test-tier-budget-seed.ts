#!/usr/bin/env tsx
/**
 * test-tier-budget-seed — prints allowlist entries for
 * `test-tier-budget-allowlist.ts` from the per-package turbo logs of the last
 * UNCACHED run of a tier.
 *
 * Run: `bun run seed:test-tier-budget <unit|integration|system>`
 * after `bun run test:<tier>` has actually executed (a turbo cache hit replays
 * the old log, which is the old measurement — check the `Duration` stamp).
 *
 * What it prints, exactly: an entry for every file that measured OVER its
 * tier budget, and a refreshed entry for every file ALREADY listed (so a
 * re-seed replaces moved measurements); then a `DELIST` line for every listed
 * file whose fresh measurement × `LISTED_HEADROOM_FACTOR` no longer exceeds
 * the budget — its entry now bounds nothing. It never proposes an entry for a
 * file under budget: a listed file's ceiling is `max(budget, 8 × measuredMs)`,
 * so listing a file that is under budget can only WIDEN its ceiling, and a
 * seed that listed such "hover" files grew the allowlist on every run.
 *
 * The output is a REVIEW aid, not something to paste blind: an entry's reason
 * is derived from what the spec file's source does (real temp trees, git,
 * spawning, permission fixtures, native models, network). "unclassified"
 * means the script could not see why the file is slow, and the person adding
 * the entry has to.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { PROJECT_ROOT, isEntrypoint, log } from './common.js';
import {
  LISTED_HEADROOM_FACTOR,
  MECHANISM,
  TEST_TIER_BUDGET_ALLOWLIST,
  TIER_BUDGET_MS,
  tierOf,
  type Mechanism,
  type TestTier,
  type TestTierBudgetEntry,
} from './test-tier-budget-allowlist.js';

export interface DurationRow {
  /** Repo-relative, forward-slash path. */
  readonly file: string;
  readonly durationMs: number;
}

const ESC = String.fromCodePoint(0x1b);
const SGR_TAIL_RE = /^\[[0-9;]*m/;

/** Strip SGR colour sequences without building a RegExp from a control character. */
function stripAnsi(line: string): string {
  const [head, ...rest] = line.split(ESC);
  return `${head ?? ''}${rest.map((segment) => segment.replace(SGR_TAIL_RE, '')).join('')}`;
}

/**
 * Vitest's per-FILE summary line: ` ✓ test/x.test.ts (24 tests) 28847ms`.
 * The `(N tests …)` group is what separates it from the per-test lines the
 * verbose reporter prints underneath, which carry a name and no group.
 */
const FILE_LINE_RE = /^\s*[✓×❯↓]\s+(\S+\.test\.ts)\s+\(\d+ tests?[^)]*\)\s+(\d+)(ms|s)\b/;

/**
 * Parse one package's turbo log into per-file durations.
 *
 * The first line for a file wins: vitest reprints a file's summary in its
 * end-of-run failure recap, and the recap carries the same number.
 */
export function parseTurboVitestLog(logText: string, pkg: string): DurationRow[] {
  const seen = new Set<string>();
  const rows: DurationRow[] = [];
  for (const rawLine of logText.split('\n')) {
    const match = FILE_LINE_RE.exec(stripAnsi(rawLine));
    if (!match) continue;
    const [, relative, amount, unit] = match;
    if (!relative || !amount) continue;
    const file = `packages/${pkg}/${relative}`;
    if (seen.has(file)) continue;
    seen.add(file);
    rows.push({ file, durationMs: Number(amount) * (unit === 's' ? 1000 : 1) });
  }
  return rows;
}

type MechanismKey = keyof typeof MECHANISM;

/** One source signature per mechanism, in the order the entry lists them. */
const MECHANISM_SIGNATURES: ReadonlyArray<readonly [key: MechanismKey, pattern: RegExp]> = [
  ['tempTree', /mkdtemp|normalizedTmpdir|setupTempDir|TempDirSuite|createTestTempDir|setupTempCorpus|createTempDir|createSuiteContext/],
  ['git', /runGit|git init|makeBareRepo|GitTracker|gitSnapshot|git-snapshot|['"]git['"]/],
  ['refusal', /chmod|refuseSyncFs|refuseAsyncFs|withReaddirRefused|refusingOnly|errno\(|EACCES/],
  ['spawn', /spawnSync|spawnAndCollect|execSync|execFileSync|executeCli|child_process|spawnHardened|runVat|safeExec/],
  ['nativeModel', /lancedb|transformers|onnxruntime|createEmbedding/i],
  ['network', /fetch\(|createServer|\.listen\(/],
  ['workerPool', /ParsePool|createParsePool|new Worker\(|worker_threads/],
  ['projection', /populate\w*\(|projectionStore|openPopulation/],
  ['eslint', /new ESLint\(|new Linter\(|RuleTester/],
  ['symlinks', /symlinkSync|symlink\(/],
];

/** The mechanism keys whose signature the source matches, or `unclassified`. */
export function classifyMechanisms(source: string): MechanismKey[] {
  const keys = MECHANISM_SIGNATURES.filter(([, pattern]) => pattern.test(source)).map(([key]) => key);
  return keys.length > 0 ? keys : ['unclassified'];
}

/** The human-readable form of a classification, as the allowlist entry carries it. */
export function mechanismsOf(keys: readonly MechanismKey[]): Mechanism[] {
  return keys.map((key) => MECHANISM[key]);
}

/**
 * The rows to print as entries, slowest first: every file whose headroom would
 * exceed its tier budget (an entry below that bounds nothing an unlisted file
 * is not already bound to), plus every file already listed, so a re-seed
 * refreshes the measurement the reporter's stale and headroom lines read.
 */
export function selectSeedCandidates(
  rows: readonly DurationRow[],
  budgets: Readonly<Record<TestTier, number>>,
  allowlist: readonly TestTierBudgetEntry[],
): DurationRow[] {
  const listed = new Set(allowlist.map((e) => e.file));
  return rows
    .filter((row) => {
      const tier = tierOf(row.file);
      if (tier === undefined) return false;
      return listed.has(row.file) || row.durationMs > budgets[tier];
    })
    .toSorted((a, b) => b.durationMs - a.durationMs);
}

const MECHANISM_KEY_BY_LABEL = new Map(Object.entries(MECHANISM).map(([key, label]) => [label, key]));

function renderMechanisms(mechanisms: readonly Mechanism[]): string {
  return mechanisms.map((label) => `MECHANISM.${MECHANISM_KEY_BY_LABEL.get(label) ?? 'unclassified'}`).join(', ');
}

function renderNote(note: string | undefined): string {
  if (note === undefined) return '';
  const escaped = note.replaceAll("'", String.raw`\'`);
  return `, note: '${escaped}'`;
}

/**
 * Listed files whose fresh measurement × `LISTED_HEADROOM_FACTOR` no longer
 * exceeds the tier budget: their entries bound nothing any more and should be
 * deleted by hand. The reporter cannot see this — its stale line is a tenth of
 * the entry's own measurement, which a file that merely settled under budget
 * never crosses — which is why the seed prints it.
 */
export function findDelistCandidates(
  rows: readonly DurationRow[],
  allowlist: readonly TestTierBudgetEntry[],
  budgets: Readonly<Record<TestTier, number>>,
): DurationRow[] {
  const listed = new Set(allowlist.map((e) => e.file));
  return rows.filter((row) => {
    const tier = tierOf(row.file);
    return tier !== undefined && listed.has(row.file) && row.durationMs * LISTED_HEADROOM_FACTOR <= budgets[tier];
  });
}

/** Entries in the allowlist module's literal shape, one per line, referencing the `MECHANISM` constants. */
export function renderEntries(entries: readonly TestTierBudgetEntry[]): string {
  return entries
    .map((e) => `  { file: '${e.file}', measuredMs: ${e.measuredMs}, mechanisms: [${renderMechanisms(e.mechanisms)}]${renderNote(e.note)} },\n`)
    .join('');
}

function readTurboLogs(tier: TestTier): DurationRow[] {
  const packagesDir = safePath.join(PROJECT_ROOT, 'packages');
  const rows: DurationRow[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const logPath = safePath.join(packagesDir, pkg, '.turbo', `turbo-test$colon$${tier}.log`);
    if (!existsSync(logPath)) continue;
    rows.push(...parseTurboVitestLog(readFileSync(logPath, 'utf8'), pkg));
  }
  return rows;
}

function main(): void {
  const tier = process.argv[2];
  if (tier !== 'unit' && tier !== 'integration' && tier !== 'system') {
    log('usage: test-tier-budget-seed <unit|integration|system>', 'red');
    process.exitCode = ExitCode.ERROR;
    return;
  }
  const rows = readTurboLogs(tier);
  const candidates = selectSeedCandidates(rows, TIER_BUDGET_MS, TEST_TIER_BUDGET_ALLOWLIST);
  const entries: TestTierBudgetEntry[] = [];
  for (const row of candidates) {
    const sourcePath = safePath.join(PROJECT_ROOT, row.file);
    // The log is a record of the run, and the tree has moved on since: a file
    // renamed or deleted after the run has nothing to list.
    if (!existsSync(sourcePath)) {
      log(`// skipped ${row.file}: measured ${row.durationMs} ms but no longer in the tree`, 'yellow');
      continue;
    }
    entries.push({
      file: row.file,
      measuredMs: row.durationMs,
      mechanisms: mechanismsOf(classifyMechanisms(readFileSync(sourcePath, 'utf8'))),
    });
  }
  log(`// ${tier}: ${entries.length} of ${rows.length} measured files over the budget or already listed`, 'reset');
  process.stdout.write(renderEntries(entries));
  for (const row of findDelistCandidates(rows, TEST_TIER_BUDGET_ALLOWLIST, TIER_BUDGET_MS)) {
    log(`// DELIST: ${row.file} is listed but measured ${row.durationMs} ms — ${LISTED_HEADROOM_FACTOR}× that is within the budget, so its entry bounds nothing`, 'yellow');
  }
}

if (isEntrypoint(import.meta.url)) {
  main();
}
