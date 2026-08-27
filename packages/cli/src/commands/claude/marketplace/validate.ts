/* eslint-disable security/detect-non-literal-fs-filename -- Paths are user-provided CLI arguments */
/**
 * `vat claude marketplace validate [path]` — strict marketplace validation.
 *
 * Validates a marketplace directory with strict requirements:
 * - .claude-plugin/marketplace.json must exist and be valid
 * - Each plugin must have valid plugin.json with version (error, not warning)
 * - LICENSE file must exist (error)
 * - README.md should exist (warning)
 * - CHANGELOG.md should exist (warning)
 */

import { existsSync, readdirSync } from 'node:fs';


import {
  validateMarketplace,
  validateSkill,
  type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { validatePlugin } from '@vibe-agent-toolkit/claude-marketplace';
import {
  calculateValidationStatus,
  countBySeverity,
  type SeverityCounts,
  type ValidationConfig,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { findProjectRoot, issueLocation, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { formatDuration, reportCommandError } from '../../../utils/command-error.js';
import { loadConfig } from '../../../utils/config-loader.js';
import { summarizeFindings, type FindingCountSummary } from '../../../utils/issue-rendering.js';
import { resolveIssueSeverity } from '../../../utils/issue-severity.js';
import { createLogger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';
import { relativizePathEntries } from '../../../utils/relativize-paths.js';
import { finishCommand, type PhaseOutcome } from '../../phase-utils.js';

interface MarketplaceValidateOptions {
  debug?: boolean;
  /** Show all inspected assets, including those without issues (per-issue detail). */
  verbose?: boolean;
}

/**
 * Check for required/recommended files in the marketplace root.
 */
function checkMarketplaceFiles(marketplacePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const fileChecks: Array<{ file: string; code: string; severity: 'error' | 'warning'; verb: string }> = [
    { file: 'LICENSE', code: 'MARKETPLACE_MISSING_LICENSE', severity: 'error', verb: 'required for distribution' },
    { file: 'README.md', code: 'MARKETPLACE_MISSING_README', severity: 'warning', verb: 'recommended for documentation' },
    { file: 'CHANGELOG.md', code: 'MARKETPLACE_MISSING_CHANGELOG', severity: 'warning', verb: 'recommended for tracking changes' },
  ];

  for (const check of fileChecks) {
    if (!existsSync(safePath.join(marketplacePath, check.file))) {
      issues.push({
        severity: check.severity,
        code: check.code as ValidationIssue['code'],
        message: `Marketplace is missing a ${check.file} — ${check.verb}`,
        location: issueLocation(safePath.join(marketplacePath, check.file), marketplacePath),
        fix: `Add a ${check.file} to the marketplace root directory`,
      });
    }
  }

  return issues;
}

/**
 * Validate all SKILL.md files within a plugin's skills/ directory.
 */
async function validatePluginSkills(pluginDir: string, marketplacePath: string): Promise<ValidationIssue[]> {
  const skillsDir = safePath.join(pluginDir, 'skills');
  if (!existsSync(skillsDir)) return [];

  const issues: ValidationIssue[] = [];
  const skillEntries = readdirSync(skillsDir, { withFileTypes: true });

  for (const skillEntry of skillEntries) {
    if (!skillEntry.isDirectory()) continue;

    const skillDir = safePath.join(skillsDir, skillEntry.name);
    const skillMdPath = safePath.join(skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    const skillResult = await validateSkill({ skillPath: skillMdPath, rootDir: skillDir, locationRoot: marketplacePath });
    issues.push(...skillResult.issues);
  }

  return issues;
}

/**
 * Validate all plugins under the plugins/ directory.
 *
 * `validation` is the governing project's severity map (see
 * {@link resolveProjectValidationConfig}). It is applied to each plugin result
 * HERE rather than to the flat list at the end because the emitted document
 * publishes both: `issues` and `plugins[].issues` are two views of the same
 * findings, plus `plugins[].status`. Resolving once, at the producer, is what
 * keeps them from disagreeing — a suppressed warning still listed under
 * `plugins[]`, or a plugin `status: warning` above an issue list that no longer
 * contains a warning.
 */
async function validatePlugins(
  marketplacePath: string,
  validation: ValidationConfig | undefined,
): Promise<{ pluginResults: ValidationResult[]; issues: ValidationIssue[] }> {
  const pluginsDir = safePath.join(marketplacePath, 'plugins');
  if (!existsSync(pluginsDir)) return { pluginResults: [], issues: [] };

  const pluginResults: ValidationResult[] = [];
  const issues: ValidationIssue[] = [];
  const entries = readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = safePath.join(pluginsDir, entry.name);
    // `locationRoot` is not optional here even though the parameter is: omitted,
    // `validatePlugin` anchors at the plugin's own discovered project root, so
    // its findings land in a different coordinate system than the marketplace
    // and skill findings beside them — and every plugin's manifest collapses to
    // the same `.claude-plugin/plugin.json`.
    const rawResult = await validatePlugin(pluginDir, { strict: true, locationRoot: marketplacePath });
    const pluginIssues = resolveIssueSeverity(rawResult.issues, validation);
    const pluginResult: ValidationResult = {
      ...rawResult,
      issues: pluginIssues,
      status: calculateValidationStatus(pluginIssues),
      issueCounts: countBySeverity(pluginIssues),
    };
    pluginResults.push(pluginResult);
    issues.push(...pluginIssues);

    const skillIssues = await validatePluginSkills(pluginDir, marketplacePath);
    issues.push(...resolveIssueSeverity(skillIssues, validation));
  }

  return { pluginResults, issues };
}

/**
 * The `validation` config governing findings about `marketplacePath`.
 *
 * A built marketplace tree lives under the project that produced it
 * (`dist/.claude/plugins/marketplaces/<name>/`), so the governing config is
 * found by walking UP through {@link findProjectRoot} — the same discovery
 * ladder every other lane uses, so they cannot disagree about which project
 * governs a path.
 *
 * `skills.defaults.validation` is the ONE available scope, and deliberately so.
 * A marketplace finding is not attributable to a skill, and neither
 * `ClaudeMarketplaceSchema` nor `ClaudeMarketplacePluginEntrySchema` has a
 * `validation` key — both are `.strict()`, so adding one to a config is a config
 * error rather than an override. Per-plugin granularity is therefore
 * unreachable by design until those schemas gain a key, which is a config-surface
 * decision, not a fix.
 *
 * Why this phase needed it at all: `PACKAGED_AGENT_INSTRUCTION_FILE` ships at
 * `warning` precisely because a legitimate exception exists — a plugin
 * intentionally shipping a scaffold `CLAUDE.md` — and the code's own `fix` text
 * tells the reader to record it as `severity.PACKAGED_AGENT_INSTRUCTION_FILE:
 * ignore`. This command never read any config, so that instruction was a total
 * no-op here: measured, the warnings survived the override at `skills.defaults`,
 * at every per-skill key, and at the plugin's own name, and `vat verify` could
 * not be made to reach `status: success` on a project that intends to ship one.
 *
 * A config that exists but does not parse yields no overrides rather than
 * aborting: `vat verify` runs its `resources` and `skills` phases against the
 * same config and both report the real parse error, so the run is not silent —
 * and failing marketplace validation over an unrelated config defect would be a
 * worse answer than validating it unmodified. The reason is logged, never
 * swallowed.
 */
function resolveProjectValidationConfig(
  marketplacePath: string,
  logger: ReturnType<typeof createLogger>,
): ValidationConfig | undefined {
  const projectRoot = findProjectRoot(marketplacePath);
  if (projectRoot === null) return undefined;
  try {
    return loadConfig(projectRoot)?.skills?.defaults?.validation;
  } catch (error) {
    logger.error(
      `Warning: could not read ${projectRoot} config for validation.severity overrides — ` +
        `reporting unmodified severities (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

/** Every finding the command reports, all anchored at one marketplace root. */
export interface MarketplaceFindings {
  marketplaceResult: ValidationResult;
  /** Empty when the manifest failed: the run bails before reaching plugins. */
  pluginResults: ValidationResult[];
  /**
   * Manifest, required-file, plugin and skill issues, in report order, with
   * every severity already resolved against the governing project's
   * `validation.severity` map.
   */
  issues: ValidationIssue[];
  /**
   * The run's overall status — the value the command's exit code is derived
   * from (`error` → 1, otherwise 0), and the status `vat verify` reads back as
   * this phase's status.
   *
   * Computed here rather than by the caller so it cannot be derived from a
   * different issue set than the one reported. A promote-to-`error` override
   * that moved a severity without moving this would be half-wired: the finding
   * would read `error` while the run still exited 0.
   */
  status: 'success' | 'warning' | 'error';
}

/**
 * Run every validator this command reports on, each anchored at
 * `marketplacePath`, and resolve their severities against the governing
 * project's `validation.severity` map.
 *
 * Anchoring is what makes this one function rather than four call sites in the
 * command body. Unlike `path`, an issue `location` cannot be re-based at the
 * document boundary — `relative()` is not idempotent, so an already-relative
 * value is indistinguishable from an absolute one and re-basing it yields
 * nonsense. "Relative to what?" therefore has to be answered identically by
 * every producer at the moment it emits, and answering it in four places is how
 * three producers agreed and the fourth silently anchored at the enclosing
 * PROJECT root instead — putting two coordinate systems in one document, where
 * `join(root, location)` resolved for some findings and named nothing for
 * others.
 *
 * Severity resolution is likewise INSIDE this function rather than a step the
 * command adds after it. Its absence is the whole defect this addressed, and a
 * command-body step is one a caller can forget: with it here, `status`, the
 * exit code, the flat `issues` list and `plugins[].issues` all derive from a
 * single resolved set, and the smallest testable entry point is the one that
 * includes the filter.
 *
 * Exported so that contract is testable against a real marketplace without a
 * CLI spawn; the command adds only the exit code and the emission.
 *
 * @param logger - Used only to report a config that exists but cannot be read.
 *   Required, not optional: a defaulted logger is how that diagnosis goes
 *   nowhere.
 */
export async function collectMarketplaceFindings(
  marketplacePath: string,
  logger: ReturnType<typeof createLogger>,
): Promise<MarketplaceFindings> {
  const marketplaceResult = await validateMarketplace(marketplacePath, {
    locationRoot: marketplacePath,
  });

  // A missing or malformed manifest makes every downstream check meaningless.
  //
  // These issues are deliberately NOT severity-resolved: an override governs
  // findings ABOUT a marketplace that could be read, not the failure to read
  // one. Resolving them would let `MARKETPLACE_MISSING_MANIFEST: ignore` empty
  // the list and report `status: success` beside a summary saying the manifest
  // is missing — a run that never happened claiming it passed.
  if (marketplaceResult.status === 'error') {
    return {
      marketplaceResult,
      pluginResults: [],
      issues: [...marketplaceResult.issues],
      status: 'error',
    };
  }

  const validation = resolveProjectValidationConfig(marketplacePath, logger);
  const fileIssues = checkMarketplaceFiles(marketplacePath);
  const { pluginResults, issues: pluginIssues } = await validatePlugins(marketplacePath, validation);

  const issues = [
    ...resolveIssueSeverity(marketplaceResult.issues, validation),
    ...resolveIssueSeverity(fileIssues, validation),
    ...pluginIssues,
  ];

  return {
    marketplaceResult,
    pluginResults,
    issues,
    status: calculateValidationStatus(issues),
  };
}

/** Everything the emitted report is built from. */
export interface MarketplaceValidateReportInput {
  status: 'success' | 'warning' | 'error';
  /**
   * The marketplace directory: the ONE base every reported `path` AND every
   * issue `location` is relative to.
   *
   * `location` is the half that has to be got right upstream. This builder
   * re-bases `path` (producers hand over absolute paths on purpose), but it
   * cannot re-base a `location` — re-basing is not idempotent, so a location
   * that arrived anchored elsewhere is indistinguishable from a correct one.
   * Every producer feeding this report must therefore already have been told
   * this root: `validatePlugin`/`validateSkill` via `locationRoot`,
   * `checkMarketplaceFiles` via `issueLocation`.
   */
  root: string;
  marketplace: ValidationResult['metadata'];
  pluginResults: readonly ValidationResult[];
  issues: readonly ValidationIssue[];
  issueCounts: SeverityCounts;
  summary: string;
  duration: string;
  /**
   * Publish the flat per-issue list instead of the per-location summary.
   *
   * Picks the UNIT of the `issues` listing, not the content: everything else in
   * the document is a total about the run and is identical in both modes.
   * Optional, and absent means the summary — a caller with no opinion gets the
   * readable form rather than the corpus-scale one.
   */
  verbose?: boolean;
}

/**
 * Group key for findings that carry no `location` at all.
 *
 * A symbol rather than a sentinel string, and it is deliberately NOT published
 * as one: every `location` in this document must satisfy the anchor contract —
 * `join(root, location)` names a real file — so a row keyed `(no location)`
 * would be a path that resolves to nothing, which is the coordinate lie `root`
 * exists to prevent. The row is published with `unlocated: true` and no
 * `location` instead. Dropping such findings was the other option and is the
 * worse one: grouping by `location` is exactly the operation that silently
 * loses them, and a shorter summary is the reassuring failure.
 */
const UNLOCATED = Symbol('unlocated');

/** One inspected asset's DEFAULT row: where, how many, of what code. */
export type LocationIssueSummary = FindingCountSummary & {
  /** The asset, relative to the report's `root`. Absent iff `unlocated`. */
  location?: string;
  /** Set instead of `location` when the findings named no file at all. */
  unlocated?: true;
};

/**
 * Collapse a flat finding list onto one counts-only row per `location`.
 *
 * `location` is this command's per-asset unit: `plugins/alpha/.claude-plugin/
 * plugin.json`, `plugins/beta/skills/x/SKILL.md`. Rows come out in first-seen
 * order, and a location with no findings has no row — there is nothing to
 * filter here, because a location only exists in this listing by having emitted
 * something.
 *
 * Every value is passed through un-rebased: `location` is already relative to
 * the report's stated `root`, and `relative()` is not idempotent (see
 * {@link MarketplaceValidateReportInput.root}).
 */
export function summarizeIssuesByLocation(
  issues: readonly ValidationIssue[],
): LocationIssueSummary[] {
  const byLocation = new Map<string | symbol, ValidationIssue[]>();
  for (const issue of issues) {
    const key = issue.location ?? UNLOCATED;
    const existing = byLocation.get(key);
    if (existing) {
      existing.push(issue);
    } else {
      byLocation.set(key, [issue]);
    }
  }

  return [...byLocation.entries()].map(([key, locationIssues]) => {
    const { codes, ...counts } = summarizeFindings(locationIssues);
    const anchor = typeof key === 'string' ? { location: key } : { unlocated: true as const };
    return { ...anchor, ...counts, codes };
  });
}

/**
 * Build the report `vat claude marketplace validate` publishes on stdout.
 *
 * Pure — returns the document rather than writing it — so the emitted shape,
 * `path` included, is under unit test instead of only under a CLI spawn. One
 * builder serves both exits (manifest-missing bail and full run) so the
 * document has a single shape either way.
 *
 * Being pure is also the limit of what it can guarantee: it re-bases `path`,
 * and passes `issues` through verbatim. The single-coordinate-system property
 * is therefore only as true as its inputs — see `root` above — and is enforced
 * against a real marketplace in `payload-path-coordinates.test.ts`, not here.
 */
export function buildMarketplaceValidateReport(
  input: MarketplaceValidateReportInput,
): Record<string, unknown> {
  const { status, root, marketplace, pluginResults, issues, issueCounts, summary, duration, verbose } = input;

  const plugins = pluginResults.map(r => ({
    path: r.path,
    status: r.status,
    metadata: r.metadata,
    issues: r.issues,
  }));

  return {
    status,
    // Stated once, and the only absolute path in the document.
    root,
    ...(marketplace ? { marketplace } : {}),
    plugins: relativizePathEntries(plugins, root),
    // One row per inspected asset by default; the flat per-issue list under
    // `--verbose`. Either way every `location` stays relative to `root` above.
    issues: verbose === true ? issues : summarizeIssuesByLocation(issues),
    // Counts ride beside the status: `status` names only the worst ACTIONABLE
    // severity, so an info-only run is `success` and the info would otherwise
    // be unreported.
    issueCounts,
    summary,
    duration,
  };
}

/**
 * Validate a marketplace and hand back its document and exit code, printing
 * nothing on stdout.
 *
 * The phase entry point for `vat verify`, which runs this once per configured
 * marketplace IN ITS OWN PROCESS. Progress and findings still go to stderr as
 * they always did; only the decision of where the document lands moves to the
 * caller — stdout for a command-line run, `phases[].report` for an orchestrated
 * one.
 */
export async function runMarketplaceValidatePhase(
  targetPath: string | undefined,
  options: MarketplaceValidateOptions,
): Promise<PhaseOutcome> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const marketplacePath = safePath.resolve(targetPath ?? '.');
    logger.info(`Validating marketplace: ${marketplacePath}`);

    const { marketplaceResult, pluginResults, issues, status } =
      await collectMarketplaceFindings(marketplacePath, logger);

    const bailed = marketplaceResult.status === 'error';
    const issueCounts = countBySeverity(issues);

    return {
      document: buildMarketplaceValidateReport({
        status,
        root: marketplacePath,
        marketplace: marketplaceResult.metadata,
        pluginResults,
        issues,
        issueCounts,
        // A bailed run reports WHY it stopped; a completed run reports what it
        // found. Both emit through the one builder, so the document has a
        // single shape either way.
        summary: bailed
          ? marketplaceResult.summary
          : `${issueCounts.errors} error(s), ${issueCounts.warnings} warning(s), ${issueCounts.info} info`,
        duration: formatDuration(Date.now() - startTime),
        verbose: options.verbose === true,
      }),
      exitCode: status === 'error' ? 1 : 0,
    };
  } catch (error) {
    return {
      document: reportCommandError(error, logger, startTime, 'MarketplaceValidate'),
      exitCode: 2,
      failed: true,
    };
  }
}

async function marketplaceValidateCommand(
  targetPath: string | undefined,
  options: MarketplaceValidateOptions,
): Promise<void> {
  finishCommand(await runMarketplaceValidatePhase(targetPath, options), writeYamlOutput);
}

export function createMarketplaceValidateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate a marketplace directory for publishing')
    .argument('[path]', 'Path to marketplace directory (default: current directory)')
    .option('-d, --debug', 'Enable debug logging')
    .option('-v, --verbose', 'Show all scanned resources, including those without issues')
    .action(marketplaceValidateCommand)
    .addHelpText('after', `
Description:
  Validates a marketplace directory with strict requirements for publishing.
  Checks marketplace.json, plugin manifests, skills, LICENSE, README, and CHANGELOG.

  Plugin versions are required (error, not warning) in strict marketplace validation.

Output (YAML on stdout):
  root: the marketplace directory — every location below is relative to it
  status, issueCounts, summary, duration, marketplace, plugins

  issues: one row per inspected location, carrying only that location's counts
          ({location, errors?, warnings?, info?, codes}). A zero bucket is
          omitted, and a location with no findings has no row.

  --verbose replaces those rows with the flat per-issue list (message, fix and
  all). That form is for '> file' then grep, not for reading.

Exit Codes:
  0 - All validations passed (warnings allowed)
  1 - Validation errors found
  2 - System error (directory not found, etc.)

Example:
  $ vat claude marketplace validate .         # Validate current directory
`);

  return command;
}
