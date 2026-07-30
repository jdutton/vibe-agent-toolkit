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
// `makeStdioBlocking` is part of the public surface on purpose: a consumer that
// embeds this CLI's output helpers inherits the same `process.exit` truncation
// these were written to fix, and cannot opt into the fix without it.
export {
  writeYamlOutput,
  writeTestFormatError,
  writeStdoutSync,
  makeStdioBlocking,
  describeStdioBlocking,
  type StdioBlockingResult,
} from './utils/output.js';
export { loadConfig } from './utils/config-loader.js';
export {
  ProjectConfigSchema,
  type ProjectConfig,
  type ResourcesConfig,
  type CollectionConfig as ResourceCollection,
} from '@vibe-agent-toolkit/resources';
