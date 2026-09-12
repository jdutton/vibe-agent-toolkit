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

import { existsSync, readdirSync, statSync } from 'node:fs';

import {
  validateMarketplace,
  validateSkill,
  type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { validatePlugin } from '@vibe-agent-toolkit/claude-marketplace';
import {
  calculateValidationStatus,
  countBySeverity,
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
import { runIntegrityFinding } from '../../../utils/run-integrity.js';
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

/** One manifest entry with a relative-path `source`, as the manifest wrote it. */
export interface LocalPluginSource {
  name: string;
  source: string;
}

/** One declared local plugin the run validated, keyed by the entry it satisfies. */
export interface LocalPluginResult extends LocalPluginSource {
  result: ValidationResult;
}

/**
 * Whether `dir` is a directory. `false` for a file, for nothing, and for a path
 * the process cannot stat — all three are "no plugin directory here".
 */
function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validate the plugins the manifest DECLARES with a local source.
 *
 * 🚨 **This walked `plugins/*` and shipped both defects that has.** The
 * denominator was a count of directories under `plugins/`, so a co-located
 * marketplace (`source: "./"` — the shape `detectResourceFormat` recognises on
 * purpose and `vat audit` recurses into) declared 1, walked 0, and was refused
 * at exit 1 on a code no override can lower; and a manifest declaring
 * `./plugins/a` over a `plugins/` holding only an undeclared `b` validated
 * "1 of 1" and passed with `a` never looked at. Each declared `source` is now
 * resolved against the marketplace root and THAT directory is validated —
 * the same resolution `extractClaudeMarketplaceInventory` performs for
 * `vat audit`. A source that does not resolve to a directory is simply absent
 * from the results; the builder derives the refusal from that absence, so it
 * lands on the document whatever this function's caller does.
 *
 * Directories under `plugins/` that no entry names come back as `undeclared`,
 * relative to the root: listed, not validated, not a failure. The manifest is
 * the marketplace's contract with its installer — Claude Code installs only
 * what `plugins[]` names — so an undeclared directory cannot ship and grading
 * it would grade something no consumer can receive; failing on it would turn a
 * publishing gate into a tree-hygiene gate. Naming it costs nothing and is what
 * lets a reader tell "the plugin you meant is under another name" from "it is
 * not there at all" when a declared source did not resolve.
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
async function validateDeclaredPlugins(
  marketplacePath: string,
  declared: readonly LocalPluginSource[],
  validation: ValidationConfig | undefined,
): Promise<{ pluginResults: LocalPluginResult[]; undeclared: string[]; issues: ValidationIssue[] }> {
  const pluginResults: LocalPluginResult[] = [];
  const issues: ValidationIssue[] = [];
  const resolvedDirs = new Set<string>();

  for (const entry of declared) {
    const pluginDir = safePath.resolve(marketplacePath, entry.source);
    if (!isDirectory(pluginDir)) continue;
    resolvedDirs.add(pluginDir);

    // `locationRoot` is not optional here even though the parameter is: omitted,
    // `validatePlugin` anchors at the plugin's own discovered project root, so
    // its findings land in a different coordinate system than the marketplace
    // and skill findings beside them — and every plugin's manifest collapses to
    // the same `.claude-plugin/plugin.json`.
    const rawResult = await validatePlugin(pluginDir, { strict: true, locationRoot: marketplacePath });
    const pluginIssues = resolveIssueSeverity(rawResult.issues, validation);
    pluginResults.push({
      ...entry,
      result: {
        ...rawResult,
        issues: pluginIssues,
        status: calculateValidationStatus(pluginIssues),
        issueCounts: countBySeverity(pluginIssues),
      },
    });
    issues.push(...pluginIssues);

    const skillIssues = await validatePluginSkills(pluginDir, marketplacePath);
    issues.push(...resolveIssueSeverity(skillIssues, validation));
  }

  return { pluginResults, undeclared: undeclaredPluginDirs(marketplacePath, resolvedDirs), issues };
}

/**
 * Directories under `<root>/plugins/` that no declared source resolved to,
 * relative to the root. The conventional location is the only one walked: an
 * undeclared plugin anywhere else is indistinguishable from any other directory.
 */
function undeclaredPluginDirs(marketplacePath: string, resolvedDirs: ReadonlySet<string>): string[] {
  const pluginsDir = safePath.join(marketplacePath, 'plugins');
  if (!existsSync(pluginsDir)) return [];
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => safePath.join(pluginsDir, entry.name))
    .filter((dir) => !resolvedDirs.has(dir))
    .map((dir) => issueLocation(dir, marketplacePath));
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
  pluginResults: LocalPluginResult[];
  /** `plugins/*` directories no declared source resolved to, relative to the root. */
  undeclared: string[];
  /**
   * Manifest, required-file, plugin and skill issues, in report order, with
   * every severity already resolved against the governing project's
   * `validation.severity` map.
   */
  issues: ValidationIssue[];
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
 * command-body step is one a caller can forget: with it here, the flat `issues`
 * list and `plugins[].issues` derive from a single resolved set, and the
 * smallest testable entry point is the one that includes the filter. The run's
 * `status` — and with it the exit code — is derived one step later, in
 * {@link buildMarketplaceValidateReport}, from the issues the document actually
 * publishes: that is where the run-integrity refusal is added, and a status
 * computed here would not see it.
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
      undeclared: [],
      issues: [...marketplaceResult.issues],
    };
  }

  const validation = resolveProjectValidationConfig(marketplacePath, logger);
  const fileIssues = checkMarketplaceFiles(marketplacePath);
  const { pluginResults, undeclared, issues: pluginIssues } = await validateDeclaredPlugins(
    marketplacePath,
    marketplaceResult.metadata?.localPluginSources ?? [],
    validation,
  );

  const issues = [
    ...resolveIssueSeverity(marketplaceResult.issues, validation),
    ...resolveIssueSeverity(fileIssues, validation),
    ...pluginIssues,
  ];

  return { marketplaceResult, pluginResults, undeclared, issues };
}

/** Everything the emitted report is built from. */
export interface MarketplaceValidateReportInput {
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
  /**
   * One entry per DECLARED local plugin the run validated, each naming the
   * manifest entry it satisfies. Compared against `marketplace.localPluginSources`
   * by the builder: a declared source with no entry here did not resolve.
   */
  pluginResults: readonly LocalPluginResult[];
  /** `plugins/*` directories no declared source resolved to; listed, never graded. */
  undeclared: readonly string[];
  issues: readonly ValidationIssue[];
  /**
   * The manifest's own summary, present iff the run bailed on the manifest. A
   * bailed run reports WHY it stopped; a completed run reports what it found,
   * and the builder writes that counts line itself.
   */
  bailSummary?: string;
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
): MarketplaceValidateReport {
  const { root, marketplace, pluginResults, undeclared, bailSummary, duration, verbose } = input;

  const issues = [
    ...unresolvedLocalPluginsFinding(marketplace, pluginResults),
    ...input.issues,
  ];
  const issueCounts = countBySeverity(issues);

  const plugins = pluginResults.map(({ name, source, result }) => ({
    name,
    source,
    path: result.path,
    status: result.status,
    metadata: result.metadata,
    issues: result.issues,
  }));

  return {
    // Derived from the issues THIS document publishes — the refusal above
    // included — so the status, the counts and the listing cannot disagree, and
    // the exit code the command takes from it cannot either.
    status: calculateValidationStatus(issues),
    // Stated once, and the only absolute path in the document.
    root,
    ...(marketplace ? { marketplace } : {}),
    // The numerator. Beside `marketplace.localPluginSources` it says whether
    // every declared source resolved; without it "three local plugins, all
    // clean" and "three local plugins, none looked at" are the same document.
    pluginsValidated: pluginResults.length,
    plugins: relativizePathEntries(plugins, root),
    // Named, not graded — see `validateDeclaredPlugins`. Always present, so an
    // empty list is a statement that `plugins/` was looked at.
    undeclared: [...undeclared],
    // One row per inspected asset by default; the flat per-issue list under
    // `--verbose`. Either way every `location` stays relative to `root` above.
    issues: verbose === true ? issues : summarizeIssuesByLocation(issues),
    // Counts ride beside the status: `status` names only the worst ACTIONABLE
    // severity, so an info-only run is `success` and the info would otherwise
    // be unreported.
    issueCounts,
    summary: bailSummary
      ?? `${issueCounts.errors} error(s), ${issueCounts.warnings} warning(s), ${issueCounts.info} info`,
    duration,
  };
}

/** The document `vat claude marketplace validate` publishes. */
export interface MarketplaceValidateReport extends Record<string, unknown> {
  status: ReturnType<typeof calculateValidationStatus>;
  pluginsValidated: number;
}

/**
 * The refusal for a run in which a declared local source did not resolve.
 *
 * 🚨 **Two shapes of this shipped.** First, the plugin walk returned nothing
 * when `plugins/` was absent, and the document carried no count, so a
 * marketplace declaring three relative-path plugins over a missing `plugins/`
 * reported `status: success`, exit 0. Then the count that fixed it —
 * `validated < declared` by NUMBER — was wrong in both directions: a co-located
 * `source: "./"` marketplace walked 0 against declared 1 and was refused, and
 * an undeclared `plugins/b` counted for a declared `a` that did not exist.
 *
 * 🔑 **The condition is by IDENTITY, not by count.** `marketplace.localPluginSources`
 * is the manifest's own list of local entries; `pluginResults` names the entry
 * each validated plugin satisfies. A declared entry with no result is a source
 * that did not resolve to a directory, and that is what is refused — whatever
 * else the tree holds. Both halves are in the document, so the refusal is
 * derivable from the document alone. All-remote stays green (nothing local
 * declared); no entries stays green; an undeclared directory is listed under
 * `undeclared` and stays green here — it cannot ship, so it is not a plugin
 * that went unvalidated; a bailed manifest carries no sources and stays a
 * manifest error alone.
 *
 * The message names the unresolved sources: the reader's next move is to fix
 * the `source` or build the tree, and either needs the name.
 *
 * Derived here in the builder, not in {@link collectMarketplaceFindings}, so
 * the status the document publishes — and the exit code taken from it — cannot
 * be computed over an issue set that lacks it. Shared mechanism:
 * `run-integrity.ts`.
 *
 * @param marketplace - The manifest's metadata; `undefined` when the run bailed
 * @param validated - The declared local plugins the run validated
 * @returns The one finding, or nothing
 */
function unresolvedLocalPluginsFinding(
  marketplace: ValidationResult['metadata'],
  validated: readonly LocalPluginResult[],
): readonly ValidationIssue[] {
  const declared = marketplace?.localPluginSources ?? [];
  const unresolved = declared.filter(
    (entry) => !validated.some((v) => v.name === entry.name && v.source === entry.source),
  );
  if (unresolved.length === 0) return [];
  const named = unresolved.map((entry) => `\`${entry.name}\` (${entry.source})`).join(', ');
  return [runIntegrityFinding(
    `The manifest declares ${declared.length} plugin(s) with a local source and this run validated`
    + ` ${validated.length} of them, so this document is not a verdict about the rest: it reads the`
    + ' same as a run over a marketplace whose plugins are all clean.'
    + ` Declared source(s) that did not resolve to a directory under the marketplace root: ${named}.`
    + ' Usually the marketplace was not built, was built somewhere else, or the entry\'s `source`'
    + ' names the wrong directory — `undeclared` above lists the `plugins/` directories the'
    + ' manifest does not name. Fix the `source`, run `vat build` first, or point this command at'
    + ' the built marketplace.',
  )];
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

    const { marketplaceResult, pluginResults, undeclared, issues } =
      await collectMarketplaceFindings(marketplacePath, logger);

    // A bailed run reports WHY it stopped; a completed run reports what it
    // found. Both emit through the one builder, so the document has a single
    // shape either way.
    const bailed = marketplaceResult.status === 'error';
    const document = buildMarketplaceValidateReport({
      root: marketplacePath,
      marketplace: marketplaceResult.metadata,
      pluginResults,
      undeclared,
      issues,
      ...(bailed ? { bailSummary: marketplaceResult.summary } : {}),
      duration: formatDuration(Date.now() - startTime),
      verbose: options.verbose === true,
    });

    // From the DOCUMENT, so the exit code and the published status are one
    // derivation — the run-integrity refusal lands in the builder, and an exit
    // code computed upstream of it would answer 0 over `status: error`.
    return { document, exitCode: document.status === 'error' ? 1 : 0 };
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
  // `undefined`: this command offers no `--format`, so its failure envelope is
  // YAML like its report.
  finishCommand(await runMarketplaceValidatePhase(targetPath, options), writeYamlOutput, undefined);
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
  pluginsValidated: how many of the manifest's relative-path sources
          (marketplace.localPluginSources) resolved to a directory and were
          validated — each plugins[] row names the entry it satisfies. A
          declared source that does not resolve is reported as
          RESOURCE_CHECK_BROKEN at error (exit 1), naming it, rather than as
          a pass — a plugin the manifest ships and this run never saw is not
          a verdict. Co-located marketplaces (source: "./") are validated at
          the root. An all-remote marketplace has nothing local and stays
          green.
  undeclared: directories under plugins/ that no manifest entry names.
          Listed only — they cannot be installed, so they are neither
          validated nor a failure.

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
