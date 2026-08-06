/**
 * @vibe-agent-toolkit/utils/path
 *
 * Pure path-string helpers. This entry point reaches **no** Node builtin
 * except `node:path`, so it is the cheapest possible import for the
 * cross-platform helpers most consumers actually want.
 *
 * If you need `normalizedTmpdir`, `mkdirSyncReal`, or `normalizePath`, those
 * touch the filesystem — import them from `@vibe-agent-toolkit/utils/fs`.
 */

export {
  safePath,
  toForwardSlash,
  isAbsolutePath,
  isAbsoluteAnyPlatform,
  hasParentTraversalSegment,
  toAbsolutePath,
  getRelativePath,
  issueLocation,
} from './path-core.js';
