/**
 * Capture a QA snapshot over one corpus: the oracle half, which drives
 * `packages/cli/src/pipeline-oracles/` — narrow captures that name a lane and a
 * row.
 *
 * The whole-command half that used to sit beside it — spawn the corpus-
 * enumerating verbs and keep their normalized streams — is the lab's `verdict`
 * facet now (`packages/lab/src/facets/verdict/`), with the one normalizer.
 *
 * Two properties of this module exist because of how a later comparison can
 * be misled, and neither is incidental:
 *
 * - **Order is fixed**: lanes in `LANES` order, one run each. A capture whose
 *   order varies produces artifacts that differ for reasons that are not
 *   findings.
 * - **A lane that dies is recorded, never fatal.** `buildError` rides into the
 *   manifest with a `warnings` line beside it.
 */

import { vatCacheNamespace } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { runGit } from '@vibe-agent-toolkit/utils/git';

import {
  captureEnumerationSnapshot,
  captureParseFactSnapshot,
  LANES,
  laneById,
  renderEnumerationSnapshot,
  renderEnumerationSnapshotUnordered,
  renderParseFactSnapshot,
  type LaneDefinition,
  type LaneId,
} from '../pipeline-oracles/index.js';
import { version } from '../version.js';

import {
  ORACLE_DIR,
  type LaneManifestEntry,
  type SnapshotManifest,
} from './types.js';

/** Ceiling on each provenance `git` call, so a wedged repo cannot stall a capture. */
const GIT_TIMEOUT_MS = 10_000;

/** What a capture is pointed at, and which halves it is asked for. */
export interface CaptureRequest {
  corpusRoot: string;
  corpusLabel: string;
  /** Lane ids to capture; defaults to all five. */
  lanes?: readonly LaneId[];
  /** Capture the parse-fact oracle. It is the slowest oracle on a large corpus. */
  includeParseFacts: boolean;
}

/** A capture, ready to hand to `writeSnapshot`. */
export interface CaptureResult {
  manifest: SnapshotManifest;
  /** Artifact relative path (forward-slashed) → text. */
  artifacts: Map<string, string>;
}

/** The shape every half returns, so the top level can concatenate rather than branch. */
interface SnapshotHalf {
  artifacts: Map<string, string>;
  warnings: string[];
}

/** The oracle half's enumeration lanes. */
interface LaneHalf extends SnapshotHalf {
  entries: LaneManifestEntry[];
  /** Union of every absolute path the captured lanes enumerated, de-duplicated. */
  enumeratedPaths: string[];
}

/** The parse-fact oracle. */
interface ParseFactHalf extends SnapshotHalf {
  artifact: string | null;
  blobCount: number | null;
  keyDisagreementCount: number | null;
}

/**
 * Capture a QA snapshot over a corpus.
 *
 * @param request - Corpus, label, which lanes, whether to capture parse facts
 * @returns The manifest and every artifact it names
 * @throws {Error} When `request.lanes` names an id that is not one of the five
 */
export async function captureSnapshot(request: CaptureRequest): Promise<CaptureResult> {
  const corpusRoot = safePath.resolve(request.corpusRoot);

  const lanes = await captureLanes(request, corpusRoot);
  const parseFacts = await captureParseFactHalf(request, corpusRoot, lanes.enumeratedPaths);

  const manifest: SnapshotManifest = {
    vatVersion: version,
    cacheNamespace: vatCacheNamespace(),
    capturedAtIso: new Date().toISOString(),
    corpusRoot,
    corpusLabel: request.corpusLabel,
    platform: process.platform,
    nodeVersion: process.version,
    ...gitProvenance(corpusRoot),
    lanes: lanes.entries,
    parseFactArtifact: parseFacts.artifact,
    parseFactBlobCount: parseFacts.blobCount,
    parseFactKeyDisagreementCount: parseFacts.keyDisagreementCount,
    warnings: [
      ...untrackedFileWarnings(corpusRoot),
      ...lanes.warnings,
      ...parseFacts.warnings,
    ],
  };

  return {
    manifest,
    artifacts: new Map([...lanes.artifacts, ...parseFacts.artifacts]),
  };
}

/**
 * The lanes to capture, validated and put back into `LANES` order.
 *
 * Ordering is not cosmetic: a capture that visits lanes in the caller's order
 * produces a manifest whose `lanes` array differs run to run for a reason that
 * is not a finding.
 *
 * @param laneIds - Requested lane ids, in any order
 * @returns The matching lane definitions, in `LANES` order
 * @throws {Error} When an id is not one of the five (via `laneById`)
 */
function orderedLanes(laneIds: readonly LaneId[]): LaneDefinition[] {
  const requested = new Set(laneIds.map((id) => laneById(id).id));
  return LANES.filter((lane) => requested.has(lane.id));
}

/**
 * Run every requested lane's enumeration oracle.
 *
 * The ordered/unordered rendering branch is load-bearing. `readdirSync` order is
 * a property of the filesystem — ext4's hashed directories, APFS and NTFS all
 * differ — so an ordered artifact taken on the walk route would diff spuriously
 * across hosts. The route decides the rendering, `orderPortable` records the
 * decision, and a `warnings` line names every walk-route lane so a reader cannot
 * discover the constraint only after trusting a comparison.
 *
 * @param request - The capture request (lanes and corpus label)
 * @param corpusRoot - Absolute corpus root
 * @returns Lane manifest entries, artifacts, warnings, and the enumerated union
 */
async function captureLanes(request: CaptureRequest, corpusRoot: string): Promise<LaneHalf> {
  const artifacts = new Map<string, string>();
  const warnings: string[] = [];
  const entries: LaneManifestEntry[] = [];
  const enumeratedPaths = new Set<string>();

  for (const lane of orderedLanes(request.lanes ?? ALL_LANE_IDS)) {
    const snapshot = await captureEnumerationSnapshot(lane, {
      corpusRoot,
      corpus: request.corpusLabel,
    });
    const orderPortable = snapshot.route === 'git-ls-files';
    const artifact = `${ORACLE_DIR}/enumeration.${lane.id}.txt`;

    artifacts.set(
      artifact,
      orderPortable
        ? renderEnumerationSnapshot(snapshot)
        : renderEnumerationSnapshotUnordered(snapshot),
    );

    // Rows carry corpus-relative paths; the parse-fact oracle wants absolute
    // ones. `relativize` is `path.relative`, so resolving against the same root
    // reconstructs exactly what the crawl handed over.
    for (const row of snapshot.enumerated) {
      enumeratedPaths.add(safePath.resolve(corpusRoot, row.path));
    }

    warnings.push(...laneWarnings(lane.id, orderPortable, snapshot.buildError));
    entries.push({
      laneId: lane.id,
      artifact,
      route: snapshot.route,
      orderPortable,
      enumeratedCount: snapshot.enumerated.length,
      admittedCount: snapshot.admitted.length,
      collisionCount: snapshot.collisions.length,
      restatementDriftCount: snapshot.restatementDrift.length,
      buildError: snapshot.buildError ?? null,
    });
  }

  return { entries, artifacts, warnings, enumeratedPaths: [...enumeratedPaths] };
}

/**
 * Constraints one lane's capture puts on any later comparison.
 *
 * @param laneId - The lane
 * @param orderPortable - False when the filesystem walk answered the crawl
 * @param buildError - The lane's production builder's error, when it threw
 * @returns Zero, one or two warning lines
 */
function laneWarnings(
  laneId: LaneId,
  orderPortable: boolean,
  buildError: string | undefined,
): string[] {
  const warnings: string[] = [];
  if (!orderPortable) {
    warnings.push(
      `lane '${laneId}' was answered by the filesystem walk route, not by 'git ls-files'. Its artifact is sorted by path and its ORDERING is not comparable across hosts — only its set and per-path attributes are.`,
    );
  }
  if (buildError !== undefined) {
    warnings.push(
      `lane '${laneId}' could not build a registry over this corpus: ${buildError}. Its admitted/collision counts are 0 because the builder threw, not because the corpus is empty.`,
    );
  }
  return warnings;
}

/**
 * Capture the parse-fact oracle over the union of the lanes' enumerations.
 *
 * @param request - The capture request (label and whether this half is wanted)
 * @param corpusRoot - Absolute corpus root
 * @param absolutePaths - De-duplicated absolute paths to parse
 * @returns The artifact plus the two headline counts, or the skipped-half warning
 */
async function captureParseFactHalf(
  request: CaptureRequest,
  corpusRoot: string,
  absolutePaths: readonly string[],
): Promise<ParseFactHalf> {
  if (!request.includeParseFacts) {
    return {
      artifacts: new Map(),
      warnings: [
        'parse-fact oracle SKIPPED (includeParseFacts: false). The parse half of this snapshot is absent, which is not the same as unchanged — a comparison against a snapshot that has it can say nothing about parsing.',
      ],
      artifact: null,
      blobCount: null,
      keyDisagreementCount: null,
    };
  }

  const snapshot = await captureParseFactSnapshot(absolutePaths, {
    corpusRoot,
    corpus: request.corpusLabel,
  });
  const artifact = `${ORACLE_DIR}/parse-facts.txt`;

  return {
    artifacts: new Map([[artifact, renderParseFactSnapshot(snapshot)]]),
    warnings: [],
    artifact,
    blobCount: snapshot.rows.length,
    keyDisagreementCount: snapshot.keyDisagreements.length,
  };
}

/**
 * Corpus HEAD and dirtiness, or `null` when the corpus is not a repository.
 *
 * A git failure of any kind — no repo, no binary, a wedged index — degrades to
 * `null`. Provenance is context for a reader; it may never abort a capture.
 *
 * @param corpusRoot - Absolute corpus root
 * @returns The two manifest provenance fields
 */
function gitProvenance(corpusRoot: string): {
  corpusGitHead: string | null;
  corpusGitDirty: boolean | null;
} {
  const head = gitOutput(corpusRoot, ['rev-parse', 'HEAD'], true);
  if (head === null) {
    return { corpusGitHead: null, corpusGitDirty: null };
  }
  const status = gitOutput(corpusRoot, ['status', '--porcelain'], true);
  return { corpusGitHead: head, corpusGitDirty: status === null ? null : status.length > 0 };
}

/**
 * Warn when the corpus holds untracked files that no lane can see.
 *
 * ## Why this exists — it was a real false negative, not a hypothetical
 *
 * Four of the five lanes crawl through `git ls-files`, which returns **tracked
 * files only**. So inside a repository an untracked document is invisible to
 * the whole instrument. The first red-team run of this tool added an untracked
 * `.html` file to VAT's own tree, re-captured, and got back *"All 12 artifacts
 * identical"* — a confident green over a corpus that had genuinely changed.
 *
 * That is the worst answer this instrument can give, and it is most likely
 * exactly when it is most trusted: the intended workflow is "snapshot, refactor,
 * snapshot again", and files created during a refactor are untracked until
 * someone commits them.
 *
 * The fix is a warning rather than a behaviour change. Making the crawl see
 * untracked files would mean the instrument no longer measures what the product
 * measures, which would be a worse defect than the one it cures. `inventory` is
 * the one lane that does ask for untracked files, so a corpus in this state
 * makes the lanes legitimately disagree — that disagreement is a finding, and
 * silently smoothing it away is what this whole instrument exists to prevent.
 *
 * @param corpusRoot - Absolute corpus root
 * @returns Zero or one warning line
 */
function untrackedFileWarnings(corpusRoot: string): string[] {
  // `-z`: without it git QUOTES any name holding a backslash, a quote or a
  // non-ASCII byte (`"caf\303\251.md"`), so the warning named files that do
  // not exist. Untrimmed, because a leading space is a filename character.
  const untracked = gitOutput(corpusRoot, ['ls-files', '-z', '--others', '--exclude-standard'], false);
  if (untracked === null) {
    return [];
  }
  const paths = untracked.split('\0').filter((entry) => entry.length > 0);
  if (paths.length === 0) {
    return [];
  }
  const shown = paths.slice(0, UNTRACKED_SAMPLE_SIZE).join(', ');
  const more = paths.length > UNTRACKED_SAMPLE_SIZE ? `, +${String(paths.length - UNTRACKED_SAMPLE_SIZE)} more` : '';
  return [
    `${String(paths.length)} UNTRACKED file(s) in the corpus are invisible to every lane that crawls via ` +
      `\`git ls-files\` — they are not enumerated, not parsed, and CANNOT move a comparison. ` +
      `A green result says nothing about them. Commit or stash them to bring them into scope. (${shown}${more})`,
  ];
}

/** How many untracked paths to name before summarising the rest as a count. */
const UNTRACKED_SAMPLE_SIZE = 5;

/**
 * Run one `git` invocation in the corpus, swallowing every failure.
 *
 * `cwd` is the corpus — a caller-supplied path — so the inherited `GIT_*`
 * redirection is scrubbed. Without it, a capture taken from inside a worktree
 * git hook records the *committing* repository's provenance under the corpus's
 * name, at exit 0, which the `success` check below cannot distinguish from a
 * correct answer.
 *
 * @param cwd - Directory to run in
 * @param args - Arguments after `git`
 * @param trim - Trim stdout. False for a NUL-delimited listing, where a leading
 *   space is part of the first filename
 * @returns Stdout, or null when the command did not succeed
 */
function gitOutput(cwd: string, args: string[], trim: boolean): string | null {
  const result = runGit(args, { cwd, timeout: GIT_TIMEOUT_MS, trim });
  return result.ok ? result.stdout : null;
}

/** Every lane id, in `LANES` order — the default population. */
const ALL_LANE_IDS: readonly LaneId[] = LANES.map((lane) => lane.id);
