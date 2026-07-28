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
import type { GitTracker } from '@vibe-agent-toolkit/utils';
import { resolveAssetReference, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'yaml';

import { formatDurationSecs } from '../../utils/duration.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeTestFormatError } from '../../utils/output.js';
import { projectRootOrLoudCwd } from '../../utils/project-root-policy.js';
import { loadResourcesWithConfig } from '../../utils/resource-loader.js';
import { mergeSkillPackagingConfig } from '../../utils/skill-packaging-config.js';
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
 * Issues grouped by file.
 *
 * Each entry carries the validation `code` and resolved `severity` so the
 * serialized output is honest about what fired and at what level. Warning- and
 * info-severity issues appear here too (so users see them); only error-severity
 * issues drive the exit code, which the library decides via `hasErrors`.
 */
interface FileErrors {
  file: string;
  errors: Array<{
    line: number;
    column: number;
    code: string;
    severity: string;
    message: string;
  }>;
}

/**
 * Output data structure for validation results.
 */
interface ValidationOutputData {
  status: 'success' | 'failed';
  filesScanned: number;
  filesWithErrors?: number;
  linksChecked?: number;
  errorsFound?: number;
  errorSummary?: Record<string, number>;
  validationMode: 'strict' | 'permissive';
  frontmatterSchema?: string;
  collections?: Record<string, CollectionStatWithErrors>;
  errors?: FileErrors[];
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
 * - `code` / `severity` come straight from the unified `ValidationIssue`.
 */
type ErrorData = {
  file: string;
  absPath: string;
  line: number;
  column: number;
  code: string;
  severity: string;
  message: string;
};

/**
 * Output format options.
 */
type OutputFormat = 'yaml' | 'json' | 'text';

/**
 * Group errors by file path.
 */
function groupErrorsByFile(errors: ErrorData[]): FileErrors[] {
  const fileMap = new Map<string, FileErrors>();

  for (const error of errors) {
    const entry = {
      line: error.line,
      column: error.column,
      code: error.code,
      severity: error.severity,
      message: error.message,
    };
    const existing = fileMap.get(error.file);
    if (existing) {
      existing.errors.push(entry);
    } else {
      fileMap.set(error.file, { file: error.file, errors: [entry] });
    }
  }

  return [...fileMap.values()];
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
  errorCount: number;
  validationMetadata: Pick<ValidationOutputData, 'validationMode' | 'frontmatterSchema'>;
  collectionStats: CollectionStats | undefined;
  duration: number;
}

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
 * Output validation results when one or more issues fired.
 *
 * Surfaces ALL severity-resolved issues (errors AND warnings/info) so users see
 * them, but the `failed` flag — derived from the library's `hasErrors` — controls
 * the reported `status`. The caller, not this function, owns the exit code.
 */
function outputIssues(
  issueData: ErrorData[],
  outputFormat: OutputFormat,
  context: ValidationContext,
  registry: { getResource: (path: string) => { collections?: (string[] | undefined) } | undefined },
  failed: boolean
): void {
  if (outputFormat === 'text') {
    // Text format: test-format issues to stderr
    for (const issue of issueData) {
      writeTestFormatError(issue.file, issue.line, issue.column, issue.message);
    }
  } else {
    // Calculate issue summary (keyed by code)
    const summary = buildErrorSummary(issueData, registry);

    // Build collection stats with error info
    const collectionsWithErrors = buildCollectionsWithErrors(
      context.collectionStats,
      summary.collectionErrorStats
    );

    // Group issues by file
    const groupedErrors = groupErrorsByFile(issueData);

    const outputData: ValidationOutputData = {
      status: failed ? 'failed' : 'success',
      filesScanned: context.stats.totalResources,
      filesWithErrors: summary.filesWithErrors,
      errorsFound: context.errorCount,
      errorSummary: summary.errorSummary,
      durationSecs: formatDurationSecs(context.duration),
      ...context.validationMetadata,
      ...(Object.keys(collectionsWithErrors).length > 0 ? { collections: collectionsWithErrors } : {}),
      errors: groupedErrors,
    };

    writeStructuredOutput(outputData, outputFormat);
  }
}

/**
 * Output validation success results.
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
function buildErrorSummary(
  issues: Array<{ code: string; file: string; absPath: string }>,
  registry: { getResource: (path: string) => { collections?: (string[] | undefined) } | undefined }
): {
  errorSummary: Record<string, number>;
  filesWithErrors: number;
  collectionErrorStats: Map<string, { filesWithErrors: number; errorCount: number }>;
} {
  // 1. Count by code
  const errorSummary: Record<string, number> = {};
  for (const issue of issues) {
    errorSummary[issue.code] = (errorSummary[issue.code] ?? 0) + 1;
  }

  // 2. Count unique files with errors
  const filesWithErrorsSet = new Set(issues.map(i => i.file));

  // 3. Map files to collections and count errors per collection.
  //    registry.getResource keys on the ABSOLUTE path, so look up via absPath.
  const collectionErrors = new Map<string, {
    filesWithErrors: Set<string>;
    errorCount: number;
  }>();

  for (const issue of issues) {
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
    errorSummary,
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
 */
function flattenIssuesForDisplay(issues: ValidationResult['issues'], projectRoot: string): ErrorData[] {
  return issues.map(issue => {
    const file = issue.location ?? '';
    return {
      file,
      absPath: file ? safePath.resolve(projectRoot, file) : '',
      line: issue.line ?? 1,
      column: 1,
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
    };
  });
}

interface ValidateOptions {
  debug?: boolean;
  frontmatterSchema?: string; // Path to JSON Schema file
  validationMode?: 'strict' | 'permissive'; // Validation mode for schemas
  format?: OutputFormat; // Output format
  collection?: string; // Filter by collection ID
  checkExternalUrls?: boolean; // NEW: Validate external URLs
  checkHtmlAnchors?: boolean; // Strictly validate HTML fragment anchors against element ids
  noCache?: boolean; // NEW: Disable cache for external URL validation
  checkFrontmatterLinks?: boolean; // Commander negates this when --no-check-frontmatter-links is passed; absent = true
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
 * Returns undefined when the project declares no skills at all — there is
 * nothing to defer, so callers should omit `deferredArtifacts` entirely rather
 * than pass around an empty model.
 */
export async function computeDeferredArtifacts(
  config: ProjectConfig | undefined,
  projectRoot: string,
): Promise<DeferredArtifacts | undefined> {
  if (!config?.skills) {
    return undefined;
  }

  const discovered = await discoverSkillsFromConfig(config.skills, projectRoot);
  const { defaults, config: perSkillConfig } = config.skills;

  const skillFiles: DeferredSkillFiles[] = discovered.map((skill) => {
    const merged = mergeSkillPackagingConfig(
      defaults as Record<string, unknown> | undefined,
      perSkillConfig?.[skill.name] as Record<string, unknown> | undefined,
    );
    const skillDir = path.dirname(skill.sourcePath);
    return {
      // Only what the packager will really copy — an entry pointing into the
      // skill's declared test input is dropped at build time, so its dest cannot
      // defer a link here without contradicting the build.
      files: packagedFileEntries(merged, skillDir, projectRoot),
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
      noCache: options.noCache ?? false,
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
    const { hasErrors } = validationResult;

    // Flatten issues for display (relative `file` + absolute `absPath`).
    const issueData = flattenIssuesForDisplay(filteredIssues, projectRoot);

    // The count shown to the user as "errors" counts only error-severity issues.
    const errorSeverityCount = issueData.filter(i => i.severity === 'error').length;

    const context: ValidationContext = {
      stats: filteredStats,
      errorCount: errorSeverityCount,
      validationMetadata,
      collectionStats,
      duration,
    };

    emitResult(issueData, context, registry, hasErrors, options.format ?? 'yaml');
    logGitTrackerStats(gitTracker, logger);
    // Exit decision is purely the library's severity-based `hasErrors`.
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
 */
function emitResult(
  issueData: ErrorData[],
  context: ValidationContext,
  registry: { getResource: (path: string) => { collections?: (string[] | undefined) } | undefined },
  hasErrors: boolean,
  outputFormat: OutputFormat
): void {
  if (issueData.length > 0) {
    // Issues to surface (errors and/or warnings/info). Reported status follows
    // the exit decision: 'failed' iff the framework flagged errors.
    outputIssues(issueData, outputFormat, context, registry, hasErrors);
  } else {
    outputSuccess(outputFormat, context);
  }
}
