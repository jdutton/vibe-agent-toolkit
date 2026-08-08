/**
 * The QA snapshot instrument — the surface a command may bind to.
 *
 * ## What this barrel is for
 *
 * `capture` → `store` → `diff` → `render` is a pipeline with one entry point per
 * stage, and a command that wires them together should import the stages, not
 * the modules' internals. Everything re-exported here is something
 * `commands/pipeline/` calls; everything not re-exported here (`normalize.ts`'s
 * `NormalizeContext`, `diff.ts`'s masking helpers) is an implementation detail
 * that a caller has no business reaching for.
 *
 * ## Reachable from a command, and still not public API
 *
 * This differs from its sibling `../pipeline-oracles/index.js` in exactly one
 * way: that barrel is reachable only from this repository's own tests, whereas
 * this one **is** reachable from a shipped verb — `vat pipeline`. That makes the
 * instrument invocable; it does not make it an API.
 *
 * ⛔ The lanes bind to internal builders (`createProjectRegistry`,
 * `crawlAndResolveRegistry`, …). Those move whenever the pipeline moves, which
 * is the entire point of the instrument, so nothing outside this repository may
 * bind to these shapes or to the on-disk snapshot layout. Both change without a
 * deprecation cycle and without a CHANGELOG entry.
 *
 * Consequently this module is **deliberately NOT re-exported from
 * `packages/cli/src/index.ts`, and must not be.** Re-exporting it would publish
 * these shapes on the package's public surface and turn every pipeline refactor
 * into a breaking change for a consumer we never meant to have.
 */

export { captureSnapshot, type CaptureRequest, type CaptureResult } from './capture.js';
export {
  compareSnapshots,
  countLineDelta,
  extractHeaderFacts,
  headlineChanges,
  renderUnifiedDiff,
} from './diff.js';
export { renderCompareSummary, renderDetailHeader, renderSelectorHelp } from './render.js';
export { readSnapshot, snapshotPaths, writeSnapshot, type SnapshotPaths } from './store.js';
export {
  COMMAND_DIR,
  COMMAND_SPECS,
  MANIFEST_FILENAME,
  ORACLE_DIR,
  SNAPSHOT_FORMAT_VERSION,
  type ArtifactDelta,
  type ArtifactKind,
  type ArtifactStatus,
  type CommandManifestEntry,
  type CommandSpec,
  type CompareReport,
  type InvariantViolation,
  type LaneManifestEntry,
  type LoadedSnapshot,
  type SnapshotManifest,
} from './types.js';
