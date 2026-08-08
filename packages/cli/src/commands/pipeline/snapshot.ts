/**
 * `vat pipeline snapshot [dir] --out <dir>` — capture, and optionally compare.
 *
 * The capture itself lives in `qa-snapshot/capture.ts`; this file is the thin
 * CLI layer around it. Two things here are more than wiring:
 *
 * - **`--out` is required and has no default.** A snapshot directory is
 *   *replaced* wholesale by `writeSnapshot`, so a defaulted path would be a
 *   destructive default. The caller names the directory or the command refuses.
 * - **An unrecognised `--lane` is a refusal, not an empty run.** Filtering the
 *   lane set by an id nobody defines yields a capture with zero lanes, which
 *   writes cleanly, exits 0, and later compares against anything as "nothing
 *   changed". {@link resolveLaneIds} exists to make that impossible.
 */

import { basename } from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';

import { LANES, type LaneId } from '../../pipeline-oracles/index.js';
import {
  captureSnapshot,
  readSnapshot,
  writeSnapshot,
  type CaptureRequest,
  type SnapshotManifest,
} from '../../qa-snapshot/index.js';
import { formatDuration, handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

import { DEFAULT_DIFF_CONTEXT, DEFAULT_DIFF_MAX_LINES, reportComparison } from './compare.js';

/** Every lane id, in `LANES` order — the population `--lane` selects from. */
export const LANE_IDS: readonly LaneId[] = LANES.map((lane) => lane.id);

/** The valid lane ids as one string, for help text and for the refusal message. */
export const LANE_ID_LIST = LANE_IDS.join(', ');

/**
 * Default ceiling on each spawned whole-command run, in milliseconds.
 *
 * Five minutes because `vat audit` over a thousand-document corpus takes
 * minutes, not seconds, and a capture that times out leaves a truncated
 * artifact that compares as a large deletion.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

/** Corpus directory used when the positional argument is omitted. */
const DEFAULT_CORPUS_DIR = '.';

/** Parsed `vat pipeline snapshot` flags. */
export interface PipelineSnapshotOptions {
  /** Required. Directory the snapshot is written to, replacing what is there. */
  out?: string;
  /** Snapshot directory to use as the BEFORE side of an immediate comparison. */
  compare?: string;
  /** Raw `--lane` values, unvalidated. */
  lane?: string[];
  /** `--no-commands` sets this to `false`; Commander defaults it to `true`. */
  commands?: boolean;
  /** `--no-parse-facts` sets this to `false`; Commander defaults it to `true`. */
  parseFacts?: boolean;
  /** Short corpus label printed into the oracle artifacts. */
  label?: string;
  /** Per-command ceiling in milliseconds. */
  timeout?: number;
  debug?: boolean;
}

/**
 * Validate the `--lane` selection and put it back into `LANES` order.
 *
 * Returns `undefined` for "no selection" so the caller can omit the key
 * entirely — `CaptureRequest.lanes` is optional under
 * `exactOptionalPropertyTypes`, where an explicit `undefined` is not the same
 * as an absent key.
 *
 * @param raw - Raw `--lane` values as Commander collected them, in any order
 * @returns The selected lane ids in `LANES` order, or `undefined` when none were given
 * @throws {Error} When any value is not one of the five known lane ids
 */
export function resolveLaneIds(raw: readonly string[] | undefined): readonly LaneId[] | undefined {
  if (raw === undefined || raw.length === 0) return undefined;

  const known = new Set<string>(LANE_IDS);
  const unknown = raw.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown --lane id(s): ${unknown.join(', ')}\n` +
        `  Valid lane ids are: ${LANE_ID_LIST}\n` +
        '  Refusing to run rather than silently selecting nothing: an empty capture writes cleanly, exits 0, ' +
        'and later compares against anything as "nothing changed".',
    );
  }

  const selected = new Set(raw);
  return LANE_IDS.filter((id) => selected.has(id));
}

/**
 * Capture a QA snapshot of the resource pipeline over a corpus.
 *
 * @param dir - Corpus directory; defaults to the current working directory
 * @param options - Parsed flags, including the required `--out`
 * @returns Never returns normally — the process exits from inside
 */
export async function pipelineSnapshotCommand(
  dir: string | undefined,
  options: PipelineSnapshotOptions,
): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const outDir = options.out;
    if (outDir === undefined || outDir.length === 0) {
      throw new Error(
        "'--out <dir>' is required. It has no default on purpose: a snapshot directory is REPLACED wholesale, " +
          'so a defaulted path would be a destructive default.',
      );
    }

    const request = buildCaptureRequest(dir, options);
    logger.info(
      `capturing '${request.corpusLabel}' from ${request.corpusRoot} ` +
        `(${String(request.lanes?.length ?? LANE_IDS.length)} lane(s), ` +
        `commands=${String(request.includeCommands)}, parseFacts=${String(request.includeParseFacts)})`,
    );

    const result = await captureSnapshot(request);
    writeSnapshot(outDir, result.manifest, result.artifacts);
    logger.debug(`wrote ${String(result.artifacts.size)} artifact(s) to ${outDir}`);

    if (options.compare === undefined) {
      return reportCapture(outDir, result.manifest, result.artifacts.size, startTime);
    }

    // --compare is sugar for the comparison `vat pipeline compare` would run:
    // the named directory is the BEFORE side, this fresh capture is AFTER. Both
    // are read back off disk rather than compared in memory, so the sugar
    // exercises the same round-trip the two-step workflow does.
    process.exit(
      reportComparison(readSnapshot(options.compare), readSnapshot(outDir), {
        maxLines: DEFAULT_DIFF_MAX_LINES,
        context: DEFAULT_DIFF_CONTEXT,
      }),
    );
  } catch (error) {
    handleCommandError(error, logger, startTime, 'PipelineSnapshot');
  }
}

/**
 * Turn parsed flags into a {@link CaptureRequest}.
 *
 * @param dir - Corpus directory as given, possibly omitted
 * @param options - Parsed flags
 * @returns The request `captureSnapshot` is called with
 * @throws {Error} When `--lane` names an id that is not one of the five
 */
function buildCaptureRequest(
  dir: string | undefined,
  options: PipelineSnapshotOptions,
): CaptureRequest {
  const corpusRoot = safePath.resolve(dir ?? DEFAULT_CORPUS_DIR);
  const lanes = resolveLaneIds(options.lane);

  return {
    corpusRoot,
    corpusLabel: options.label ?? basename(corpusRoot),
    // Conditional spread, not `lanes: lanes`: under exactOptionalPropertyTypes
    // an explicit `undefined` is not the same as an absent optional key, and
    // `captureSnapshot` reads the absent key as "all five lanes".
    ...(lanes === undefined ? {} : { lanes }),
    includeCommands: options.commands !== false,
    includeParseFacts: options.parseFacts !== false,
    commandTimeoutMs: options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
  };
}

/**
 * Publish the plain-capture summary and exit 0.
 *
 * `warnings` rides in the summary as well as in the manifest: they are the
 * constraints any later comparison is bound by (a walk-route lane, a lane whose
 * builder threw, a skipped half), and a reader who first meets them at compare
 * time meets them after already forming a conclusion.
 *
 * @param outDir - Directory the snapshot was written to
 * @param manifest - The manifest just written
 * @param artifactCount - How many artifact files it names
 * @param startTime - `Date.now()` at command entry, for the duration field
 * @returns Never — exits the process with code 0
 */
function reportCapture(
  outDir: string,
  manifest: SnapshotManifest,
  artifactCount: number,
  startTime: number,
): never {
  writeYamlOutput({
    status: 'success',
    out: safePath.resolve(outDir),
    corpus: manifest.corpusRoot,
    lanes: manifest.lanes.length,
    commands: manifest.commands.length,
    artifacts: artifactCount,
    warnings: manifest.warnings,
    duration: formatDuration(Date.now() - startTime),
  });
  process.exit(0);
}
