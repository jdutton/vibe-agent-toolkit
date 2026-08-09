/**
 * The QA snapshot instrument — the surface a caller may bind to.
 *
 * ## What this barrel is for
 *
 * `capture` → `store` → `diff` → `render` is a pipeline with one entry point per
 * stage, and a caller that wires them together should import the stages, not
 * the modules' internals. Everything re-exported here is a stage boundary;
 * everything not re-exported here (`normalize.ts`'s `NormalizeContext`,
 * `diff.ts`'s masking helpers) is an implementation detail that a caller has no
 * business reaching for.
 *
 * `invariants` sits beside that chain rather than inside it. It asks whether a
 * single capture is trustworthy at all — did every builder run, does the
 * oracle's restatement still match the code it describes, are the content keys
 * sound — which is a different question from whether anything moved between two
 * captures, and the only one worth asking before you believe a comparison.
 *
 * ## Test infrastructure — reached by writing a test, not by a verb
 *
 * This is the same kind of thing as its sibling `../pipeline-oracles/index.js`:
 * neither is reachable from any `vat` verb. There used to be one — `vat pipeline`
 * — and it was deleted, because a QA instrument only this repository can
 * usefully run does not belong on a published CLI's surface or in its tarball.
 * The way in is `captureSnapshot` from a test; `test/integration/qa-snapshot.integration.test.ts`
 * drives the whole capture → store → compare → render chain and is the worked
 * example to copy.
 *
 * It stays under `src/` rather than moving to `test/` for one concrete reason:
 * no test file in this repository is typechecked, and `tsc --build` covers
 * `src/`. It is kept out of the published npm package by the `!dist/qa-snapshot`
 * negation in this package's `files` array.
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
export {
  checkInvariants,
  type CollisionNote,
  type InvariantReport,
} from './invariants.js';
export { renderCompareSummary, renderDetailHeader } from './render.js';
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
