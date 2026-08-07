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
export { captureParseFactSnapshot, extractFrontmatterSource } from './parse-fact-snapshot.js';
export { collectPathFacts, relativize, type PathFactContext } from './path-facts.js';
export {
  renderEnumerationSnapshot,
  renderEnumerationSnapshotUnordered,
  renderParseFactSnapshot,
} from './serialize.js';
export {
  BUNDLING_SKILL_FILES,
  DANGLING_SYMLINK,
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
  LaneId,
  LinkFact,
  ParseFactRow,
  ParseFactSnapshot,
} from './types.js';
