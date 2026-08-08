/**
 * `vat pipeline check [dir]` — assert the pipeline's internal invariants.
 *
 * This is the cheap half of the instrument: it captures the oracle half with
 * the whole-command half switched OFF, so nothing is spawned and no built
 * binary is required. That matters because the invariants it asserts are
 * properties of the *builders*, and the moment when you most want to ask about
 * them is mid-refactor, when `dist/` is stale or absent.
 *
 * ## What is a violation, and what is only information
 *
 * A violation means an artifact this instrument produces cannot be trusted:
 *
 * - **`restatementDriftCount > 0`** — `pipeline-oracles/lanes.ts` restates each
 *   lane's crawl so the ordered, pre-deduplication path list can be observed.
 *   Drift means the restatement no longer matches the builder it claims to
 *   describe, so every artifact that lane produced is a fiction about a crawl
 *   that did not happen.
 * - **`parseFactKeyDisagreementCount > 0`** — two paths carrying the same
 *   content key parsed *differently*. A content-addressed cache over this
 *   pipeline would be unsound: it would serve one path's parse for the other.
 * - **`buildError`** — the lane's production builder threw, so its admitted and
 *   collision counts are 0 because nothing ran, not because the corpus is empty.
 *
 * Duplicate-id collisions are reported as **information, never a violation**.
 * They are real and pre-existing — failing on them would make this check red on
 * VAT's own repository from day one, and a check that is red on arrival is a
 * check nobody runs.
 */

import { basename } from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { LaneId } from '../../pipeline-oracles/index.js';
import {
  captureSnapshot,
  type CaptureRequest,
  type InvariantViolation,
  type LaneManifestEntry,
  type SnapshotManifest,
} from '../../qa-snapshot/index.js';
import { formatDuration, handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

import { DEFAULT_COMMAND_TIMEOUT_MS, resolveLaneIds } from './snapshot.js';

/** Every invariant holds. */
const EXIT_OK = 0;

/** At least one invariant is violated. */
const EXIT_VIOLATION = 1;

/** Corpus directory used when the positional argument is omitted. */
const DEFAULT_CORPUS_DIR = '.';

/** Parsed `vat pipeline check` flags. */
export interface PipelineCheckOptions {
  /** Raw `--lane` values, unvalidated. */
  lane?: string[];
  debug?: boolean;
}

/** One lane's duplicate-id collision count — reported, never failed on. */
interface CollisionNote {
  lane: LaneId;
  duplicateIdCount: number;
}

/**
 * Assert the pipeline's invariants over a corpus.
 *
 * @param dir - Corpus directory; defaults to the current working directory
 * @param options - Parsed flags
 * @returns Never returns normally — the process exits from inside
 */
export async function pipelineCheckCommand(
  dir: string | undefined,
  options: PipelineCheckOptions,
): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const corpusRoot = safePath.resolve(dir ?? DEFAULT_CORPUS_DIR);
    const lanes = resolveLaneIds(options.lane);

    const request: CaptureRequest = {
      corpusRoot,
      corpusLabel: basename(corpusRoot),
      ...(lanes === undefined ? {} : { lanes }),
      // No spawned commands: every invariant below is a property of the
      // in-process builders, and requiring a built binary would make the check
      // unusable at exactly the moment it is most wanted.
      includeCommands: false,
      // The parse-fact oracle is NOT optional here — it is the only source of
      // parseFactKeyDisagreementCount, and skipping it would report the
      // key-soundness invariant as holding when it was never asked.
      includeParseFacts: true,
      commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    };

    logger.info(
      `checking ${corpusRoot} (${String(request.lanes?.length ?? 'all')} lane(s), commands off)`,
    );
    const { manifest } = await captureSnapshot(request);
    const violations = collectViolations(manifest);

    writeYamlOutput({
      status: violations.length === 0 ? 'ok' : 'violations',
      corpus: corpusRoot,
      lanesChecked: manifest.lanes.length,
      violationCount: violations.length,
      parseFactBlobCount: manifest.parseFactBlobCount,
      duplicateIdCollisions: collisionNotes(manifest.lanes),
      captureWarnings: manifest.warnings,
      violations,
      duration: formatDuration(Date.now() - startTime),
    });

    process.exit(violations.length === 0 ? EXIT_OK : EXIT_VIOLATION);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'PipelineCheck');
  }
}

/**
 * Every invariant violation the manifest records, per lane and then corpus-wide.
 *
 * @param manifest - The manifest from a commands-off capture
 * @returns The violations, lane-scoped first
 */
function collectViolations(manifest: SnapshotManifest): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  for (const lane of manifest.lanes) {
    violations.push(...laneViolations(lane));
  }

  const disagreements = manifest.parseFactKeyDisagreementCount;
  if (disagreements !== null && disagreements > 0) {
    violations.push({
      laneId: null,
      code: 'KEY_DISAGREEMENT',
      detail:
        `${String(disagreements)} content key(s) are shared by paths whose parses DISAGREE. ` +
        'A content-addressed cache over this pipeline would be unsound: asked about one path, it would serve the parse of the other.',
    });
  }

  return violations;
}

/**
 * The two per-lane invariants.
 *
 * @param lane - One lane's manifest entry
 * @returns Zero, one or two violations
 */
function laneViolations(lane: LaneManifestEntry): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (lane.buildError !== null) {
    violations.push({
      laneId: lane.laneId,
      code: 'BUILD_ERROR',
      detail:
        `the production builder threw: ${lane.buildError}. ` +
        'Its admitted and collision counts are 0 because nothing ran, not because the corpus is empty.',
    });
  }

  if (lane.restatementDriftCount > 0) {
    violations.push({
      laneId: lane.laneId,
      code: 'RESTATEMENT_DRIFT',
      detail:
        `${String(lane.restatementDriftCount)} path(s) where the crawl restated in pipeline-oracles/lanes.ts ` +
        'disagrees with the builder it claims to describe. Every artifact this lane produced describes a crawl that did not happen.',
    });
  }

  return violations;
}

/**
 * Duplicate-id collisions, as information.
 *
 * @param lanes - Every captured lane's manifest entry
 * @returns One note per lane that saw a collision; empty when none did
 */
function collisionNotes(lanes: readonly LaneManifestEntry[]): CollisionNote[] {
  return lanes
    .filter((lane) => lane.collisionCount > 0)
    .map((lane) => ({ lane: lane.laneId, duplicateIdCount: lane.collisionCount }));
}
