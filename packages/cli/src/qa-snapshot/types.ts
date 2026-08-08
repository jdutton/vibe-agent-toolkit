/**
 * The QA snapshot instrument — shared shapes.
 *
 * ## What this is, and what it deliberately is not
 *
 * `packages/cli/src/pipeline-oracles/` holds the *oracles*: population-aware
 * captures that name a lane and a row. `~/Workspaces/vat-perf-baseline/` held
 * the other half: whole-command stdout, broad enough to catch anything and
 * unable to localize any of it. Neither is worth much alone — "something
 * changed" plus "here is where" is the pair — and until now the first was
 * reachable only by writing a test and the second only on one macOS machine.
 *
 * This module makes both invocable against any directory, and is therefore a
 * **QA instrument, not a gate**. A gate must be cheap, portable and
 * green-by-default; this is none of those and never will be. It must only be
 * invocable, and its output must be *small* — see below.
 *
 * ⛔ **Not public API.** The lanes bind to internal builders
 * (`createProjectRegistry`, `crawlAndResolveRegistry`, …). Those move whenever
 * the pipeline moves, which is the entire point of the instrument, so nothing
 * outside this repository may bind to these shapes or to the on-disk layout.
 *
 * ## The output is the part that needed designing, not the capture
 *
 * The scarce resource is agent context, not disk. `vat audit` alone emits
 * 1.81 MB of YAML carrying 1,755 findings; handing that to a reader to decide
 * "did anything move" is both expensive and exactly the judgement a model is
 * worst at across a large blob. So a comparison defaults to a **summary** —
 * which artifacts changed, by how many lines, and the headline facts that moved
 * — and prints diff text only when asked for one artifact by name.
 */

import type { EnumerationRoute, LaneId } from '../pipeline-oracles/types.js';

/**
 * On-disk layout version for a snapshot directory.
 *
 * Bumped when the artifact set or the manifest shape changes. A comparison
 * across two different format versions is refused rather than attempted: the
 * failure mode of guessing is a confidently wrong "nothing changed".
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

/** Manifest filename inside a snapshot directory. */
export const MANIFEST_FILENAME = 'manifest.json';

/** Subdirectory holding the oracle artifacts. */
export const ORACLE_DIR = 'oracle';

/** Subdirectory holding the whole-command artifacts. */
export const COMMAND_DIR = 'command';

/**
 * The whole-command half: which verbs are run, and how they are invoked.
 *
 * These three are the verbs the frozen baseline recorded, for the reason it
 * recorded them — they are the ones that enumerate and parse a corpus. Note the
 * asymmetry, which is a finding rather than an oversight: `resources scan` and
 * `audit` have **no output-format flag at all** and emit YAML unconditionally,
 * so only `resources validate` can be asked for JSON.
 */
export interface CommandSpec {
  /** Stable artifact name. Appears in the summary table and in `--detail`. */
  name: string;
  /**
   * Arguments after the binary, with `{corpus}` substituted at capture time.
   * Written as a template so the manifest can record what was actually run.
   */
  args: readonly string[];
}

/** The three corpus-enumerating verbs, in a stable order. */
export const COMMAND_SPECS: readonly CommandSpec[] = Object.freeze([
  { name: 'resources-scan', args: Object.freeze(['resources', 'scan', '{corpus}']) },
  {
    name: 'resources-validate',
    args: Object.freeze(['resources', 'validate', '{corpus}', '--format', 'json']),
  },
  { name: 'audit', args: Object.freeze(['audit', '{corpus}']) },
]);

/** What one lane contributed to a snapshot. */
export interface LaneManifestEntry {
  laneId: LaneId;
  /** Artifact path, relative to the snapshot directory, forward-slashed. */
  artifact: string;
  /**
   * Which of `crawlDirectory`'s two mutually exclusive routes answered the
   * crawl. Recorded because it decides whether ordering is portable at all.
   */
  route: EnumerationRoute;
  /**
   * `true` only on the `git ls-files` route.
   *
   * The other route is a recursive `readdirSync` walk, and readdir order is a
   * property of the filesystem — ext4's hashed directories, APFS and NTFS all
   * differ. An ordered artifact captured on one host does not hold on another
   * for reasons that are not defects, so walk-route artifacts are rendered
   * sorted and a cross-host comparison of ordering is refused, not attempted.
   */
  orderPortable: boolean;
  enumeratedCount: number;
  admittedCount: number;
  collisionCount: number;
  restatementDriftCount: number;
  /** The lane's production builder threw. A lane that dies is recorded, not fatal. */
  buildError: string | null;
}

/** What one whole-command run contributed to a snapshot. */
export interface CommandManifestEntry {
  name: string;
  /** The fully-substituted argv, minus the node binary and the CLI entry. */
  args: string[];
  /** `null` when the child was killed by a signal rather than exiting. */
  exitCode: number | null;
  signal: string | null;
  /**
   * Wall time in milliseconds. **Never compared** — it is the one field three
   * runs of every verb were observed to disagree on, and comparing it would
   * make every snapshot differ from every other.
   */
  wallMs: number;
  stdoutArtifact: string;
  stderrArtifact: string;
  /** Byte lengths after normalization, so a summary can be produced without re-reading. */
  stdoutBytes: number;
  stderrBytes: number;
}

/**
 * Everything about a capture except the artifact text itself.
 *
 * Fields here are provenance, not content: a comparison reads them to decide
 * what it is *allowed* to conclude, and says so out loud when the answer is
 * "less than you wanted".
 */
export interface SnapshotManifest {
  formatVersion: number;
  /** `packages/cli/package.json`'s version — which VAT produced this. */
  vatVersion: string;
  /**
   * `CONTENT_KEY_SCHEMA_VERSION` at capture time.
   *
   * A bump churns 100% of the content-key column in every artifact, so a
   * comparison across two values masks that column and says it did. Without the
   * mask the diff is total and carries no information.
   */
  contentKeySchemaVersion: number;
  /** ISO-8601. Recorded for the human; **never compared**. */
  capturedAtIso: string;
  /** Absolute corpus root as given. Informational; every artifact path is relative. */
  corpusRoot: string;
  /** Short label printed into the oracle artifacts. */
  corpusLabel: string;
  /** `process.platform`. A cross-platform comparison of walk-route order is not meaningful. */
  platform: string;
  nodeVersion: string;
  /** Corpus HEAD when it is a git repository, else `null`. */
  corpusGitHead: string | null;
  /** `true` when the corpus working tree had uncommitted changes at capture time. */
  corpusGitDirty: boolean | null;
  lanes: LaneManifestEntry[];
  commands: CommandManifestEntry[];
  /** Artifact name of the parse-fact snapshot, or `null` when it was skipped. */
  parseFactArtifact: string | null;
  parseFactBlobCount: number | null;
  parseFactKeyDisagreementCount: number | null;
  /**
   * Constraints observed during this capture that a reader must know before
   * trusting a comparison — a walk-route lane, a lane whose builder threw, a
   * skipped half. Stated at capture time so they cannot be discovered later.
   */
  warnings: string[];
}

/** A snapshot directory, loaded: manifest plus every artifact's text. */
export interface LoadedSnapshot {
  /** Absolute path to the snapshot directory. */
  dir: string;
  manifest: SnapshotManifest;
  /** Artifact relative path → file contents. LF-normalized. */
  artifacts: Map<string, string>;
}

/** Whether an artifact came from an oracle or from a whole command. */
export type ArtifactKind = 'oracle' | 'command';

/** What happened to one artifact between two snapshots. */
export type ArtifactStatus = 'same' | 'changed' | 'added' | 'removed';

/** One row of the comparison summary. */
export interface ArtifactDelta {
  /** Selector for `--detail`, e.g. `enumeration.resources` or `command.audit.stdout`. */
  name: string;
  kind: ArtifactKind;
  /** Artifact path relative to the snapshot directory. */
  artifact: string;
  status: ArtifactStatus;
  addedLines: number;
  removedLines: number;
  /**
   * Header facts that moved, e.g. `enumeratedCount 265→267`.
   *
   * ⚠️ **Advisory.** These are extracted by a shallow scan of leading
   * `key: value` lines, not by parsing the document — a heuristic cannot define
   * a population. `status` and the line counts are the authoritative signal;
   * headlines exist to save a drill-down, never to replace one.
   */
  headlines: string[];
}

/** The result of comparing two snapshot directories. */
export interface CompareReport {
  beforeDir: string;
  afterDir: string;
  deltas: ArtifactDelta[];
  changedCount: number;
  /**
   * Loud notes about what this comparison could not do: format-version or
   * content-key-schema mismatch, a different corpus, a different platform, a
   * walk-route lane, a half captured on one side only.
   */
  constraints: string[];
  /** Manifest fields that differ and are worth stating, e.g. the VAT version. */
  provenanceNotes: string[];
}

/** Invariants asserted by `vat pipeline check`, one row per lane. */
export interface InvariantViolation {
  laneId: LaneId | null;
  code:
    | 'BUILD_ERROR'
    | 'RESTATEMENT_DRIFT'
    | 'KEY_DISAGREEMENT'
    | 'MISSING_PATH'
    | 'UNRESOLVED_SYMLINK';
  detail: string;
}
