/**
 * @vibe-agent-toolkit/utils/fs
 *
 * Filesystem-touching path helpers. Everything here reaches `node:fs`,
 * `node:os`, or `node:url` and is therefore Node-only.
 *
 * For pure path-string manipulation that needs none of that, import
 * `@vibe-agent-toolkit/utils/path` instead — it is dramatically cheaper.
 */

export {
  normalizePath,
  normalizedTmpdir,
  mkdirSyncReal,
  resolveFromImportMeta,
  dynamicImportPath,
} from './path-utils.js';

export { copyDirectory, FsLookupCache, verifyCaseSensitiveFilename } from './fs-utils.js';
export type { PathProbe, PathProbeStats } from './fs-utils.js';
