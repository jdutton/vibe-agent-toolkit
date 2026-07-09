/* c8 ignore file — pure re-export barrel, no logic to cover */
/**
 * @vibe-agent-toolkit/utils/fs
 *
 * Narrow subpath export for filesystem and path primitives. Import this entry
 * point when you need cross-platform path/fs helpers without pulling in the
 * linkAuth, git, skill-testing, or macro-expansion machinery from the full
 * `"."` barrel.
 */

export {
  normalizePath,
  normalizedTmpdir,
  mkdirSyncReal,
  isAbsolutePath,
  isAbsoluteAnyPlatform,
  hasParentTraversalSegment,
  toAbsolutePath,
  getRelativePath,
  toForwardSlash,
  safePath,
  resolveFromImportMeta,
  dynamicImportPath,
} from './path-utils.js';

export { copyDirectory, verifyCaseSensitiveFilename } from './fs-utils.js';
