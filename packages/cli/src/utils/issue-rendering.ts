/**
 * Rendering for SETS of `ValidationIssue`s — the severity label, the set's
 * heading, and the per-issue block.
 *
 * `issue-anchor.ts` answers "where is this issue?"; this module answers "what
 * severity is it, and what is in this set?". Both exist because the answer has
 * to be spelled identically by every command: two renderers that each invent
 * their own severity prefix is exactly how `info` findings came to be printed
 * as `[WARNING]` in `vat skills build` AND `vat claude plugin build`, and how a
 * mixed set came to be labelled "post-build error(s)" wholesale.
 *
 * The failure mode these helpers exist to prevent is directional: every
 * hand-rolled severity collapse in this codebase mapped the case it could not
 * represent onto the REASSURING one (info ⇒ "warning", warnings ⇒ "all
 * passed"). That is why none of it was ever reported — it produces silence, not
 * a false alarm.
 */

import {
  countBySeverity,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import type { PackageSkillResult } from '@vibe-agent-toolkit/agent-skills';

import { formatIssueAnchor } from './issue-anchor.js';

/**
 * Uppercase label for a resolved severity.
 *
 * A total map, not an `=== 'error' ? … : …` ternary: the ternary is what
 * rendered every non-error severity — `info` included — as `WARNING`.
 */
const SEVERITY_LABELS: Record<ValidationIssue['severity'], string> = {
  error: 'ERROR',
  warning: 'WARNING',
  info: 'INFO',
  ignore: 'IGNORED',
};

/** Render an issue's own severity as itself. */
export function severityLabel(severity: ValidationIssue['severity']): string {
  return SEVERITY_LABELS[severity];
}

/**
 * The severity distribution in prose: `1 error, 2 warnings, 3 info`.
 *
 * Zero buckets are omitted so the phrase names only what is present. An
 * all-zero set returns `no findings` rather than an empty string, because an
 * empty string silently disappears into whatever sentence embeds it.
 */
export function formatSeverityBreakdown(counts: SeverityCounts): string {
  const parts: string[] = [];
  if (counts.errors > 0) {
    parts.push(`${counts.errors} error${counts.errors === 1 ? '' : 's'}`);
  }
  if (counts.warnings > 0) {
    parts.push(`${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`);
  }
  if (counts.info > 0) {
    parts.push(`${counts.info} info`);
  }
  return parts.length === 0 ? 'no findings' : parts.join(', ');
}

/**
 * Heading for a set of issues: `3 post-build issues (1 error, 2 info)`.
 *
 * The breakdown is not decoration — it is the only part of the heading that
 * cannot be wrong about a mixed set. `noun` qualifies the set ("post-build"),
 * and is omitted entirely when empty.
 */
export function formatIssueSetHeading(
  issues: readonly ValidationIssue[],
  noun?: string,
): string {
  const qualifier = noun === undefined || noun === '' ? '' : `${noun} `;
  const total = issues.length;
  const breakdown = formatSeverityBreakdown(countBySeverity(issues));
  return `${total} ${qualifier}issue${total === 1 ? '' : 's'} (${breakdown})`;
}

/**
 * Render one issue as its own lines, each prefixed with `indent`.
 *
 * Returns an array rather than writing, so a caller can pick its own stream and
 * a unit test can assert over every line without capturing output.
 */
export function formatIssueLines(issue: ValidationIssue, indent = ''): string[] {
  const lines = [
    `${indent}[${severityLabel(issue.severity)}] [${String(issue.code)}] ${String(issue.message)}`,
  ];
  const anchor = formatIssueAnchor(issue);
  if (anchor !== undefined) {
    lines.push(`${indent}  Location: ${anchor}`);
  }
  if (issue.fix) {
    lines.push(`${indent}  Fix: ${String(issue.fix)}`);
  }
  return lines;
}

/**
 * Render the run-level findings section — findings that belong to the whole
 * invocation rather than to any one skill (ALLOW_UNUSED is the only producer).
 *
 * Shared by `vat skills validate` and `vat skills build` so the two commands
 * name the same concept the same way. Attributing these to a skill is the
 * misreading the heading exists to prevent: `validation.allow` is declared once
 * for the package, so an entry that matched nothing is a fact about the run.
 *
 * Returns `[]` for an empty set; callers own their surrounding blank lines.
 */
export function formatRunIssueLines(runIssues: readonly ValidationIssue[]): string[] {
  if (runIssues.length === 0) return [];
  const lines = [
    'Run-level (project config, not any one skill):',
    `  ${formatIssueSetHeading(runIssues)}:`,
  ];
  for (const issue of runIssues) {
    lines.push(...formatIssueLines(issue, '    '));
  }
  return lines;
}

/** Identity of an issue for de-duplication across the two post-build channels. */
function issueIdentity(issue: ValidationIssue): string {
  return [
    issue.code,
    issue.severity,
    issue.location ?? '',
    issue.line === undefined ? '' : String(issue.line),
    issue.field ?? '',
    issue.message,
  ].join('\0');
}

/**
 * Every post-build finding a `PackageSkillResult` carries, from BOTH channels.
 *
 * `hasErrors` is the OR of two independent sets — the packager's own framework
 * run (`postBuildIssues`: link exclusions, unreferenced files, broken packaged
 * links) and the full validation of the built tree (`postBuildValidation`). A
 * renderer that walks only `postBuildIssues` therefore prints NOTHING for a
 * build that failed purely on `postBuildValidation`: the user is told the build
 * failed and shown no reason. Reading both is the whole point of this helper.
 *
 * `postBuildValidation.allErrors` is the full emitted set including `info`
 * (see its doc comment — the name lies), so info findings survive here.
 */
export function collectPostBuildIssues(result: PackageSkillResult): ValidationIssue[] {
  const seen = new Set<string>();
  const merged: ValidationIssue[] = [];
  for (const issue of [
    ...(result.postBuildIssues ?? []),
    ...(result.postBuildValidation?.allErrors ?? []),
  ]) {
    const identity = issueIdentity(issue);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(issue);
  }
  return merged;
}

/**
 * A compact count-only projection of one asset's findings, for summary output.
 *
 * Deliberately does NOT carry the asset's name: the three commands that publish
 * these rows (`vat skills validate`, `vat claude marketplace validate`,
 * `vat resources validate`) each key their row by a different identity — a skill
 * name, a plugin name, a file path. A projection that named the asset would have
 * to pick one, and the two lanes it did not fit would fork their own copy, which
 * is how the severity collapse came to be spelled five different ways.
 *
 * A zero bucket is an ABSENT key, never `0`. Serialized as YAML, three zero
 * columns per asset is what makes a summary unreadable at corpus scale, and
 * `errors: 0` beside a red exit code reads as a contradiction rather than as the
 * "this asset is not the one" it means. `exactOptionalPropertyTypes` is on, so
 * these are built by spread — assigning `undefined` would emit the key.
 */
export interface FindingCountSummary {
  errors?: number;
  warnings?: number;
  info?: number;
  /** Per-code tally, ordered descending by count then by code name. */
  codes: Record<string, number>;
}

/**
 * Project a set of issues onto its counts: severity buckets plus a per-code tally.
 *
 * Severity counting delegates to `countBySeverity` — there must be exactly one
 * severity collapse in this codebase (see this module's header). That delegation
 * carries its rule with it: `ignore` findings land in NO severity bucket, because
 * the adopter's `validation.allow` config silenced them.
 *
 * They do still appear in `codes`, because they were emitted — a code the adopter
 * allow-listed would otherwise be invisible in every summary, which is the one
 * place a reviewer would look to notice an allow-list that has quietly grown.
 *
 * `codes` is ordered descending by count, ties broken by code name ascending.
 * Insertion order is the YAML serialization order, so the ordering is the feature:
 * the first row names the dominant finding without the reader tallying anything.
 */
export function summarizeFindings(issues: readonly ValidationIssue[]): FindingCountSummary {
  const counts = countBySeverity(issues);

  const tally = new Map<string, number>();
  for (const issue of issues) {
    const code = String(issue.code);
    tally.set(code, (tally.get(code) ?? 0) + 1);
  }

  // `Object.fromEntries` over a sorted array, rather than keyed assignment into a
  // record: it preserves the sort as insertion order without a dynamic index write.
  const codes = Object.fromEntries(
    [...tally.entries()].sort(([codeA, countA], [codeB, countB]) =>
      countB - countA || codeA.localeCompare(codeB),
    ),
  );

  return {
    ...(counts.errors > 0 ? { errors: counts.errors } : {}),
    ...(counts.warnings > 0 ? { warnings: counts.warnings } : {}),
    ...(counts.info > 0 ? { info: counts.info } : {}),
    codes,
  };
}

/**
 * The findings a human-facing report renders IN FULL at a given verbosity.
 *
 * One policy, spelled once, because the three verbs that report findings —
 * `vat skills validate`, `vat skills build`, `vat audit` — each grew their own
 * answer and landed on three different ones: validate collapsed every severity
 * into a per-skill count line, while build and audit printed every occurrence.
 * On a 90-skill adopter that read as 804 lines against 6,552 and 26,480, for
 * the same corpus.
 *
 * The rule is asymmetric on purpose, and the asymmetry is the whole point:
 *
 * - **`error` is always rendered in full**, at every verbosity. An error is what
 *   failed the run, there are few of them, and every one is actionable. Collapsing
 *   an error into a count means the reader must re-run with a flag to learn what
 *   broke — which is strictly worse than the verbosity it was meant to fix. This
 *   is the direction the module header warns about: a collapse that hides the
 *   thing you needed produces silence, not a false alarm.
 * - **`warning` and `info` collapse into the caller's summary line** unless
 *   `verbose`. These are the high-cardinality findings (one adopter skill carries
 *   348 `LINK_DROPPED_BY_DEPTH` warnings alone), and a count plus a per-code tally
 *   answers "what is going on here?" without the reader scrolling past 348 near-
 *   identical blocks.
 * - **`ignore` never renders**, at any verbosity: the adopter's `validation.allow`
 *   config silenced it deliberately. It stays visible in `summarizeFindings`'
 *   `codes` tally, which is where a quietly-growing allow-list is noticed.
 *
 * This decides only WHICH findings are rendered, never HOW. Each lane keeps its
 * own heading and summary line — those legitimately differ — so this can be shared
 * without forcing one layout onto three commands.
 *
 * The machine-readable document is NOT filtered by this. `vat audit`'s YAML and
 * `vat skills build`'s `issueCounts` carry every finding at every verbosity;
 * anything else would silently break consumers that parse them.
 */
export function issuesToRenderAtVerbosity(
  issues: readonly ValidationIssue[],
  verbose: boolean,
): readonly ValidationIssue[] {
  return issues.filter(
    (issue) => issue.severity !== 'ignore' && (verbose || issue.severity === 'error'),
  );
}

/**
 * How many findings `--verbose` would render that this verbosity does not.
 *
 * Derived from {@link issuesToRenderAtVerbosity} rather than re-stating its rule,
 * so the number a report quotes can never contradict the policy that produced it.
 * Allow-suppressed findings are in neither set, so they are correctly not counted
 * as "hidden by verbosity" — they were hidden by the adopter's own config.
 */
export function countCollapsedFindings(
  issues: readonly ValidationIssue[],
  verbose: boolean,
): number {
  return (
    issuesToRenderAtVerbosity(issues, true).length
    - issuesToRenderAtVerbosity(issues, verbose).length
  );
}

/**
 * The one sentence that tells a reader findings exist that they cannot see.
 *
 * A collapsed block is otherwise a heading with nothing beneath it — the
 * reassuring silence this module's header warns about. `vat audit` has printed
 * this line all along and `vat skills build` did not; one helper rather than a
 * second phrasing of the same idea, because two wordings for one concept is how
 * the severity collapse came to be spelled five different ways.
 *
 * `report` names the verb whose YAML the reader should open ("audit", "build").
 * That clause is only honest for a command that publishes full `issues:` arrays;
 * do not pass a report name for a verb that publishes counts alone.
 *
 * Returns `undefined` when nothing was collapsed, so callers print nothing rather
 * than a "0 findings not shown" line.
 */
export function formatCollapsedFindingsHint(
  collapsed: number,
  report: string,
): string | undefined {
  if (collapsed <= 0) return undefined;
  return (
    `\n${collapsed} warning/info finding(s) not shown — re-run with --verbose, `
    + `or read this ${report}'s YAML report on stdout, which lists every finding.`
  );
}

/**
 * How many files LINK TRAVERSAL put in a bundle, in prose: `1 file`, `11 files`.
 *
 * Deliberately not called the bundle's file count, which is what it reads like and
 * is not: `files.dependencies` carries only what the link-graph walk discovered, so
 * every file `files:` copied in — each glob match, plus any explicit entry the walk
 * had not already bundled — is absent from the total. A bundle holding SKILL.md, one
 * linked doc and one declared artifact prints `2 files`. That undercount is issue
 * #177 and is deliberately NOT patched here; this wording is only the part that can
 * be made true today, so nobody reads the number as an inventory of the output.
 *
 * The `+ 1` is the bundle's root `SKILL.md`, which `files.dependencies` does not
 * list — spelled once here rather than at each progress line, so the two build
 * lanes cannot come to disagree about whether the root document counts.
 */
export function formatPackagedFileCount(result: PackageSkillResult): string {
  const total = result.files.dependencies.length + 1;
  return `${total} file${total === 1 ? '' : 's'}`;
}

/** Sum severity counts across lanes (per-skill → per-plugin → per-run). */
export function sumSeverityCounts(counts: readonly SeverityCounts[]): SeverityCounts {
  return counts.reduce<SeverityCounts>(
    (acc, c) => ({
      errors: acc.errors + c.errors,
      warnings: acc.warnings + c.warnings,
      info: acc.info + c.info,
    }),
    { errors: 0, warnings: 0, info: 0 },
  );
}
