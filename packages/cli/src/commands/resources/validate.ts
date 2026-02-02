/**
 * Resources validate command - strict validation with error reporting
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { createLogger } from '../../utils/logger.js';
import { flushStdout, writeTestFormatError, writeYamlOutput } from '../../utils/output.js';
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

interface ValidateOptions {
  debug?: boolean;
  frontmatterSchema?: string; // Path to JSON Schema file
  validationMode?: 'strict' | 'permissive'; // Validation mode for schemas
}

export async function validateCommand(
  pathArg: string | undefined,
  options: ValidateOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Load resources with config support
    const { registry } = await loadResourcesWithConfig(pathArg, logger);

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
    const validationMetadata: Record<string, unknown> = {
      validationMode,
      ...(options.frontmatterSchema ? { frontmatterSchema: options.frontmatterSchema } : {}),
    };

    // Filter out external_url issues (informational only, not actual errors)
    const actualErrors = validationResult.issues.filter(
      issue => issue.type !== 'external_url'
    );
    const hasErrors = actualErrors.length > 0;

    if (hasErrors) {
      // Failure - write YAML first, then test-format errors
      const errors = actualErrors.map(issue => ({
        file: issue.resourcePath,
        line: issue.line ?? 1,
        column: 1,
        type: issue.type,
        message: issue.message,
      }));

      writeYamlOutput({
        status: 'failed',
        filesScanned: stats.totalResources,
        errorsFound: validationResult.errorCount,
        warningsFound: validationResult.warningCount,
        ...validationMetadata,
        errors,
        duration: `${duration}ms`,
      });

      // Flush stdout before writing to stderr
      await flushStdout();

      // Write test-format errors to stderr
      for (const error of errors) {
        writeTestFormatError(error.file, error.line, error.column, error.message);
      }

      process.exit(1);
    } else {
      // Success output
      // Get collection stats if available
      const collectionStats = registry.getCollectionStats();

      // Build output object with collections if available
      const outputData = collectionStats
        ? {
            status: 'success',
            filesScanned: stats.totalResources,
            linksChecked: stats.totalLinks,
            ...validationMetadata,
            collections: collectionStats.collections,
            duration: `${duration}ms`,
          }
        : {
            status: 'success',
            filesScanned: stats.totalResources,
            linksChecked: stats.totalLinks,
            ...validationMetadata,
            duration: `${duration}ms`,
          };

      writeYamlOutput(outputData);

      process.exit(0);
    }
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Validation');
  }
}
