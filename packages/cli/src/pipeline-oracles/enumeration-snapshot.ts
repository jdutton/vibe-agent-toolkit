/**
 * Oracle 1 — the enumeration snapshot.
 *
 * The highest-value of the three intermediate oracles, by a distance. It is the
 * whole contract of the enumerating stage: which paths, in which order, with
 * which cheap attributes. A whole-command golden going red tells you the output
 * changed; this tells you whether the *population* changed, which is the thing
 * a pipeline restructure most needs held still and which no command output
 * exposes directly.
 */

import {
  collectRealization,
  relativize,
  type ResourceRegistry,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { crawlDirectory } from '@vibe-agent-toolkit/utils/crawl';
import { gitFindRoot, GitTracker } from '@vibe-agent-toolkit/utils/git';

import {
  markAliases,
  ORACLE_EXTENT_ID,
  ORACLE_RESOURCE_ID,
  toEnumerationRow,
} from './aliases.js';
import type { LaneDefinition } from './lanes.js';
import type {
  CollisionRow,
  EnumerationRoute,
  EnumerationRow,
  EnumerationSnapshot,
} from './types.js';

/** Options for a single snapshot capture. */
export interface CaptureOptions {
  /** Root the lane is pointed at, and the root every path is rendered relative to. */
  corpusRoot: string;
  /** Label that names the corpus in the golden file. */
  corpus: string;
}

/**
 * Capture what one lane enumerates over one corpus.
 *
 * @param lane - The lane to exercise
 * @param options - Corpus root and label
 * @returns The snapshot, order preserved
 *
 * @example
 * ```typescript
 * const snapshot = await captureEnumerationSnapshot(laneById('resources'), {
 *   corpusRoot: corpus,
 *   corpus: 'trap-corpus/non-git',
 * });
 * ```
 */
export async function captureEnumerationSnapshot(
  lane: LaneDefinition,
  options: CaptureOptions,
): Promise<EnumerationSnapshot> {
  const corpusRoot = safePath.resolve(options.corpusRoot);

  const gitTracker = await initGitTracker(corpusRoot);
  const route: EnumerationRoute = gitFindRoot(corpusRoot) === null ? 'walk' : 'git-ls-files';

  // Pre-deduplication, ordered. This is the crawl's own output — the registry
  // never retains it, because `addResources` folds duplicates away as it goes.
  const crawled = await crawlDirectory(lane.crawlOptions(corpusRoot));
  const enumerated: EnumerationRow[] = [];
  for (const absolutePath of crawled) {
    const realization = await collectRealization(absolutePath, ORACLE_RESOURCE_ID, {
      root: corpusRoot,
      extentId: ORACLE_EXTENT_ID,
      ...(gitTracker !== undefined && { gitTracker }),
    });
    enumerated.push(toEnumerationRow(realization, absolutePath, corpusRoot));
  }
  // Aliasing is a property of the population, not of a path, so it can only be
  // answered once the whole lane has been walked.
  markAliases(enumerated, crawled);

  // Post-deduplication, ordered, from the lane's real production builder. The
  // builder can throw — see EnumerationSnapshot.buildError — and a lane that
  // dies on a corpus must be recorded, not allowed to take the harness with it.
  let registry: ResourceRegistry | undefined;
  let buildError: string | undefined;
  try {
    registry = await lane.build(corpusRoot);
  } catch (error) {
    buildError = describeError(error, corpusRoot);
  }

  const admitted = (registry?.getAllResources() ?? [])
    .map((resource) => relativize(resource.filePath, corpusRoot));
  const collisions: CollisionRow[] = (registry?.getDuplicateIdCollisions() ?? []).map((collision) => ({
    id: collision.id,
    existingPath: relativize(collision.existingPath, corpusRoot),
    conflictingPath: relativize(collision.conflictingPath, corpusRoot),
  }));

  return {
    laneId: lane.id,
    corpus: options.corpus,
    route,
    gitAvailable: gitTracker?.isUsable() === true,
    enumerated,
    admitted,
    collisions,
    // A thrown build says nothing about drift; reconciling an empty registry
    // against a populated crawl would report every path as "crawled but not
    // admitted" and bury the one fact that matters.
    restatementDrift: buildError === undefined ? reconcile(enumerated, admitted, collisions) : [],
    ...(buildError === undefined ? {} : { buildError }),
  };
}

/**
 * Render a thrown error into a golden-safe line.
 *
 * The corpus root is stripped because it is a `mkdtemp` path: leaving it in
 * makes the golden machine-specific and leaks `$HOME` on some hosts.
 *
 * @param error - Whatever was thrown
 * @param corpusRoot - Root to redact out of the message
 * @returns A single-line description
 */
function describeError(error: unknown, corpusRoot: string): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.split('\n')[0]?.replaceAll(corpusRoot, '<corpus>') ?? 'unknown error';
}

/**
 * Check that the declarative crawl restatement still describes what the lane's
 * real builder does.
 *
 * Every crawled path must end up either admitted or recorded as a
 * first-added-wins drop; every admitted path must have been crawled. A
 * disagreement means this module's copy of the lane's crawl options has drifted
 * from the lane — which makes every snapshot it produces a fiction, so it is
 * reported in the snapshot where a golden diff will show it.
 *
 * @param enumerated - Rows from the restated crawl
 * @param admitted - Paths the registry kept, in arrival order
 * @param collisions - Duplicate-id drops
 * @returns Human-readable drift descriptions; empty when the two reconcile
 */
function reconcile(
  enumerated: readonly EnumerationRow[],
  admitted: readonly string[],
  collisions: readonly CollisionRow[],
): string[] {
  const drift: string[] = [];
  const crawledPaths = new Set(enumerated.map((row) => row.path));
  const droppedPaths = new Set(collisions.map((collision) => collision.conflictingPath));

  for (const path of admitted) {
    if (!crawledPaths.has(path)) {
      drift.push(`admitted-but-not-crawled: ${path}`);
    }
  }
  for (const row of enumerated) {
    if (!admitted.includes(row.path) && !droppedPaths.has(row.path)) {
      drift.push(`crawled-but-not-admitted: ${row.path}`);
    }
  }

  // Order matters as much as membership: first-added-wins means a reordering
  // changes which colliding file survives even when the set is identical.
  const expectedOrder = enumerated
    .map((row) => row.path)
    .filter((path) => !droppedPaths.has(path));
  if (expectedOrder.length === admitted.length) {
    for (const [index, path] of expectedOrder.entries()) {
      if (admitted[index] !== path) {
        drift.push(`order-differs-at-${String(index)}: crawl=${path} registry=${String(admitted[index])}`);
        break;
      }
    }
  }

  return drift;
}

/**
 * Build a git oracle for the corpus, or report that there is none.
 *
 * A corpus outside any repository is a first-class case — every VAT fixture
 * being a git repo is what masked an 88%-of-runtime defect that cannot fire
 * inside one — so "no git here" must be a recorded fact, not an exception.
 *
 * @param corpusRoot - Absolute corpus root
 * @returns An initialized tracker, or undefined when the corpus is not in a repo
 */
async function initGitTracker(corpusRoot: string): Promise<GitTracker | undefined> {
  if (gitFindRoot(corpusRoot) === null) {
    return undefined;
  }
  const tracker = new GitTracker(corpusRoot);
  await tracker.initialize();
  return tracker.isUsable() ? tracker : undefined;
}
