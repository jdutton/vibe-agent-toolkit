/**
 * Resources validate command - strict validation with error reporting
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { packagedFileEntries } from '@vibe-agent-toolkit/agent-skills';
import {
  DeferredArtifacts,
  type CollectionStats,
  type DeferredSkillFiles,
  type ProjectConfig,
  type RegistryStats,
  type ValidationResult,
} from '@vibe-agent-toolkit/resources';
import {
  calculateValidationStatus,
  countBySeverity,
  type IssueSeverity,
  type SeverityCounts,
  type ValidationIssueCode,
} from '@vibe-agent-toolkit/schema';
import type { GitTracker } from '@vibe-agent-toolkit/utils';
import { resolveAssetReference, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'yaml';

import { formatDurationSecs } from '../../utils/duration.js';
import { summarizeFindings, type FindingCountSummary } from '../../utils/issue-rendering.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeTestFormatError } from '../../utils/output.js';
import { projectRootOrLoudCwd } from '../../utils/project-root-policy.js';
import { loadResourcesWithConfig } from '../../utils/resource-loader.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig } from '../../utils/skill-packaging-config.js';
import { discoverSkillsFromConfig } from '../skills/skill-discovery.js';

import { handleCommandError } from './command-helpers.js';

/**
 * Collection statistics with error tracking.
 */
interface CollectionStatWithErrors {
  resourceCount: number;
  hasSchema: boolean;
  validationMode?: 'strict' | 'permissive';
  filesWithErrors?: number;
  errorCount?: number;
}

async function loadSchema(schemaPath: string): Promise<object> {
  const resolvedPath = resolveAssetReference(schemaPath, process.cwd());

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- schemaPath resolved via resolveAssetReference
  const content = await readFile(resolvedPath, 'utf-8');
  const ext = path.extname(resolvedPath).toLowerCase();

  if (ext === '.json') {
    return JSON.parse(content) as object;
  } else if (ext === '.yaml' || ext === '.yml') {
    const parsed = yaml.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as object;
    }
    throw new Error('YAML schema must be an object');
  } else {
    throw new Error(`Unsupported schema format: ${ext} (use .json or .yaml)`);
  }
}

/**
 * Issues grouped by file — the `--verbose` row.
 *
 * Each entry carries the validation `code` and resolved `severity` so the
 * serialized output is honest about what fired and at what level. Warning- and
 * info-severity issues appear here too (so users see them); only error-severity
 * issues drive the exit code, which the library decides via `hasErrors`.
 *
 * This shape is optimized for `> file` then `grep`, not for reading.
 */
interface FileIssues {
  file: string;
  issues: Array<{
    line: number;
    column: number;
    code: string;
    severity: string;
    message: string;
  }>;
}

/**
 * One file's DEFAULT row: which file has problems, how many, of what code — and
 * nothing else.
 *
 * The unit is the file because the file is what a reader opens to act. Zero
 * severity buckets are ABSENT keys rather than `0` (see {@link summarizeFindings}):
 * three zero columns per file is what makes a listing unreadable at corpus
 * scale, and `errors: 0` beside a red exit code reads as a contradiction.
 */
type FileIssueSummary = FindingCountSummary & { file: string };

/** A file's row in the reported listing — counts by default, detail under `--verbose`. */
type FileIssueRow = FileIssues | FileIssueSummary;

/**
 * The verdict vocabulary, taken from the shared collapse rather than restated —
 * so this command cannot drift into a private vocabulary again. Every other
 * validation lane answers "issues → status" with these same three values.
 */
type ValidationStatus = ReturnType<typeof calculateValidationStatus>;

/**
 * Output data structure for validation results.
 *
 * Naming contract, and it is load-bearing: a field named `error*` counts
 * ERROR-severity issues only — the ones that fail the run. A field named
 * `issue*` counts issues of every severity. Mixing the two is what made an
 * earlier shape of this object contradict itself (`status: success` beside
 * `filesWithErrors: 1` beside `errorsFound: 0`).
 */
interface ValidationOutputData {
  /** Worst ACTIONABLE severity over the reported issues; info-only is `success`. */
  status: ValidationStatus;
  filesScanned: number;
  /** Files carrying at least one ERROR-severity issue. */
  filesWithErrors?: number;
  linksChecked?: number;
  /** ERROR-severity issues only; this is what drives the exit code. */
  errorsFound?: number;
  /** Every issue, split by severity. Only `errors` is fatal. */
  issueCounts?: SeverityCounts;
  /** Count per validation code, ALL severities. */
  issueSummary?: Record<string, number>;
  validationMode: 'strict' | 'permissive';
  frontmatterSchema?: string;
  collections?: Record<string, CollectionStatWithErrors>;
  /**
   * Per-file rows, ALL severities. Counts-only by default; per-issue detail
   * under `--verbose`. A file that emitted nothing has no row in either mode —
   * `filesScanned` above stays the true denominator.
   */
  issues?: FileIssueRow[];
  durationSecs: number;
}

/**
 * Write structured output in specified format.
 */
function writeStructuredOutput(data: ValidationOutputData, format: Exclude<OutputFormat, 'text'>): void {
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(yaml.stringify(data, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false }));
  }
}

/**
 * Issue data for a single validation issue, flattened for display.
 *
 * - `file` is RELATIVE to projectRoot (matches `issue.location`), used for display.
 * - `absPath` is the ABSOLUTE resource path, used for registry/collection lookups.
 * - `code` / `severity` come straight from the unified `ValidationIssue`, and stay
 *   typed as such: that makes an `ErrorData` a structural `ValidationIssue`, so the
 *   shared `calculateValidationStatus`/`countBySeverity` consume this list directly
 *   instead of a local re-implementation counting severities its own way.
 */
type ErrorData = {
  file: string;
  absPath: string;
  line: number;
  column: number;
  code: ValidationIssueCode;
  severity: IssueSeverity;
  message: string;
};

/**
 * Output format options.
 */
type OutputFormat = 'yaml' | 'json' | 'text';

/**
 * Group issues by file path, preserving first-seen file order.
 *
 * ONE grouping serves both listing modes, so the two can never disagree about
 * which files have findings — only about how much they say per file.
 */
function groupIssuesByFile(issues: ErrorData[]): Map<string, ErrorData[]> {
  const fileMap = new Map<string, ErrorData[]>();

  for (const issue of issues) {
    const existing = fileMap.get(issue.file);
    if (existing) {
      existing.push(issue);
    } else {
      fileMap.set(issue.file, [issue]);
    }
  }

  return fileMap;
}

/**
 * Project the grouping onto the rows the report publishes.
 *
 * A file only reaches this function if it emitted something, so "clean files are
 * omitted" is a property of the input, not a filter applied here.
 */
function buildIssueRows(issues: ErrorData[], verbose: boolean): FileIssueRow[] {
  return [...groupIssuesByFile(issues).entries()].map(([file, fileIssues]) => {
    if (verbose) {
      return {
        file,
        issues: fileIssues.map((issue) => ({
          line: issue.line,
          column: issue.column,
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
        })),
      };
    }
    const { codes, ...counts } = summarizeFindings(fileIssues);
    return { file, ...counts, codes };
  });
}

/**
 * Log git tracker stats if available.
 */
function logGitTrackerStats(gitTracker: GitTracker | undefined, logger: Logger): void {
  if (gitTracker) {
    const gitStats = gitTracker.getStats();
    logger.debug(`Git tracker cache size: ${gitStats.cacheSize} files`);
  }
}

/**
 * Context for validation output.
 */
interface ValidationContext {
  stats: RegistryStats;
  validationMetadata: Pick<ValidationOutputData, 'validationMode' | 'frontmatterSchema'>;
  collectionStats: CollectionStats | undefined;
  duration: number;
}

/** The only thing the output layer needs from the registry: collection lookup by ABSOLUTE path. */
type RegistryLookup = {
  getResource: (path: string) => { collections?: (string[] | undefined) } | undefined;
};

/**
 * Merge per-collection error stats into the base collection stats for output.
 */
function buildCollectionsWithErrors(
  collectionStats: CollectionStats | undefined,
  collectionErrorStats: Map<string, { filesWithErrors: number; errorCount: number }>
): Record<string, CollectionStatWithErrors> {
  const collectionsWithErrors: Record<string, CollectionStatWithErrors> = {};
  if (!collectionStats) {
    return collectionsWithErrors;
  }
  for (const [id, baseStat] of Object.entries(collectionStats.collections)) {
    const errorStat = collectionErrorStats.get(id);
    collectionsWithErrors[id] = {
      ...baseStat,
      ...(errorStat ? {
        filesWithErrors: errorStat.filesWithErrors,
        errorCount: errorStat.errorCount,
      } : {}),
    };
  }
  return collectionsWithErrors;
}

/**
 * Build the structured (yaml/json) payload for a run that surfaced issues.
 *
 * Surfaces ALL severity-resolved issues (errors AND warnings/info) so users see
 * them; only the `error*`-named counts are error-severity. Exported so the
 * reported vocabulary is unit-testable without spawning the CLI.
 *
 * `verbose` picks the UNIT of the `issues` listing, not the content: one
 * counts-only row per file by default, one entry per issue when asked. Every
 * other field is a total about the run and is byte-identical in both modes.
 * It defaults to the summary, so a caller that has no opinion gets the readable
 * form rather than the 90-skill-scale one.
 */
export function buildIssuesOutputData(
  issueData: ErrorData[],
  context: ValidationContext,
  registry: RegistryLookup,
  verbose = false
): ValidationOutputData {
  const summary = buildIssueSummary(issueData, registry);
  const collectionsWithErrors = buildCollectionsWithErrors(
    context.collectionStats,
    summary.collectionErrorStats
  );
  // ONE answer to "issues → status", from the shared collapse in schema —
  // the worst ACTIONABLE severity, so an info-only run is `success`. That is
  // honest only because `issueCounts` rides beside it, naming what was found.
  const issueCounts = countBySeverity(issueData);

  return {
    status: calculateValidationStatus(issueData),
    filesScanned: context.stats.totalResources,
    filesWithErrors: summary.filesWithErrors,
    errorsFound: issueCounts.errors,
    issueCounts,
    issueSummary: summary.issueSummary,
    durationSecs: formatDurationSecs(context.duration),
    ...context.validationMetadata,
    ...(Object.keys(collectionsWithErrors).length > 0 ? { collections: collectionsWithErrors } : {}),
    issues: buildIssueRows(issueData, verbose),
  };
}

/**
 * Output validation success results.
 *
 * Reached only when NOTHING was emitted, so the literal `success` is not a second
 * derivation of the verdict — it is what the shared collapse returns for an empty
 * issue set. Any run that emitted anything, at any severity, goes through
 * {@link buildIssuesOutputData} instead.
 */
function outputSuccess(
  outputFormat: OutputFormat,
  context: Pick<ValidationContext, 'stats' | 'validationMetadata' | 'collectionStats' | 'duration'>
): void {
  if (outputFormat === 'text') {
    // Text format: simple success message
    console.log('✓ All validations passed');
    console.log(`Files scanned: ${context.stats.totalResources}`);
    console.log(`Links checked: ${context.stats.totalLinks}`);
    if (context.collectionStats) {
      console.log(`Collections: ${context.collectionStats.totalCollections}`);
      console.log(`Resources in collections: ${context.collectionStats.resourcesInCollections}`);
    }
    console.log(`Duration: ${context.duration}ms`);
  } else {
    // Structured format (yaml/json)
    const outputData: ValidationOutputData = {
      status: 'success',
      filesScanned: context.stats.totalResources,
      linksChecked: context.stats.totalLinks,
      durationSecs: formatDurationSecs(context.duration),
      ...context.validationMetadata,
      ...(context.collectionStats ? { collections: context.collectionStats.collections } : {}),
    };

    writeStructuredOutput(outputData, outputFormat);
  }
}

/**
 * Build error summary from validation issues.
 *
 * Calculates:
 * - Error counts by type
 * - Unique files with errors
 * - Per-collection error statistics
 *
 * @param issues - Flattened validation issues (relative `file`, absolute `absPath`, `code`)
 * @param registry - Resource registry for collection lookups (keyed by ABSOLUTE path)
 * @returns Error summary statistics
 */
function buildIssueSummary(
  issues: ErrorData[],
  registry: RegistryLookup
): {
  issueSummary: Record<string, number>;
  filesWithErrors: number;
  collectionErrorStats: Map<string, { filesWithErrors: number; errorCount: number }>;
} {
  // 1. Count by code — ALL severities, so an info-only scan still reports WHICH
  //    codes fired rather than an empty object.
  const issueSummary: Record<string, number> = {};
  for (const issue of issues) {
    issueSummary[issue.code] = (issueSummary[issue.code] ?? 0) + 1;
  }

  // 2. Every remaining count in this function is named `error*`, so every one of
  //    them is computed over ERROR-severity issues only. A file carrying nothing
  //    but info notes is not a file with errors.
  const errorIssues = issues.filter((i) => i.severity === 'error');
  const filesWithErrorsSet = new Set(errorIssues.map(i => i.file));

  // 3. Map files to collections and count errors per collection.
  //    registry.getResource keys on the ABSOLUTE path, so look up via absPath.
  const collectionErrors = new Map<string, {
    filesWithErrors: Set<string>;
    errorCount: number;
  }>();

  for (const issue of errorIssues) {
    const resource = registry.getResource(issue.absPath);
    const collections = resource?.collections;
    if (collections) {
      for (const collectionId of collections) {
        const stat = collectionErrors.get(collectionId) ?? {
          filesWithErrors: new Set(),
          errorCount: 0,
        };
        stat.filesWithErrors.add(issue.file);
        stat.errorCount++;
        collectionErrors.set(collectionId, stat);
      }
    }
  }

  // Convert Sets to counts
  const collectionStats = new Map<string, { filesWithErrors: number; errorCount: number }>();
  for (const [id, stat] of collectionErrors.entries()) {
    collectionStats.set(id, {
      filesWithErrors: stat.filesWithErrors.size,
      errorCount: stat.errorCount,
    });
  }

  return {
    issueSummary,
    filesWithErrors: filesWithErrorsSet.size,
    collectionErrorStats: collectionStats,
  };
}

/**
 * Restrict issues and stats to a single collection.
 *
 * Issue locations are RELATIVE to projectRoot, but `resource.filePath` is
 * ABSOLUTE — convert the collection's resource paths to the same relative basis
 * before comparing, so the filter actually matches.
 */
function filterByCollection(
  registry: {
    getAllResources: () => Array<{ collections?: string[] | undefined; filePath: string; links: unknown[] }>;
  },
  validationResult: ValidationResult,
  collection: string,
  projectRoot: string
): { filteredIssues: ValidationResult['issues']; filteredStats: RegistryStats } {
  const collectionResources = registry
    .getAllResources()
    .filter(r => r.collections?.includes(collection) ?? false);
  const collectionPaths = new Set(
    collectionResources.map(r => safePath.relative(projectRoot, r.filePath))
  );

  const filteredIssues = validationResult.issues.filter(
    issue => issue.location !== undefined && collectionPaths.has(issue.location)
  );

  const totalLinks = collectionResources.reduce((sum, r) => sum + r.links.length, 0);
  return {
    filteredIssues,
    filteredStats: {
      totalResources: collectionResources.length,
      totalLinks,
      linksByType: validationResult.linksByType, // Keep all link types
    },
  };
}

/**
 * Flatten severity-resolved issues for display.
 *
 * `file` is RELATIVE to projectRoot (matches `issue.location`, used for display);
 * `absPath` is ABSOLUTE (for registry/collection lookups via getResource).
 *
 * `code` is re-narrowed on the way through: `ValidationResult` is Zod-inferred and
 * its schema widens `code` to `string` on purpose, while the hand-written
 * `ValidationIssue` interface — the contract every producer builds against — types
 * it as `ValidationIssueCode`. Restoring that narrowing here is what lets the
 * shared `calculateValidationStatus`/`countBySeverity` read this list directly.
 */
function flattenIssuesForDisplay(issues: ValidationResult['issues'], projectRoot: string): ErrorData[] {
  return issues.map(issue => {
    const file = issue.location ?? '';
    return {
      file,
      absPath: file ? safePath.resolve(projectRoot, file) : '',
      line: issue.line ?? 1,
      column: 1,
      code: issue.code as ValidationIssueCode,
      severity: issue.severity,
      message: issue.message,
    };
  });
}

export interface ValidateOptions {
  debug?: boolean;
  /** Show all scanned resources, including those without issues (per-issue detail). */
  verbose?: boolean;
  frontmatterSchema?: string; // Path to JSON Schema file
  validationMode?: 'strict' | 'permissive'; // Validation mode for schemas
  format?: OutputFormat; // Output format
  collection?: string; // Filter by collection ID
  checkExternalUrls?: boolean; // NEW: Validate external URLs
  checkHtmlAnchors?: boolean; // Strictly validate HTML fragment anchors against element ids
  cache?: boolean; // Commander negates this when --no-cache is passed; absent = true (cache enabled)
  checkFrontmatterLinks?: boolean; // Commander negates this when --no-check-frontmatter-links is passed; absent = true
}

/**
 * Translate `--no-cache` into the `noCache` input `ResourceRegistry.validate()`
 * takes.
 *
 * Commander represents a `--no-x` boolean as the POSITIVE key `x` — defaulted to
 * `true`, set to `false` only when the negated flag is passed. It never emits a
 * `noX` key. This site used to read `options.noCache`, typed against an
 * interface that itself declared `noCache?: boolean`, so the compiler validated
 * a read of a key Commander cannot produce: `--no-cache` was a silent no-op and
 * the external-URL cache was never disabled. Declaring the key Commander really
 * emits is what makes the type an ally here rather than an accomplice.
 */
export function resolveNoCache(options: Pick<ValidateOptions, 'cache'>): boolean {
  return options.cache === false;
}

/**
 * Apply the --no-check-frontmatter-links CLI flag to the loaded config.
 *
 * Mutates the config object in place (the registry holds a reference to the
 * same object, so validate() will see the updated value).
 */
function applyNoCheckFrontmatterLinksFlag(config: ProjectConfig | undefined): void {
  if (!config?.resources?.collections) return;
  for (const collection of Object.values(config.resources.collections)) {
    if (collection.validation) {
      collection.validation.checkFrontmatterLinks = false;
    }
  }
}

/**
 * Compute the project's `DeferredArtifacts` model for `vat resources validate`,
 * reusing the SAME skill discovery (`discoverSkillsFromConfig`), config merge
 * (`mergeSkillPackagingConfig`) and test-input filter (`packagedFileEntries`) that
 * the skills lanes use — so no two lanes can disagree about a skill's effective
 * `files:` config, or about which of those entries the build will actually copy,
 * for the same link. Exported (rather than inlined in `validateCommand`) so any
 * other lane that needs the project's deferred model shares this derivation
 * instead of re-deriving it.
 *
 * Returns undefined when the project declares no skills at all, or when no skill
 * declares a `files:` mapping — in either case there is nothing to defer, so
 * callers should omit `deferredArtifacts` entirely rather than pass around an
 * empty model. The `files:` short-circuit also keeps skill discovery (a read and
 * a frontmatter parse per declared skill) off `vat resources validate` for the
 * majority of projects, which declare no `files:` at all.
 */
export async function computeDeferredArtifacts(
  config: ProjectConfig | undefined,
  projectRoot: string,
): Promise<DeferredArtifacts | undefined> {
  if (!config?.skills) {
    return undefined;
  }
  const declaresFiles =
    config.skills.defaults?.files !== undefined ||
    Object.values(config.skills.config ?? {}).some((skill) => skill?.files !== undefined);
  if (!declaresFiles) {
    return undefined;
  }

  const discovered = await discoverSkillsFromConfig(config.skills, projectRoot);
  const { defaults, config: perSkillConfig } = config.skills;

  // Assembled ONCE for the whole run, then handed to every skill below. Rebuilding
  // it inside the map would walk the project's entire skills config per skill.
  const projectSkills = collectDeclaredEvalSuites(config.skills, discovered);

  const skillFiles: DeferredSkillFiles[] = discovered.map((skill) => {
    const merged = mergeSkillPackagingConfig(
      defaults as Record<string, unknown> | undefined,
      perSkillConfig?.[skill.name] as Record<string, unknown> | undefined,
    );
    const skillDir = path.dirname(skill.sourcePath);
    return {
      // Only what the packager will really copy — an entry pointing into ANY
      // skill's declared test input (its own or a sibling's) is dropped at build
      // time, so its dest cannot defer a link here without contradicting the build.
      files: packagedFileEntries(merged, skillDir, projectRoot, projectSkills),
      skillDir,
    };
  });

  return DeferredArtifacts.from(skillFiles, projectRoot);
}

export async function validateCommand(
  pathArg: string | undefined,
  options: ValidateOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Resolve projectRoot at the CLI boundary (spec §5/§7 — loud-cwd policy).
    const projectRoot = projectRootOrLoudCwd(pathArg ?? process.cwd(), logger);

    // Load resources with config support (includes GitTracker initialization)
    const { registry, config, gitTracker } = await loadResourcesWithConfig(
      pathArg,
      projectRoot,
      logger,
    );

    // CLI flag: --no-check-frontmatter-links disables the check for every collection.
    // Commander represents the negated form as options.checkFrontmatterLinks === false.
    if (options.checkFrontmatterLinks === false) {
      applyNoCheckFrontmatterLinksFlag(config);
    }

    // Load frontmatter schema if provided
    let frontmatterSchemaObj: object | undefined;
    if (options.frontmatterSchema) {
      logger.debug(`Loading frontmatter schema from: ${options.frontmatterSchema}`);
      frontmatterSchemaObj = await loadSchema(options.frontmatterSchema);
    }

    // Compute deferred build-artifact coverage from the SAME skill discovery +
    // config-merge `vat skills validate` uses, so a `files:`-declared link that
    // lane reports as LINK_DEFERRED_ARTIFACT (info) is never independently
    // reported here as LINK_BROKEN_FILE (error) — the headline bug this closes.
    const deferredArtifacts = await computeDeferredArtifacts(config, projectRoot);

    // Validate all resources
    const validationMode = options.validationMode ?? 'strict';
    const validationResult = await registry.validate({
      ...(frontmatterSchemaObj ? { frontmatterSchema: frontmatterSchemaObj } : {}),
      validationMode,
      checkExternalUrls: options.checkExternalUrls ?? false,
      checkHtmlAnchors: options.checkHtmlAnchors ?? false,
      noCache: resolveNoCache(options),
      // Thread the project's resources.validation config in. The CLI does NOT
      // resolve severity itself — ResourceRegistry.validate() runs the framework.
      validationConfig: config?.resources?.validation ?? {},
      ...(deferredArtifacts !== undefined && { deferredArtifacts }),
    });

    // Filter by collection if specified
    const { filteredIssues, filteredStats } = options.collection
      ? filterByCollection(registry, validationResult, options.collection, projectRoot)
      : { filteredIssues: validationResult.issues, filteredStats: registry.getStats() };

    const duration = Date.now() - startTime;

    // Build validation metadata
    const validationMetadata: Pick<ValidationOutputData, 'validationMode' | 'frontmatterSchema'> = {
      validationMode,
      ...(options.frontmatterSchema ? { frontmatterSchema: options.frontmatterSchema } : {}),
    };

    // Get collection stats (narrowed to the requested collection, if any).
    const collectionStats = narrowCollectionStats(registry.getCollectionStats(), options.collection);

    // The library already severity-resolved every issue (allow-filtered, ignored
    // dropped) and decided pass/fail. The CLI is a dumb orchestrator: the failure
    // decision is exactly the framework's severity-based `hasErrors`. Warning- and
    // info-severity issues are surfaced below but DO NOT flip the exit code.
    //
    // The reported `status` is derived separately, from the issues actually
    // REPORTED (post `--collection` filter) — see `buildIssuesOutputData`. Without
    // a filter the two are the same question with the same answer: `hasErrors` and
    // `calculateValidationStatus(...) === 'error'` are both "any error-severity
    // issue". With `--collection`, `status` describes the collection asked about
    // while the exit code still covers the whole project.
    const { hasErrors } = validationResult;

    // Flatten issues for display (relative `file` + absolute `absPath`).
    const issueData = flattenIssuesForDisplay(filteredIssues, projectRoot);

    const context: ValidationContext = {
      stats: filteredStats,
      validationMetadata,
      collectionStats,
      duration,
    };

    emitResult(issueData, context, registry, options.format ?? 'yaml', options.verbose === true);
    logGitTrackerStats(gitTracker, logger);
    // The library's severity-based `hasErrors` is the WHOLE decision: every
    // finding this command reports came from `registry.validate()`, which
    // already allow-filtered and severity-resolved them. Nothing is reported
    // here that the library never saw, so there is no second clause to OR in.
    process.exit(hasErrors ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Validation');
  }
}

/**
 * Narrow collection stats to a single requested collection (no-op when no
 * collection filter is active or the collection has no stats).
 */
function narrowCollectionStats(
  collectionStats: CollectionStats | undefined,
  collection: string | undefined
): CollectionStats | undefined {
  if (!collection || !collectionStats) {
    return collectionStats;
  }
  const collectionStat = collectionStats.collections[collection];
  if (!collectionStat) {
    return collectionStats;
  }
  return {
    totalCollections: 1,
    resourcesInCollections: collectionStat.resourceCount,
    collections: { [collection]: collectionStat },
  };
}

/**
 * Emit the result to stdout. Surfaces all issues when any fired; otherwise emits
 * a clean success. Does NOT decide the exit code — the caller owns that.
 *
 * `--format text` is unaffected by `verbose`: it is already one
 * `file:line:col:` line per issue, which is what `--verbose` restores in the
 * structured formats.
 */
function emitResult(
  issueData: ErrorData[],
  context: ValidationContext,
  registry: RegistryLookup,
  outputFormat: OutputFormat,
  verbose: boolean
): void {
  if (issueData.length === 0) {
    outputSuccess(outputFormat, context);
    return;
  }
  if (outputFormat === 'text') {
    // Text format: one `file:line:col: severity: message` line per issue, to
    // stderr. The severity is what tells a reader which lines are fatal — the
    // text renderer prints no verdict word of its own, so it cannot contradict
    // the `status` the structured renderer reports.
    for (const issue of issueData) {
      writeTestFormatError(issue.file, issue.line, issue.column, issue.severity, issue.message);
    }
    return;
  }
  writeStructuredOutput(buildIssuesOutputData(issueData, context, registry, verbose), outputFormat);
}
