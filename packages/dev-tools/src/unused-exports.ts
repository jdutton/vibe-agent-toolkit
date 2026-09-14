#!/usr/bin/env tsx
/**
 * unused-exports — the unused-export RATCHET over knip's report.
 *
 * Run: `bun run unused-exports` (the gate), `bun run unused-exports --prune`
 * (drop allowlist entries knip no longer reports), `bun run unused-exports
 * --seed` (rewrite the allowlist from today's report — the one operation that
 * can GROW the list, so it says by how much and is never run by a gate).
 *
 * knip already runs here for dependency hygiene (`bun run dependency-check`,
 * `packages/dev-tools/knip.config.ts`); this asks the same tool its other
 * question — which `export` is referenced by nothing in the project graph —
 * and holds the answer to a list that may only shrink. The list is the
 * mechanism the barrel pins never had: a name can be exported for a test's
 * convenience, but it cannot be exported for nobody without an entry that says
 * so, and an entry cannot outlive the export it excuses.
 *
 * "Unused" is knip's word for it under this repo's knip config, and it is
 * NARROWER than "reached only by a test": knip's vitest plugin makes every
 * `*.test.ts` an entry file, so an export a spec imports is USED and never
 * reported here (`run-harness.ts`'s internal seam object is reached only by
 * tests and is not on the list). What this instrument counts is an export
 * that nothing in `src/**` and no vitest entry file reaches. The `test-only` /
 * `dead` tag on an entry is a hint from a word-boundary search of the test
 * trees (a name reached from a non-entry helper such as `test-helpers.ts`),
 * not a measurement; the convention of folding test-facing helpers into one
 * internal seam object is held by review and by `test/internal-seam.test.ts`,
 * not by this ratchet.
 *
 * Two failures, both exit 1: an export knip reports that the list does not
 * carry (a NEW unused export — import it, delete it, or move it behind the
 * package's `internal.ts`), and an entry knip no longer reports (the export
 * was used or removed — delete the entry, or run `--prune`).
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { isPathAbsentError, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectorySync } from '@vibe-agent-toolkit/utils/crawl';
import { safeExecResult } from '@vibe-agent-toolkit/utils/process';

import { PROJECT_ROOT, isEntrypoint, log } from './common.js';
import {
  UNUSED_EXPORTS_ALLOWLIST_PATH,
  loadUnusedExportsAllowlist,
  type UnusedExportFile,
  type UnusedExportReason,
} from './unused-exports-allowlist.js';

/** The knip issue kinds that are exports (values and types, plain and namespaced). */
const EXPORT_KINDS = ['exports', 'types', 'nsExports', 'nsTypes'] as const;

const KNIP_CONFIG = 'packages/dev-tools/knip.config.ts';

/** One export knip found nothing referencing. */
export interface ReportedExport {
  /** Repo-relative, forward-slash path. */
  readonly file: string;
  readonly name: string;
}

interface KnipIssueFile {
  readonly file: string;
  readonly exports?: readonly { readonly name: string }[];
  readonly types?: readonly { readonly name: string }[];
  readonly nsExports?: readonly { readonly name: string }[];
  readonly nsTypes?: readonly { readonly name: string }[];
}

interface KnipJsonReport {
  readonly issues: readonly KnipIssueFile[];
}

/** Flatten knip's JSON report to the exports it reports, in report order. */
export function reportedExportsOf(report: KnipJsonReport): ReportedExport[] {
  const out: ReportedExport[] = [];
  for (const issue of report.issues) {
    for (const kind of EXPORT_KINDS) {
      for (const entry of issue[kind] ?? []) {
        out.push({ file: toForwardSlash(issue.file), name: entry.name });
      }
    }
  }
  return out;
}

const keyOf = (entry: ReportedExport): string => `${entry.file} ${entry.name}`;

/** One allowlist entry, flattened: the module and one excused name. */
export interface ExcusedExport extends ReportedExport {
  readonly reason: UnusedExportReason;
}

/** The allowlist as one row per excused name. */
export function flattenAllowlist(allowlist: readonly UnusedExportFile[]): ExcusedExport[] {
  return allowlist.flatMap((entry) => entry.unused.map((u) => ({ file: entry.file, name: u.name, reason: u.reason })));
}

/**
 * The two directions of the ratchet.
 *
 * @param reported - What knip reports today
 * @param allowlist - What the list excuses
 * @returns Exports reported but unlisted, and entries listed but no longer reported
 */
export function reconcile(
  reported: readonly ReportedExport[],
  allowlist: readonly UnusedExportFile[],
): { unlisted: ReportedExport[]; stale: ExcusedExport[] } {
  const excused = flattenAllowlist(allowlist);
  const listed = new Set(excused.map(keyOf));
  const seen = new Set(reported.map(keyOf));
  return {
    unlisted: reported.filter((entry) => !listed.has(keyOf(entry))),
    stale: excused.filter((entry) => !seen.has(keyOf(entry))),
  };
}

/** Run knip for its export report only; the dependency questions are `bun run dependency-check`'s. */
function runKnip(): KnipJsonReport {
  const result = safeExecResult(
    'bunx',
    ['knip', '--config', KNIP_CONFIG, '--include', EXPORT_KINDS.join(','), '--reporter', 'json', '--no-progress'],
    { cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  // knip exits 1 whenever it reports anything, which is the normal case here;
  // an EMPTY stdout is the failure — knip did not run, or did not finish.
  const stdout = result.stdout.toString();
  if (stdout.trim() === '') {
    throw new Error(`knip produced no report (exit ${String(result.status)}): ${result.stderr.toString()}`);
  }
  return JSON.parse(stdout) as KnipJsonReport;
}

/**
 * Every test-tier source under `packages/<pkg>/test/`, read once, for the
 * `test-only` tag. Untracked files count (a test written this session reaches
 * a name as much as a committed one), and a tracked file that is gone from
 * disk is skipped rather than fatal — the crawl answers from git's index,
 * which names a deleted-but-not-yet-committed file until the commit.
 */
function loadTestCorpus(): string[] {
  const sources: string[] = [];
  const files = crawlDirectorySync({
    baseDir: PROJECT_ROOT,
    include: ['packages/*/test/**/*.ts'],
    includeUntracked: true,
    unreadable: { refuse: { root: PROJECT_ROOT, remedy: 'Fix the directory permissions and re-run.' } },
  });
  for (const file of files) {
    try {
      sources.push(readFileSync(file, 'utf-8'));
    } catch (error) {
      if (!isPathAbsentError(error)) throw error;
    }
  }
  return sources;
}

/** Is `name` present in `source` as a whole identifier (not as part of a longer one)? */
function mentionsIdentifier(source: string, name: string): boolean {
  const isIdentifierChar = (ch: string | undefined): boolean => ch !== undefined && /[\w$]/u.test(ch);
  for (let at = source.indexOf(name); at !== -1; at = source.indexOf(name, at + 1)) {
    if (!isIdentifierChar(source[at - 1]) && !isIdentifierChar(source[at + name.length])) return true;
  }
  return false;
}

/**
 * The module specifiers a relative import of `file` can end with: the path
 * from `src/` without its extension, and — for an `index.ts` — its directory.
 * `'../../src/a/b.js'`, `'../src/a/b'` and `'../../src/a'` all end with one.
 */
function specifierTailsOf(file: string): string[] {
  const fromSrc = file.slice(file.indexOf('/src/') + 1).replace(/\.ts$/u, '');
  const tails = [`/${fromSrc}.js'`, `/${fromSrc}'`];
  if (fromSrc.endsWith('/index')) tails.push(`/${fromSrc.slice(0, -'/index'.length)}'`);
  return tails;
}

/**
 * `test-only` when some test source imports `entry.file` and uses the name as
 * a whole identifier; `dead` otherwise. A hint, not a proof: the import is
 * matched by its specifier's tail and the name by text, so a test that
 * imports the module and mentions the name in prose counts.
 */
export function classifyReason(entry: ReportedExport, testCorpus: readonly string[]): UnusedExportReason {
  const tails = specifierTailsOf(entry.file);
  const importsModule = (source: string): boolean => tails.some((tail) => source.includes(tail));
  return testCorpus.some((source) => importsModule(source) && mentionsIdentifier(source, entry.name))
    ? 'test-only'
    : 'dead';
}

/** The header every rendered allowlist carries — the data file documents itself. */
const ALLOWLIST_HEADER = [
  '# The unused-export ratchet: every `export` knip reports as referenced by',
  '# nothing in the project graph, excused by name. Read by',
  '# `packages/dev-tools/src/unused-exports.ts` (`bun run unused-exports`); the',
  '# shape is `<file> <name> <reason>`, one export per line, sorted.',
  '#',
  '# The list may only SHRINK. `reason` is `test-only` (a test reaches the',
  '# name — the export exists for that test) or `dead` (nothing does). Both are',
  '# read off `packages/<pkg>/test/` — an import of the module plus a whole-',
  '# identifier mention of the name — a hint and not a proof.',
  '#',
  '# Generated by `bun run unused-exports --seed`; entries leave by hand or by',
  '# `--prune`. Never add one by hand: an unused export is fixed at the export.',
  '# Data, not code: it lives in a text file so no analyser reads hundreds of rows of',
  '# one shape as duplicated code.',
  '',
];

/** The data file's text for `entries`: the header, then one sorted `<file> <name> <reason>` line each. */
export function renderAllowlist(entries: readonly ExcusedExport[]): string {
  const rows = [...entries]
    .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
    .map((e) => `${e.file} ${e.name} ${e.reason}`);
  return `${[...ALLOWLIST_HEADER, ...rows].join('\n')}\n`;
}

function reportGate(unlisted: readonly ReportedExport[], stale: readonly ExcusedExport[], excusedCount: number): boolean {
  for (const entry of unlisted) {
    log(`NEW unused export: ${entry.file} › ${entry.name} — import it, delete it, or move it behind internal.ts`, 'red');
  }
  for (const entry of stale) {
    log(`STALE allowlist entry: ${entry.file} › ${entry.name} is no longer unused — delete the entry (or run --prune)`, 'yellow');
  }
  const ok = unlisted.length === 0 && stale.length === 0;
  log(
    ok
      ? `unused-exports: ${String(excusedCount)} excused, 0 new, 0 stale`
      : `unused-exports: ${String(unlisted.length)} new, ${String(stale.length)} stale`,
    ok ? 'green' : 'red',
  );
  return ok;
}

function main(): void {
  const mode = process.argv[2];
  const reported = reportedExportsOf(runKnip());
  const allowlist = loadUnusedExportsAllowlist();
  const excused = flattenAllowlist(allowlist);
  const { unlisted, stale } = reconcile(reported, allowlist);

  if (mode === '--seed') {
    const corpus = loadTestCorpus();
    const entries = reported.map((entry) => ({ ...entry, reason: classifyReason(entry, corpus) }));
    writeFileSync(UNUSED_EXPORTS_ALLOWLIST_PATH, renderAllowlist(entries));
    const delta = entries.length - excused.length;
    log(`seeded ${String(entries.length)} entries (${delta >= 0 ? '+' : ''}${String(delta)} vs the committed list)`, delta > 0 ? 'yellow' : 'green');
    return;
  }
  if (mode === '--prune') {
    const staleKeys = new Set(stale.map(keyOf));
    writeFileSync(UNUSED_EXPORTS_ALLOWLIST_PATH, renderAllowlist(excused.filter((e) => !staleKeys.has(keyOf(e)))));
    log(`pruned ${String(stale.length)} stale entries`, 'green');
  }
  if (!reportGate(unlisted, mode === '--prune' ? [] : stale, excused.length)) process.exitCode = ExitCode.FINDINGS;
}

if (isEntrypoint(import.meta.url)) {
  main();
}
