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

// Asset reference resolution (paths + npm bare specifiers)
export * from './asset-reference.js';

// Filesystem utilities
export * from './fs-utils.js';

// Directory crawling with glob patterns
export * from './file-crawler.js';

// Git ignore checking
export * from './gitignore-checker.js';

// Git URL parsing (parse/detect git URLs, GitHub shorthand, SSH forms)
export * from './git-url.js';

// Git utilities (using git commands directly)
export * from './git-utils.js';

// Project root discovery (canonical: config → git → null).
// CLI-boundary use only — see docs/concepts/roots-and-config.md.
export * from './project-utils.js';

// Git tracking cache (for efficient git-ignore checking)
export * from './git-tracker.js';

// Test helpers for isolated test output directories
export * from './test-helpers.js';

// Zod type introspection (version-agnostic)
export * from './zod-introspection.js';

// Handlebars template rendering (cached, no HTML escaping)
export * from './template.js';

// Skill target resolution (cross-platform flat skill install paths)
export * from './skill-targets.js';

// linkAuth pure engine — public API only (issue #113).
// Internal helpers (rewrite, build-headers, etc.) stay module-private.
export {
  type LinkAuthConfig,
  type Provider,
  type ProviderAuth,
  type ProviderCheck,
  resolveAuthenticatedUrl,
  type ResolveOutcome,
} from './link-auth/resolve.js';
export type { ProviderMatch } from './link-auth/select-provider.js';
export type { RewriteRule } from './link-auth/rewrite.js';
export type { TokenSource } from './link-auth/resolve-token.js';
export { expandMacro, UnknownMacroError } from './link-auth/expand-macro.js';

// Skill testing utilities (environment management for headless agent runs)
export * from './skill-test/index.js';
