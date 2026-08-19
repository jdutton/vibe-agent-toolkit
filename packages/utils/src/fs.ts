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

// Read a file and decode it through the one content-decoding seam. The DECISION
// about what the bytes say is pure and lives on `./text`; these two are that
// plus a `readFile`, which is why they are here and not there.
export { readTextContent, readTextContentSync } from './text-file.js';
export type { DecodedText, EncodingBasis, TextEncoding } from './text-content.js';

// Two materialized columns, each a fill+judge pair and nothing else. For sibling
// names the judge is `classifyFilenameCaseFrom`, and the internal
// `classifyFilenameCase`/`siblingNamesFrom` members plus the `SiblingNames` row
// type they trade in stay module-local — a row there is not yet an answer. For
// realpaths the row IS the answer, so the row lookup `realpathFrom` is itself the
// judge and is exported. See `index.ts` for the full reasoning.
export {
  classifyFilenameCaseFrom,
  copyDirectory,
  fillRealpaths,
  fillSiblingNames,
  FsLookupCache,
  isFilesystemAccessError,
  realpathFrom,
} from './fs-utils.js';
export type {
  FilenameCaseVerdict,
  FilenameMatch,
  PathProbe,
  PathProbeStats,
  RealpathTable,
  SiblingNamesTable,
} from './fs-utils.js';
