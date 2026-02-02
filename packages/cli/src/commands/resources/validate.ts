/**
 * Resources validate command - strict validation with error reporting
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { CollectionStats, RegistryStats } from '@vibe-agent-toolkit/resources';
import type { GitTracker } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';

import { createLogger, type Logger } from '../../utils/logger.js';
import { writeTestFormatError } from '../../utils/output.js';
import { loadResourcesWithConfig } from '../../utils/resource-loader.js';

import { handleCommandError } from './command-helpers.js';

/**
 * Load JSON Schema from file (supports .json and .yaml).
 *
 * @param schemaPath - Path to schema file
 * @returns Parsed schema object
 */
async function loadSchema(schemaPath: string): Promise<object> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- schemaPath is user-provided CLI argument
  const content = await readFile(schemaPath, 'utf-8');
  const ext = path.extname(schemaPath).toLowerCase();

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
  linksChecked?: number;
  errorsFound?: number;
  warningsFound?: number;
  validationMode: 'strict' | 'permissive';
  frontmatterSchema?: string;
  collections?: unknown;
  errors?: FileErrors[];
  duration: string;
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
  warningCount: number;
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
  context: ValidationContext
): void {
  if (outputFormat === 'text') {
    // Text format: test-format errors to stderr
    for (const error of errorData) {
      writeTestFormatError(error.file, error.line, error.column, error.message);
    }
  } else {
    // Structured format (yaml/json): group errors by file
    const groupedErrors = groupErrorsByFile(errorData);

    const outputData: ValidationOutputData = {
      status: 'failed',
      filesScanned: context.stats.totalResources,
      errorsFound: context.errorCount,
      warningsFound: context.warningCount,
      ...context.validationMetadata,
      ...(context.collectionStats ? { collections: context.collectionStats.collections } : {}),
      errors: groupedErrors,
      duration: `${context.duration}ms`,
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
      ...context.validationMetadata,
      ...(context.collectionStats ? { collections: context.collectionStats.collections } : {}),
      duration: `${context.duration}ms`,
    };

    writeStructuredOutput(outputData, outputFormat);
  }
}

interface ValidateOptions {
  debug?: boolean;
  frontmatterSchema?: string; // Path to JSON Schema file
  validationMode?: 'strict' | 'permissive'; // Validation mode for schemas
  format?: OutputFormat; // Output format
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
    const validationResult = await registry.validate(
      ...(frontmatterSchemaObj
        ? [{ frontmatterSchema: frontmatterSchemaObj, validationMode }]
        : [{ validationMode }]
      )
    );
    const stats = registry.getStats();
    const duration = Date.now() - startTime;

    // Build validation metadata
    const validationMetadata: Pick<ValidationOutputData, 'validationMode' | 'frontmatterSchema'> = {
      validationMode,
      ...(options.frontmatterSchema ? { frontmatterSchema: options.frontmatterSchema } : {}),
    };

    // Get collection stats (common for both success and failure)
    const collectionStats = registry.getCollectionStats();

    // Filter out external_url issues (informational only, not actual errors)
    const actualErrors = validationResult.issues.filter(
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
        stats,
        errorCount: validationResult.errorCount,
        warningCount: validationResult.warningCount,
        validationMetadata,
        collectionStats,
        duration,
      };

      outputFailure(errorData, outputFormat, context);
      logGitTrackerStats(gitTracker, logger);
      process.exit(1);
    } else {
      // Success path
      const context = { stats, validationMetadata, collectionStats, duration };
      outputSuccess(outputFormat, context);
      logGitTrackerStats(gitTracker, logger);
      process.exit(0);
    }
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Validation');
  }
}
