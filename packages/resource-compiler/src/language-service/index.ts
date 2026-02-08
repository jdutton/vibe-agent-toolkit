/**
 * TypeScript Language Service Plugin for markdown imports
 * Provides IDE support for markdown resources compiled by vat-compile-resources
 *
 * @example
 * Add to tsconfig.json:
 * ```json
 * {
 *   "compilerOptions": {
 *     "plugins": [
 *       {
 *         "name": "@vibe-agent-toolkit/resource-compiler/language-service"
 *       }
 *     ]
 *   }
 * }
 * ```
 */

// Export the plugin initialization function
export { default } from './plugin.js';

// Export utility functions for testing
export {
  findNodeAtPosition,
  getMarkdownPathFromImport,
  getMarkdownPathFromExpression,
  resolveMarkdownPath,
  loadMarkdownResource,
  findHeadingPosition,
} from './utils.js';

// Export cache functions for testing
export { getMarkdownResource, clearCache, invalidateFile, getCacheStats } from './markdown-cache.js';

// Export enhancement functions for testing
export { enhanceCompletions, getCompletionEntryDetails } from './completions.js';
export { enhanceDefinitions } from './definitions.js';
export { enhanceDiagnostics } from './diagnostics.js';
export { enhanceHover } from './hover.js';
