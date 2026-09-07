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
export type { DecodedText, EncodingSource, TextEncoding, TextProvenance } from './text-content.js';

// Two materialized columns, each a fill+judge pair and nothing else. In both the
// row IS the answer, so the row lookup — `pathSpellingFrom`, `realpathFrom` — is
// itself the judge and is exported. See `index.ts` for the full reasoning.
export {
  copyDirectory,
  DirectorySpellingIndex,
  fillPathSpellings,
  fillRealpaths,
  FsLookupCache,
  isFilesystemAccessError,
  pathSpellingFrom,
  realpathFrom,
  spellingWalkRoot,
} from './fs-utils.js';
export type {
  ComponentMatch,
  FilenameMatch,
  PathProbe,
  PathProbeStats,
  PathSpelling,
  PathSpellingRequest,
  PathSpellingTable,
  RealpathTable,
} from './fs-utils.js';
