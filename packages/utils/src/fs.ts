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

// The case-sensitivity surface is the fill+judge pair and nothing else: the
// internal `classifyFilenameCase`/`siblingNamesFrom` members and the
// `SiblingNames` row type they trade in stay module-local. See `index.ts` for why.
export {
  classifyFilenameCaseFrom,
  copyDirectory,
  fillSiblingNames,
  FsLookupCache,
} from './fs-utils.js';
export type { PathProbe, PathProbeStats, SiblingNamesTable } from './fs-utils.js';
