/**
 * @vibe-agent-toolkit/cli
 *
 * Command-line interface for vibe-agent-toolkit.
 * Provides resource scanning, validation, and future agent commands.
 */

// Public API exports (for programmatic use)
export { version, getVersionString, type VersionContext } from './version.js';

// Utilities (for programmatic use)
export { createLogger, type Logger, type LoggerOptions } from './utils/logger.js';
export { findProjectRoot } from './utils/project-root.js';
export { writeYamlOutput, flushStdout, writeTestFormatError } from './utils/output.js';
export { loadConfig } from './utils/config-loader.js';
export {
  ProjectConfigSchema,
  ResourcesConfigSchema,
  ResourceCollectionSchema,
  AgentsConfigSchema,
  RAGConfigSchema,
  DEFAULT_CONFIG,
} from './schemas/config.js';
export type {
  ProjectConfig,
  ResourcesConfig,
  ResourceCollection,
  AgentsConfig,
  RAGConfig,
  RAGStore,
} from './schemas/config.js';
