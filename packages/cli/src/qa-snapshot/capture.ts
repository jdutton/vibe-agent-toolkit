/**
 * Capture both halves of a QA snapshot over one corpus.
 *
 * The **oracle half** drives `packages/cli/src/pipeline-oracles/` — narrow
 * captures that name a lane and a row. The **whole-command half** spawns the
 * three corpus-enumerating verbs and keeps their streams — broad enough to
 * catch anything and unable to localize any of it. Neither is worth much alone;
 * the pair is.
 *
 * Three properties of this module exist because of how a later comparison can
 * be misled, and none of them are incidental:
 *
 * - **Order is fixed**: lanes in `LANES` order, commands in `COMMAND_SPECS`
 *   order, one run each. A capture whose order varies produces artifacts that
 *   differ for reasons that are not findings.
 * - **A lane that dies is recorded, never fatal.** `buildError` rides into the
 *   manifest with a `warnings` line beside it.
 * - **A command that never RAN is not a command that exited.** `spawnSync`
 *   reports ENOENT, a timeout kill and E2BIG alike as `status: null` plus an
 *   `error`; recording that as an exit code would invent a clean exit out of a
 *   process that never started.
 */

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

import { CONTENT_KEY_SCHEMA_VERSION } from '@vibe-agent-toolkit/resources';
import { safeExecResult, safePath } from '@vibe-agent-toolkit/utils';

import { resolveBinPath } from '../commands/phase-utils.js';
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

import { normalizeCommandOutput, type NormalizeContext } from './normalize.js';
import {
  COMMAND_DIR,
  COMMAND_SPECS,
  ORACLE_DIR,
  SNAPSHOT_FORMAT_VERSION,
  type CommandManifestEntry,
  type CommandSpec,
  type LaneManifestEntry,
  type SnapshotManifest,
} from './types.js';

/**
 * Cap on a captured child stream.
 *
 * Matches `phase-utils.ts`, and for the same reason: `vat audit` alone emits
 * ~1.8 MB of YAML on a large corpus, and `spawnSync`'s 1 MB default would set
 * ENOBUFS and hand back a TRUNCATED stream — a silently shortened artifact that
 * compares as a large deletion.
 */
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Ceiling on each provenance `git` call, so a wedged repo cannot stall a capture. */
const GIT_TIMEOUT_MS = 10_000;

/** What a capture is pointed at, and which halves it is asked for. */
export interface CaptureRequest {
  corpusRoot: string;
  corpusLabel: string;
  /** Lane ids to capture; defaults to all five. */
  lanes?: readonly LaneId[];
  /** Capture the whole-command half. Default true. */
  includeCommands: boolean;
  /** Capture the parse-fact oracle. Default true — it is the slowest oracle on a large corpus. */
  includeParseFacts: boolean;
  /** Millisecond ceiling per spawned command. */
  commandTimeoutMs: number;
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

/** The whole-command half. */
interface CommandHalf extends SnapshotHalf {
  entries: CommandManifestEntry[];
}

/**
 * Capture a QA snapshot over a corpus.
 *
 * @param request - Corpus, label, which halves to capture, per-command timeout
 * @returns The manifest and every artifact it names
 * @throws {Error} When `request.lanes` names an id that is not one of the five
 */
export async function captureSnapshot(request: CaptureRequest): Promise<CaptureResult> {
  const corpusRoot = safePath.resolve(request.corpusRoot);
  const binPath = resolveBinPath();
  const context = normalizeContextFor(corpusRoot, binPath);

  const lanes = await captureLanes(request, corpusRoot);
  const parseFacts = await captureParseFactHalf(request, corpusRoot, lanes.enumeratedPaths);
  const commands = captureCommandHalf(request, binPath, corpusRoot, context);

  const manifest: SnapshotManifest = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    vatVersion: version,
    contentKeySchemaVersion: CONTENT_KEY_SCHEMA_VERSION,
    capturedAtIso: new Date().toISOString(),
    corpusRoot,
    corpusLabel: request.corpusLabel,
    platform: process.platform,
    nodeVersion: process.version,
    ...gitProvenance(corpusRoot),
    lanes: lanes.entries,
    commands: commands.entries,
    parseFactArtifact: parseFacts.artifact,
    parseFactBlobCount: parseFacts.blobCount,
    parseFactKeyDisagreementCount: parseFacts.keyDisagreementCount,
    warnings: [
      ...untrackedFileWarnings(corpusRoot),
      ...lanes.warnings,
      ...parseFacts.warnings,
      ...commands.warnings,
    ],
  };

  return {
    manifest,
    artifacts: new Map([...lanes.artifacts, ...parseFacts.artifacts, ...commands.artifacts]),
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
 * Run each of {@link COMMAND_SPECS} exactly once and keep both streams.
 *
 * @param request - The capture request (whether this half is wanted, and the timeout)
 * @param binPath - Absolute path to the vat binary to spawn
 * @param corpusRoot - Absolute corpus root, substituted for `{corpus}`
 * @param context - Roots to scrub out of the captured streams
 * @returns Command manifest entries, artifacts and warnings
 */
function captureCommandHalf(
  request: CaptureRequest,
  binPath: string,
  corpusRoot: string,
  context: NormalizeContext,
): CommandHalf {
  if (!request.includeCommands) {
    return {
      artifacts: new Map(),
      warnings: [
        'whole-command half SKIPPED (includeCommands: false). Absent, not unchanged: nothing here constrains what the three corpus-enumerating verbs emit.',
      ],
      entries: [],
    };
  }

  const artifacts = new Map<string, string>();
  const warnings: string[] = [];
  const entries: CommandManifestEntry[] = [];

  for (const spec of COMMAND_SPECS) {
    const outcome = runOneCommand(spec, binPath, corpusRoot, request.commandTimeoutMs);
    const stdoutArtifact = `${COMMAND_DIR}/${spec.name}.stdout.txt`;
    const stderrArtifact = `${COMMAND_DIR}/${spec.name}.stderr.txt`;
    const stdout = normalizeCommandOutput(outcome.stdout, context);
    const stderr = normalizeCommandOutput(outcome.stderr, context);

    artifacts.set(stdoutArtifact, stdout);
    artifacts.set(stderrArtifact, stderr);
    warnings.push(...outcome.warnings);
    entries.push({
      name: spec.name,
      args: outcome.args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      wallMs: outcome.wallMs,
      stdoutArtifact,
      stderrArtifact,
      stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    });
  }

  return { artifacts, warnings, entries };
}

/** One spawned command's raw result, before normalization. */
interface CommandOutcome {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  wallMs: number;
  warnings: string[];
}

/**
 * Spawn one command once.
 *
 * @param spec - The command template
 * @param binPath - Absolute path to the vat binary
 * @param corpusRoot - Substituted for every `{corpus}` placeholder
 * @param timeoutMs - Millisecond ceiling on the child
 * @returns Both streams, the exit status, and any warnings the spawn earned
 */
function runOneCommand(
  spec: CommandSpec,
  binPath: string,
  corpusRoot: string,
  timeoutMs: number,
): CommandOutcome {
  const args = spec.args.map((arg) => arg.replaceAll('{corpus}', corpusRoot));
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: timeoutMs,
  });
  const wallMs = Date.now() - startedAt;

  return {
    args,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // A process that never ran has no exit code. Reporting `result.status` here
    // would publish `null` as though the child had chosen it.
    exitCode: result.error === undefined ? result.status : null,
    signal: result.signal ?? null,
    wallMs,
    warnings: spawnWarnings(spec.name, result.error, result.status, result.signal),
  };
}

/**
 * Say out loud when a command did not produce an exit code of its own.
 *
 * @param name - Command name, as it appears in the manifest
 * @param error - The spawn error, when `spawnSync` set one
 * @param status - The child's exit code, when it exited on its own
 * @param signal - The signal that killed it, when one did
 * @returns One warning line, or none when the child ran and exited normally
 */
function spawnWarnings(
  name: string,
  error: Error | undefined,
  status: number | null,
  signal: NodeJS.Signals | null,
): string[] {
  const killedBy = signal === null ? '' : ` (signal ${signal})`;
  if (error !== undefined) {
    return [
      `command '${name}' never produced an exit code${killedBy}: ${error.message}. exitCode is recorded as null — read it as "did not run", never as a clean exit.`,
    ];
  }
  if (status === null) {
    return [
      `command '${name}' was killed before exiting${killedBy}; its streams are whatever it had emitted by then and may be truncated.`,
    ];
  }
  return [];
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
  const head = gitOutput(corpusRoot, ['rev-parse', 'HEAD']);
  if (head === null) {
    return { corpusGitHead: null, corpusGitDirty: null };
  }
  const status = gitOutput(corpusRoot, ['status', '--porcelain']);
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
  const untracked = gitOutput(corpusRoot, ['ls-files', '--others', '--exclude-standard']);
  if (untracked === null || untracked.length === 0) {
    return [];
  }
  const paths = untracked.split('\n').filter((line) => line.length > 0);
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
 * @param cwd - Directory to run in
 * @param args - Arguments after `git`
 * @returns Trimmed stdout, or null when the command did not succeed
 */
function gitOutput(cwd: string, args: string[]): string | null {
  try {
    const result = safeExecResult('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    return result.success ? result.stdout.toString().trim() : null;
  } catch {
    // `safeExecResult` is documented not to throw. The guard is here anyway
    // because a capture must never die on provenance.
    return null;
  }
}

/**
 * The roots a captured stream is scrubbed against.
 *
 * `vatRoot` is derived from the binary that will actually be spawned rather
 * than from the cwd, for the same reason `--version` prints its binary path:
 * the cwd-derived answer is not a property of what ran.
 *
 * @param corpusRoot - Absolute corpus root
 * @param binPath - Absolute path to the vat binary (`<pkgRoot>/dist/bin.js`)
 * @returns The normalization context
 */
function normalizeContextFor(corpusRoot: string, binPath: string): NormalizeContext {
  return {
    corpusRoot,
    // bin.js → dist → the package root.
    vatRoot: safePath.resolve(binPath, '..', '..'),
    homeDir: homedir(),
  };
}

/** Every lane id, in `LANES` order — the default population. */
const ALL_LANE_IDS: readonly LaneId[] = LANES.map((lane) => lane.id);
