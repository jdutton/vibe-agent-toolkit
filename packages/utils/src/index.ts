/**
 * @vibe-agent-toolkit/utils
 * Core shared utilities with no dependencies on other packages
 *
 * Utilities are added as needed by other packages, not speculatively.
 */

// Safe command execution (cross-platform, no shell injection)
export * from './safe-exec.js';

// Cross-platform path utilities
export * from './path-utils.js';

// Filesystem utilities
export * from './fs-utils.js';

// Directory crawling with glob patterns
export * from './file-crawler.js';

// Git ignore checking
export * from './gitignore-checker.js';

// Git utilities (using git commands directly)
export * from './git-utils.js';

// Project root discovery (workspace root -> git root -> fallback)
export * from './project-utils.js';

// Git tracking cache (for efficient git-ignore checking)
export * from './git-tracker.js';

// Test helpers for isolated test output directories
export * from './test-helpers.js';

// Zod type introspection (version-agnostic)
export * from './zod-introspection.js';

// Handlebars template rendering (cached, no HTML escaping)
export * from './template.js';
