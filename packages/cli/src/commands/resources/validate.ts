/**
 * Resources validate command - strict validation with error reporting
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { CollectionStats, RegistryStats } from '@vibe-agent-toolkit/resources';
import type { GitTracker } from '@vibe-agent-toolkit/utils';
import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';

import { formatDurationSecs } from '../../utils/duration.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeTestFormatError } from '../../utils/output.js';
import { loadResourcesWithConfig } from '../../utils/resource-loader.js';

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

/**
 * Resolve schema path (supports both package paths and file paths).
 *
 * This function implements Node.js-style module resolution for schema paths,
 * allowing users to reference schemas from installed packages OR local files.
 *
 * **Path Resolution Rules:**
 *
 * 1. **Absolute paths** (start with `/`) → Used as-is
 *    - Example: `/Users/jeff/project/schema.json`
 *
 * 2. **Explicit relative paths** (start with `./` or `../`) → Used as-is
 *    - Example: `./schemas/skill-schema.json`
 *    - Example: `../shared/schema.json`
 *
 * 3. **Scoped package paths** (start with `@`) → Resolved via Node.js module system
 *    - Example: `@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json`
 *    - Requires package to be installed and subpath to be exported
 *    - Throws error if package not found or subpath not exported
 *
 * 4. **Bare specifiers** (everything else) → Try package first, fallback to file
 *    - Example: `lodash/fp/array.json` → Tries package "lodash", falls back to file
 *    - Example: `schemas/file.json` → Tries package "schemas" (unlikely), falls back to file
 *    - Only collides if a package with matching name is installed
 *
 * **Why This Works Everywhere:**
 * - Uses Node.js's `import.meta.resolve()` which works in any environment
 * - Respects package.json "exports" field
 * - Works in development (monorepo) and production (npm install)
 *
 * **Best Practices for Users:**
 * - Package references: Use full package path with `@scope` prefix when possible
 * - File references: Use explicit `./` prefix to avoid ambiguity
 * - Avoid bare specifiers unless you know they won't collide
 *
 * @param schemaPath - Path to schema (package path or file path)
 * @returns Resolved absolute file path
 * @throws Error if scoped package path cannot be resolved
 * @internal Exported for testing
 */
export async function resolveSchemaPath(schemaPath: string): Promise<string> {
  // Rule 1 & 2: Absolute or explicit relative paths → File
  const normalizedPath = toForwardSlash(schemaPath);
  if (path.isAbsolute(schemaPath) ||
      normalizedPath.startsWith('./') ||
      normalizedPath.startsWith('../')) {
    return schemaPath;
  }

  // Rule 3 & 4: Package paths or bare specifiers → Try module resolution
  try {
    // Use Node.js native module resolution
    // This respects package.json "exports" and works everywhere
    const resolved = import.meta.resolve(schemaPath, import.meta.url);

    // Convert file:// URL to filesystem path
    return new URL(resolved).pathname;
  } catch (error) {
    // Package resolution failed - could be:
    // 1. Package not installed
    // 2. Subpath not exported in package.json
    // 3. Not actually a package reference (just a file path)

    // For scoped packages, this is definitely an error
    if (normalizedPath.startsWith('@')) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Extract package name from scoped package path like "@scope/package/sub/path.json"
      const pathParts = normalizedPath.split('/');
      const packageName = pathParts.length >= 2 ? `${pathParts[0] ?? ''}/${pathParts[1] ?? ''}` : schemaPath;
      throw new Error(
        `Cannot resolve package path: ${schemaPath}\n` +
        `Possible causes:\n` +
        `  - Package not installed (run: npm install ${String(packageName)})\n` +
        `  - Subpath not exported in package.json "exports" field\n` +
        `  - Typo in package name or path\n` +
        `Original error: ${message}`
      );
    }

    // For bare specifiers, assume it's a file path
    // This allows "schemas/file.json" to work when no package "schemas" exists
    return schemaPath;
  }
}

/**
 * Load JSON Schema from file (supports .json and .yaml).
 *
 * Supports both package-based paths (via import.meta.resolve) and file paths.
 * See `resolveSchemaPath()` for path resolution rules.
 *
 * @param schemaPath - Path to schema file (package path or file path)
 * @returns Parsed schema object
 */
async function loadSchema(schemaPath: string): Promise<object> {
  const resolvedPath = await resolveSchemaPath(schemaPath);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- schemaPath is user-provided CLI argument, validated by resolveSchemaPath
  const content = await readFile(resolvedPath, 'utf-8');
  const ext = path.extname(resolvedPath).toLowerCase();

  if (ext === '.json') {
    return JSON.parse(content) as object;
  } else if (ext === '.yaml' || ext === '.yml') {
    const parsed = yaml.load(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as object;
    }
    throw new Error('YAML schema must be an object');
  } else {
    throw new Error(`Unsupported schema format: ${ext} (use .json or .yaml)`);
  }
}

/**
 * Error grouped by file.
 */
interface FileErrors {
  file: string;
  errors: Array<{
    line: number;
    column: number;
    type: string;
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
    console.log(yaml.dump(data, { indent: 2, lineWidth: -1 }));
  }
}

/**
 * Error data for a single validation issue.
 */
type ErrorData = { file: string; line: number; column: number; type: string; message: string };

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
    const existing = fileMap.get(error.file);
    if (existing) {
      existing.errors.push({
        line: error.line,
        column: error.column,
        type: error.type,
        message: error.message,
      });
    } else {
      fileMap.set(error.file, {
        file: error.file,
        errors: [{
          line: error.line,
          column: error.column,
          type: error.type,
          message: error.message,
        }],
      });
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
 * Output validation failure results.
 */
function outputFailure(
  errorData: ErrorData[],
  outputFormat: OutputFormat,
  context: ValidationContext,
  registry: { getResource: (path: string) => { collections?: (string[] | undefined) } | undefined }
): void {
  if (outputFormat === 'text') {
    // Text format: test-format errors to stderr
    for (const error of errorData) {
      writeTestFormatError(error.file, error.line, error.column, error.message);
    }
  } else {
    // Calculate error summary
    const summary = buildErrorSummary(errorData, registry);

    // Build collection stats with error info
    const collectionsWithErrors: Record<string, CollectionStatWithErrors> = {};
    if (context.collectionStats) {
      for (const [id, baseStat] of Object.entries(context.collectionStats.collections)) {
        const errorStat = summary.collectionErrorStats.get(id);
        collectionsWithErrors[id] = {
          ...baseStat,
          ...(errorStat ? {
            filesWithErrors: errorStat.filesWithErrors,
            errorCount: errorStat.errorCount,
          } : {}),
        };
      }
    }

    // Group errors by file
    const groupedErrors = groupErrorsByFile(errorData);

    const outputData: ValidationOutputData = {
      status: 'failed',
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
 * @param issues - Validation issues from registry (using ErrorData format with file instead of resourcePath)
 * @param registry - Resource registry for collection lookups
 * @returns Error summary statistics
 */
function buildErrorSummary(
  issues: Array<{ type: string; file: string }>,
  registry: { getResource: (path: string) => { collections?: (string[] | undefined) } | undefined }
): {
  errorSummary: Record<string, number>;
  filesWithErrors: number;
  collectionErrorStats: Map<string, { filesWithErrors: number; errorCount: number }>;
} {
  // 1. Count by error type
  const errorSummary: Record<string, number> = {};
  for (const issue of issues) {
    errorSummary[issue.type] = (errorSummary[issue.type] ?? 0) + 1;
  }

  // 2. Count unique files with errors
  const filesWithErrorsSet = new Set(issues.map(i => i.file));

  // 3. Map files to collections and count errors per collection
  const collectionErrors = new Map<string, {
    filesWithErrors: Set<string>;
    errorCount: number;
  }>();

  for (const issue of issues) {
    const resource = registry.getResource(issue.file);
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

interface ValidateOptions {
  debug?: boolean;
  frontmatterSchema?: string; // Path to JSON Schema file
  validationMode?: 'strict' | 'permissive'; // Validation mode for schemas
  format?: OutputFormat; // Output format
  collection?: string; // Filter by collection ID
  checkExternalUrls?: boolean; // NEW: Validate external URLs
  noCache?: boolean; // NEW: Disable cache for external URL validation
}

export async function validateCommand(
  pathArg: string | undefined,
  options: ValidateOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Load resources with config support (includes GitTracker initialization)
    const { registry, gitTracker } = await loadResourcesWithConfig(pathArg, logger);

    // Load frontmatter schema if provided
    let frontmatterSchemaObj: object | undefined;
    if (options.frontmatterSchema) {
      logger.debug(`Loading frontmatter schema from: ${options.frontmatterSchema}`);
      frontmatterSchemaObj = await loadSchema(options.frontmatterSchema);
    }

    // Validate all resources
    const validationMode = options.validationMode ?? 'strict';
    const validationResult = await registry.validate({
      ...(frontmatterSchemaObj ? { frontmatterSchema: frontmatterSchemaObj } : {}),
      validationMode,
      checkExternalUrls: options.checkExternalUrls ?? false,
      noCache: options.noCache ?? false,
    });

    // Filter by collection if specified
    let filteredIssues = validationResult.issues;
    let filteredStats: RegistryStats;

    if (options.collection) {
      // Get resources in the specified collection
      const { collection } = options;
      const collectionResources = registry
        .getAllResources()
        .filter(r => (collection ? r.collections?.includes(collection) ?? false : false));
      const collectionPaths = new Set(collectionResources.map(r => r.filePath));

      // Only show issues from files in this collection
      filteredIssues = validationResult.issues.filter(issue =>
        collectionPaths.has(issue.resourcePath)
      );

      // Calculate filtered stats
      const totalLinks = collectionResources.reduce((sum, r) => sum + r.links.length, 0);
      filteredStats = {
        totalResources: collectionResources.length,
        totalLinks,
        linksByType: validationResult.linksByType, // Keep all link types
      };
    } else {
      filteredStats = registry.getStats();
    }

    const duration = Date.now() - startTime;

    // Build validation metadata
    const validationMetadata: Pick<ValidationOutputData, 'validationMode' | 'frontmatterSchema'> = {
      validationMode,
      ...(options.frontmatterSchema ? { frontmatterSchema: options.frontmatterSchema } : {}),
    };

    // Get collection stats (filtered if collection specified)
    let collectionStats = registry.getCollectionStats();
    if (options.collection && collectionStats) {
      // Only show the specified collection
      const collectionStat = collectionStats.collections[options.collection];
      if (collectionStat) {
        collectionStats = {
          totalCollections: 1,
          resourcesInCollections: collectionStat.resourceCount,
          collections: { [options.collection]: collectionStat },
        };
      }
    }

    // Filter out external_url issues (informational only, not actual errors)
    const actualErrors = filteredIssues.filter(
      issue => issue.type !== 'external_url'
    );
    const hasErrors = actualErrors.length > 0;

    // Determine output format (default: yaml)
    const outputFormat = options.format ?? 'yaml';

    if (hasErrors) {
      // Failure path
      const errorData = actualErrors.map(issue => ({
        file: issue.resourcePath,
        line: issue.line ?? 1,
        column: 1,
        type: issue.type,
        message: issue.message,
      }));

      const context: ValidationContext = {
        stats: filteredStats,
        errorCount: validationResult.errorCount,
        validationMetadata,
        collectionStats,
        duration,
      };

      outputFailure(errorData, outputFormat, context, registry);
      logGitTrackerStats(gitTracker, logger);
      process.exit(1);
    } else {
      // Success path
      const context = { stats: filteredStats, validationMetadata, collectionStats, duration };
      outputSuccess(outputFormat, context);
      logGitTrackerStats(gitTracker, logger);
      process.exit(0);
    }
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Validation');
  }
}
