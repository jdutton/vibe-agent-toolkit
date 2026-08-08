/**
 * Pipeline oracles — intermediate correctness instruments for the resource
 * pipeline. See `./README.md`.
 *
 * Deliberately NOT re-exported from `packages/cli/src/index.ts`: these are
 * internal instruments, not public API, and nothing outside this repository's
 * own tests should bind to their shapes.
 */

export { captureEnumerationSnapshot, type CaptureOptions } from './enumeration-snapshot.js';
export { LANES, laneById, type LaneDefinition } from './lanes.js';
export { captureParseFactSnapshot, diffParseFactRows } from './parse-fact-snapshot.js';
export { collectPathFacts, relativize, type PathFactContext } from './path-facts.js';
export {
  renderEnumerationSnapshot,
  renderEnumerationSnapshotUnordered,
  renderParseFactSnapshot,
  renderSymlinkDivergence,
} from './serialize.js';
export {
  captureSymlinkDivergence,
  type DivergenceClass,
  type DivergenceRow,
  type SymlinkDivergenceReport,
} from './symlink-divergence.js';
export {
  BUNDLING_SKILL_FILES,
  DANGLING_SYMLINK,
  DIRECTORY_LOOP_SYMLINK,
  ESCAPE_TARGET_BASENAME,
  ESCAPING_SYMLINK,
  TRAP_CORPUS_FILES,
  TRAP_CORPUS_SYMLINKS,
  materializeTrapCorpus,
  type CorpusFiles,
  type CorpusSymlink,
  type MaterializeOptions,
  type MaterializedCorpus,
} from './trap-corpus.js';
export type {
  CollisionRow,
  ConditionFact,
  EnumerationRoute,
  EnumerationRow,
  EnumerationSnapshot,
  HeadingFact,
  KeyDisagreement,
  LaneId,
  LinkFact,
  ParseFactRow,
  ParseFactSnapshot,
} from './types.js';
