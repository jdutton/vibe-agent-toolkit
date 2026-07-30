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
} from '@vibe-agent-toolkit/agent-schema';
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
