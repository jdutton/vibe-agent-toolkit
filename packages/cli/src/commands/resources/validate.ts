/**
 * Resources validate command - strict validation with error reporting
 */

import { ResourceRegistry } from '@vibe-agent-toolkit/resources';

import { loadConfig } from '../../utils/config-loader.js';
import { createLogger } from '../../utils/logger.js';
import { flushStdout, writeTestFormatError, writeYamlOutput } from '../../utils/output.js';
import { findProjectRoot } from '../../utils/project-root.js';

import { handleCommandError } from './command-helpers.js';

interface ValidateOptions {
  debug?: boolean;
}

export async function validateCommand(
  pathArg: string | undefined,
  options: ValidateOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Determine validation path
    const validatePath = pathArg ?? process.cwd();
    logger.debug(`Validating path: ${validatePath}`);

    // Find project root and load config
    const projectRoot = findProjectRoot(validatePath);
    const config = projectRoot ? loadConfig(projectRoot) : undefined;

    if (config && options.debug) {
      logger.debug(`Loaded config from ${projectRoot}`);
    }

    // Create registry and crawl
    const registry = new ResourceRegistry();
    const crawlOptions: {
      baseDir: string;
      include?: string[];
      exclude?: string[];
    } = {
      baseDir: validatePath,
    };

    if (config?.resources?.include !== undefined) {
      crawlOptions.include = config.resources.include;
    }

    if (config?.resources?.exclude !== undefined) {
      crawlOptions.exclude = config.resources.exclude;
    }

    await registry.crawl(crawlOptions);

    // Validate all resources
    const validationResult = await registry.validate();
    const stats = registry.getStats();
    const duration = Date.now() - startTime;

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
      writeYamlOutput({
        status: 'success',
        filesScanned: stats.totalResources,
        linksChecked: stats.totalLinks,
        duration: `${duration}ms`,
      });

      process.exit(0);
    }
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Validation');
  }
}
