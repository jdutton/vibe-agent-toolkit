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
// A consumer that embeds these output helpers inherits the same `process.exit`
// truncation they were written to fix, and needs `makeStdioBlocking` to opt into
// the fix — it now lives in `@vibe-agent-toolkit/utils` (also reachable via the
// narrow `@vibe-agent-toolkit/utils/process` subpath), because the CLI sits at
// the top of the dependency chain and VAT's second published bin could not reach
// it here.
export {
  writeYamlOutput,
  writeTestFormatError,
  writeStdoutSync,
} from './utils/output.js';
export { loadConfig } from './utils/config-loader.js';
export {
  ProjectConfigSchema,
  type ProjectConfig,
  type ResourcesConfig,
  type CollectionConfig as ResourceCollection,
} from '@vibe-agent-toolkit/resources';
