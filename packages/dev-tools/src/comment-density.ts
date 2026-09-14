#!/usr/bin/env tsx
/**
 * Comment-density ratchet: the share of comment lines in each package's `src/`,
 * held against a stored ceiling that can only move down.
 *
 * Half of every source line in this repo is prose, and the share doubled in
 * one quarter. Nothing pushes back on a paragraph of rationale landing above
 * the code it explains, so the number only grows. This is the push-back: per
 * package, `comment lines / non-blank lines` is measured and compared with
 * `COMMENT_DENSITY_CEILINGS` BOTH ways —
 *
 * - a package that rises above its ceiling fails, so new prose has to be paid
 *   for by removing old prose (or by moving it to the doc that owns it, per
 *   `docs/contributing/content-routing.md`);
 * - a package that falls a whole point below its ceiling ALSO fails, until the
 *   ceiling is lowered to match. A ceiling that stays where it was after the
 *   prose left would let the next person spend the slack; the table records
 *   the best the package has done, not the worst it may do.
 *
 * There is deliberately no cap on the length of one JSDoc block: the ratchet is
 * the mechanism, and a cap would flag tens of thousands of existing lines with
 * no way to reduce them but wholesale rewriting.
 *
 * Line classification is the audit's: a non-blank line is a comment line when
 * its first non-space characters are `//`, `*` or `/*`. A trailing comment on a
 * code line is code; a `*` that opens a line inside a block is prose. That is
 * a heuristic (a string literal spanning lines that begin with `*` would be
 * miscounted), and it is the same heuristic on every run, which is all a
 * ratchet needs.
 *
 * Usage:
 *   bun run comment-density                  # table + verdict; exit 1 on a finding
 *   bun run comment-density --print-ceilings # emit a fresh ceilings module for a re-seed
 *
 * The gate runs {@link checkCommentDensity} through `validate-structure`.
 */

import { readFileSync } from 'node:fs';

import { ExitCode, type ExitCodeValue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';

import { COMMENT_DENSITY_CEILINGS } from './comment-density-ceilings.js';
import { isEntrypoint, log, PROJECT_ROOT } from './common.js';
import { ERROR_TYPES, type ValidationError } from './structure-finding.js';

/** What one line of source counts as. */
export type LineKind = 'blank' | 'comment' | 'code';

/** Line counts for one text or one package. */
export interface LineCounts {
  readonly commentLines: number;
  readonly nonBlankLines: number;
}

/** A package's counts plus its ratio, as a percentage to one decimal. */
export interface CommentDensity extends LineCounts {
  readonly percent: number;
}

/** One way a package disagrees with its ceiling. */
export type DensityFindingKind =
  /** The measured share is above the ceiling. */
  | 'rose'
  /** The measured share is at least {@link FALL_TOLERANCE_POINTS} below the ceiling. */
  | 'fell'
  /** The package has sources and no ceiling. */
  | 'missing-entry'
  /** The ceiling names a package with no sources. */
  | 'stale-entry';

/** One disagreement between the tree and the ceilings table. */
export type DensityFinding =
  | { readonly package: string; readonly kind: 'rose' | 'fell'; readonly percent: number; readonly ceiling: number }
  | { readonly package: string; readonly kind: 'missing-entry'; readonly percent: number; readonly ceiling: null }
  | { readonly package: string; readonly kind: 'stale-entry'; readonly percent: null; readonly ceiling: number };

/**
 * How far a package may sit below its ceiling before the ceiling has to come
 * down. One point: small enough that a real reduction is banked, large enough
 * that an ordinary edit does not force a table change.
 */
export const FALL_TOLERANCE_POINTS = 1;

/** Repo-relative path of the ceilings module, for messages. */
export const CEILINGS_MODULE = 'packages/dev-tools/src/comment-density-ceilings.ts';

/** `packages/<dir>/src/**` TypeScript sources that are not tests or declarations. */
const SOURCE_FILE = /^packages\/([^/]+)\/src\/.+\.(?:ts|cts|mts)$/;
const EXCLUDED_SOURCE = /\.(?:d|test|integration\.test|system\.test)\.(?:ts|cts|mts)$/;

/** Classify one line by its first non-space characters. */
export function classifyLine(line: string): LineKind {
  const trimmed = line.trim();
  if (trimmed.length === 0) return 'blank';
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return 'comment';
  return 'code';
}

/** Count comment and non-blank lines in one source text. */
export function measureSource(text: string): LineCounts {
  let commentLines = 0;
  let nonBlankLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const kind = classifyLine(line);
    if (kind === 'blank') continue;
    nonBlankLines += 1;
    if (kind === 'comment') commentLines += 1;
  }
  return { commentLines, nonBlankLines };
}

/** Comment share as a percentage to one decimal; `0` for an empty package. */
export function densityPercent(counts: LineCounts): number {
  if (counts.nonBlankLines === 0) return 0;
  return Math.round((counts.commentLines / counts.nonBlankLines) * 1000) / 10;
}

/** The table key for a package: quoted, since most package directory names carry a hyphen. */
function ceilingsKey(pkg: string): string {
  return `'${pkg}'`;
}

/** The comment share rounded UP to a tenth of a point — a ceiling, never a rounding to nearest. */
function ceilingFor(counts: LineCounts): number {
  if (counts.nonBlankLines === 0) return 0;
  return Math.ceil((counts.commentLines / counts.nonBlankLines) * 1000) / 10;
}

/** NUL-separated `git ls-files` output as a list of repo-relative paths. */
function gitListing(repoRoot: string, args: readonly string[]): string[] {
  const listing = String(runGitOrThrow(['ls-files', '-z', ...args, '--', 'packages'], { cwd: repoRoot, trim: false }));
  return listing.split('\0').filter((rel) => rel.length > 0);
}

/**
 * The source files in the WORKING TREE, grouped by package directory name:
 * tracked plus untracked-not-ignored, minus anything deleted but not yet
 * staged. The measurement is of the tree a commit would carry, so a file
 * added or removed since the last commit counts as of now.
 */
function listSourceFiles(repoRoot: string): ReadonlyMap<string, readonly string[]> {
  const deleted = new Set(gitListing(repoRoot, ['--deleted']));
  const byPackage = new Map<string, string[]>();
  for (const rel of gitListing(repoRoot, ['--cached', '--others', '--exclude-standard'])) {
    const match = SOURCE_FILE.exec(rel);
    if (match === null || EXCLUDED_SOURCE.test(rel) || deleted.has(rel)) continue;
    const dir = match[1] as string;
    const files = byPackage.get(dir) ?? [];
    files.push(rel);
    byPackage.set(dir, files);
  }
  return byPackage;
}

/** Measure every package's `src/`, keyed by package directory name, sorted. */
export function measurePackageDensities(repoRoot: string): ReadonlyMap<string, CommentDensity> {
  const result = new Map<string, CommentDensity>();
  const byPackage = listSourceFiles(repoRoot);
  for (const dir of [...byPackage.keys()].sort((a, b) => a.localeCompare(b))) {
    let commentLines = 0;
    let nonBlankLines = 0;
    for (const rel of byPackage.get(dir) ?? []) {
      const counts = measureSource(readFileSync(safePath.join(repoRoot, rel), 'utf8'));
      commentLines += counts.commentLines;
      nonBlankLines += counts.nonBlankLines;
    }
    result.set(dir, { commentLines, nonBlankLines, percent: densityPercent({ commentLines, nonBlankLines }) });
  }
  return result;
}

/**
 * Compare measured densities with the ceilings table, both ways.
 *
 * Pure, so a test can hand it any table. Findings are sorted by package name.
 */
export function compareToCeilings(
  densities: ReadonlyMap<string, CommentDensity>,
  ceilings: Readonly<Record<string, number>>,
): DensityFinding[] {
  const findings: DensityFinding[] = [];
  for (const [pkg, ceiling] of Object.entries(ceilings)) {
    if (!densities.has(pkg)) findings.push({ package: pkg, kind: 'stale-entry', percent: null, ceiling });
  }
  for (const [pkg, { percent }] of densities) {
    const ceiling = ceilings[pkg];
    if (ceiling === undefined) {
      findings.push({ package: pkg, kind: 'missing-entry', percent, ceiling: null });
    } else if (percent > ceiling) {
      findings.push({ package: pkg, kind: 'rose', percent, ceiling });
    } else if (ceiling - percent >= FALL_TOLERANCE_POINTS - 1e-9) {
      findings.push({ package: pkg, kind: 'fell', percent, ceiling });
    }
  }
  return findings.sort((a, b) => a.package.localeCompare(b.package));
}

/** The message a finding carries, naming the one edit that clears it. */
export function describeFinding(finding: DensityFinding): string {
  const pkg = finding.package;
  switch (finding.kind) {
    case 'rose':
      return `${pkg}: comment density ${finding.percent}% is above its ${finding.ceiling}% ceiling. Remove prose, ` +
        'or move it to the doc that owns it (docs/contributing/content-routing.md says which); the ceiling is not raised.';
    case 'fell':
      return `${pkg}: comment density ${finding.percent}% is ${FALL_TOLERANCE_POINTS}+ points under its ` +
        `${finding.ceiling}% ceiling. Bank it: lower the entry in ${CEILINGS_MODULE} to ${finding.percent}.`;
    case 'missing-entry':
      return `${pkg}: has src/ but no entry in ${CEILINGS_MODULE}. Add \`${ceilingsKey(pkg)}: ${finding.percent},\` ` +
        '(its measured density).';
    case 'stale-entry':
      return `${pkg}: has an entry in ${CEILINGS_MODULE} but no src/ sources. Delete the entry.`;
  }
}

/** Gate rule: every package's comment density agrees with its ceiling. */
export function checkCommentDensity(repoRoot: string): ValidationError[] {
  return compareToCeilings(measurePackageDensities(repoRoot), COMMENT_DENSITY_CEILINGS).map((finding) => ({
    type: ERROR_TYPES.STRUCTURAL_VIOLATION,
    path: `packages/${finding.package}/src`,
    message: describeFinding(finding),
    severity: 'error' as const,
  }));
}

/** The source of a fresh `comment-density-ceilings.ts`, every measurement rounded UP to a tenth. */
export function renderCeilingsModule(densities: ReadonlyMap<string, CommentDensity>): string {
  const rows = [...densities.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, counts]) => `  ${ceilingsKey(pkg)}: ${ceilingFor(counts)},`);
  return [
    '/**',
    ' * Comment-density ceilings, one per package with a `src/`, in percent of',
    ' * non-blank lines. Read by `comment-density.ts` and asserted both ways by',
    ' * the structure gate: a package may not rise above its entry, and an entry',
    ' * more than a point above its package must be lowered. The table only moves',
    ' * down. Re-seed with `bun run comment-density --print-ceilings` after a',
    ' * deliberate prose reduction; never to admit growth.',
    ' */',
    'export const COMMENT_DENSITY_CEILINGS: Readonly<Record<string, number>> = {',
    ...rows,
    '};',
    '',
  ].join('\n');
}

function main(argv: readonly string[]): ExitCodeValue {
  const densities = measurePackageDensities(PROJECT_ROOT);
  if (argv.includes('--print-ceilings')) {
    process.stdout.write(renderCeilingsModule(densities));
    return ExitCode.OK;
  }
  for (const [pkg, { commentLines, nonBlankLines, percent }] of densities) {
    const ceiling = COMMENT_DENSITY_CEILINGS[pkg];
    log(`  ${pkg.padEnd(28)} ${String(percent).padStart(5)}%  (${commentLines}/${nonBlankLines}; ceiling ${ceiling ?? '—'})`);
  }
  const findings = compareToCeilings(densities, COMMENT_DENSITY_CEILINGS);
  if (findings.length === 0) {
    log('✓ Every package is within its comment-density ceiling', 'green');
    return ExitCode.OK;
  }
  for (const finding of findings) log(`✗ ${describeFinding(finding)}`, 'red');
  return ExitCode.FINDINGS;
}

if (isEntrypoint(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
