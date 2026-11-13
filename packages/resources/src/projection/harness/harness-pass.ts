/**
 * The LAZY harness pass: derive each harness's facts (`harness_blob_facts`,
 * `harness_blob_imports`) for exactly the blobs it can reach
 * ({@link harnessFrontier}), until nothing reached is underived.
 *
 * It runs inside `populate` — once after the blob stage, again after every
 * closure-fixpoint iteration (a declared closure's members arrive there), and
 * once after the post-closure promotion — so that when a population is
 * returned, every blob a strict reader can reach has its facts, and an absent
 * row can only ever mean "the harness never reaches this", never "not yet" —
 * or that this run REFUSED it, which a `blob_conditions` row says.
 *
 * ## The facts come from the bounded worker, never this thread
 *
 * What a harness does with a file's bytes is a parse (Claude Code's: the
 * `marked` lexer and a frontmatter decode), so it runs in the parse worker
 * under the pool's limits (ADR I8), through the run's dispatcher
 * ({@link HarnessFactsDeriver}). A read stopped at a limit, or lost with its
 * worker, is refused for this run exactly as a blob-stage parse is: a
 * `BLOB_PARSE_LIMIT_EXCEEDED` / `BLOB_PARSE_WORKER_DIED` condition row
 * (`parseRefusalCondition`), never stored and never a facts row (I1, I6) —
 * so the population's refusal contract (`blob-refusals.ts`) names the file,
 * and every strict reader treats the blob as having no facts to read
 * (`HarnessFactsIndex.refused`). Anything else the read throws — a broken
 * install, a bug — propagates.
 */

import { forEachInOrder, isPathAbsentError } from '@vibe-agent-toolkit/utils';

import type { MeasuredContent } from '../../content-key.js';
import type { ParseDispatcher } from '../../parse-dispatcher.js';
import { isPerRunParseRefusal } from '../../parse-limits.js';
import { harnessRowsFor } from '../blob-facts.js';
import { parseRefusalCondition, parserKindOf } from '../blob-population.js';
import { readKeyedContent, type RunContentCache } from '../content-cache.js';
import type { ProjectionBuilder } from '../projection.js';

import { HarnessFactsAbsentError } from './facts-index.js';
import type { HarnessContentFacts, HarnessId, HarnessProfile } from './profile.js';
import { harnessFrontier, type HarnessFrontierEntry, type HarnessReachView } from './reach.js';

/**
 * Reads one frontier blob's content, or answers null when its bytes cannot be
 * read or no longer key to it.
 */
export type HarnessContentReader = (entry: HarnessFrontierEntry) => Promise<MeasuredContent | null>;

/**
 * Runs one harness's memory-file read over one file's decoded bytes — in a
 * population, the run's dispatcher ({@link dispatcherHarnessFacts}).
 */
export type HarnessFactsDeriver = (harness: HarnessId, input: MeasuredContent) => Promise<HarnessContentFacts>;

/**
 * The deriver every population uses: the run's dispatcher, so the read runs
 * on the run's one pool, under its limits.
 *
 * @param dispatcher - The run's dispatcher
 * @returns The deriver
 */
export function dispatcherHarnessFacts(dispatcher: ParseDispatcher): HarnessFactsDeriver {
  return (harness, input) => dispatcher.harnessFacts(harness, input);
}

/** What one {@link runHarnessPass} call did. */
interface HarnessPassResult {
  /** Facts rows added — 0 means the projection was already settled. */
  readonly derived: number;
  /** Blobs whose read this run refused — a per-run condition row each, no facts. */
  readonly refused: number;
  /** Frontier blobs whose reader answered null. */
  readonly unreadable: number;
  /** Their content keys — excused from {@link assertHarnessSettled}, and nothing else. */
  readonly unreadableKeys: ReadonlySet<string>;
}

/**
 * Derive facts for the frontier until it is empty.
 *
 * Each round asks for the frontier afresh, because deriving one blob's facts
 * is what reveals its imports — the next hop's frontier. A blob whose reader
 * answers null is remembered for the rest of the call, or the loop would ask
 * for it forever.
 *
 * ⛔ The facts row is added LAST, after the blob's import rows: the facts row
 * is what makes a blob "derived", so an interruption between the two leaves
 * the blob in the frontier to be derived again, never half-derived.
 *
 * A refused read leaves the blob's condition row, which takes it out of every
 * later frontier ({@link harnessFrontier} skips a refused blob).
 *
 * @param builder - The builder to add rows to; its base is re-read every round
 * @param profiles - The harnesses to derive for
 * @param readContent - Where a frontier blob's bytes come from
 * @param deriveFacts - Runs the harness's read over them
 * @returns How many facts rows were added, how many reads were refused, and
 *   which blobs could not be read
 */
export async function runHarnessPass(
  builder: ProjectionBuilder,
  profiles: readonly HarnessProfile[],
  readContent: HarnessContentReader,
  deriveFacts: HarnessFactsDeriver,
): Promise<HarnessPassResult> {
  const tally: FrontierTally = { derived: 0, refused: 0, unreadable: new Set<string>() };
  // One round per frontier, each only after the last one's rows are in the builder.
  const drain = async (profile: HarnessProfile, attempted: Set<string>): Promise<void> => {
    const frontier = harnessFrontier(builder.base(), profile).filter((entry) => !tally.unreadable.has(entry.contentKey));
    if (frontier.length === 0) return;
    assertProgress(profile, frontier, attempted);
    await deriveFrontier(builder, profile, frontier, { readContent, deriveFacts }, tally);
    return drain(profile, attempted);
  };
  await forEachInOrder(profiles, (profile) => drain(profile, new Set<string>()));
  return { derived: tally.derived, refused: tally.refused, unreadable: tally.unreadable.size, unreadableKeys: tally.unreadable };
}

/**
 * Refuse a frontier that demands a blob this pass already derived (ADR I8).
 *
 * A derived blob leaves the frontier by its facts row, a refused one by its
 * condition row, an unreadable one by the pass's own filter. A blob back on the
 * frontier after one of those means a round filed neither row — and the next
 * round would demand it again, forever. That is a VAT defect, so the run ends
 * with the coded absence, never another loop.
 *
 * @param profile - The harness the frontier is for
 * @param frontier - This round's blobs
 * @param attempted - Every key an earlier round of this pass derived; this
 *   round's are added
 * @throws {@link HarnessFactsAbsentError} for the first blob demanded twice
 */
function assertProgress(profile: HarnessProfile, frontier: readonly HarnessFrontierEntry[], attempted: Set<string>): void {
  const again = frontier.find((entry) => attempted.has(entry.contentKey));
  if (again !== undefined) throw new HarnessFactsAbsentError(profile.id, again.contentKey, again.path);
  for (const entry of frontier) attempted.add(entry.contentKey);
}

/** What a pass has done so far, accumulated across its rounds. */
interface FrontierTally {
  derived: number;
  refused: number;
  /** The keys whose reader answered null. */
  readonly unreadable: Set<string>;
}

/** Where a pass's bytes come from, and what runs over them. */
interface HarnessSources {
  readonly readContent: HarnessContentReader;
  readonly deriveFacts: HarnessFactsDeriver;
}

/**
 * Derive one frontier's facts, in content-key order.
 *
 * @param builder - The builder to add rows to
 * @param profile - The harness deriving them
 * @param frontier - The blobs to derive
 * @param sources - Where their bytes come from, and what runs over them
 * @param tally - Counts what was derived and refused, and collects the keys
 *   whose reader answered null
 */
async function deriveFrontier(
  builder: ProjectionBuilder,
  profile: HarnessProfile,
  frontier: readonly HarnessFrontierEntry[],
  sources: HarnessSources,
  tally: FrontierTally,
): Promise<void> {
  await forEachInOrder(frontier, async (entry) => {
    const content = await sources.readContent(entry);
    if (content === null) {
      tally.unreadable.add(entry.contentKey);
      return;
    }
    let facts: HarnessContentFacts;
    try {
      facts = await sources.deriveFacts(profile.id, content);
    } catch (error) {
      // Refused for this run (I6): a condition row, never a facts row (I1).
      // Anything else — a broken install, a bug — is not the file's doing.
      if (!isPerRunParseRefusal(error)) throw error;
      builder.addBlobCondition(parseRefusalCondition(entry.contentKey, error));
      tally.refused += 1;
      return;
    }
    const rows = harnessRowsFor(entry.contentKey, profile.id, facts);
    for (const row of rows.imports) builder.addHarnessBlobImport(row);
    builder.addHarnessBlobFacts(rows.facts);
    tally.derived += 1;
  });
}

/**
 * The on-disk reader, through the run's cache: the same bytes the base keyed and
 * the blob stage parsed.
 *
 * Null when the file is gone or its bytes no longer key to the blob: deriving
 * from other bytes would file one blob's facts under another blob's key. Any
 * other failure — a refusal, a bug — is rethrown: the blob stage read these
 * very bytes moments ago, so it is not an absence to paper over.
 *
 * @param cache - The run's content cache
 * @returns The reader
 */
export function diskHarnessContentReader(cache: RunContentCache): HarnessContentReader {
  return async (entry) => {
    // Outside the `try`: a key naming no parser kind is a producer bug, and
    // reading it as "unreadable" would blame the corpus for it.
    const parserKind = parserKindOf(entry.contentKey);
    try {
      const keyed = await readKeyedContent(entry.absolutePath, parserKind, cache);
      return keyed.key === entry.contentKey ? keyed : null;
    } catch (error) {
      // Deleted since the base keyed it: counted as unreadable by the pass.
      if (isPathAbsentError(error)) return null;
      throw error;
    }
  };
}

/**
 * The reached `(blob, harness)` pairs a projection holds no harness facts for —
 * none, when it is settled.
 *
 * @param view - A populated or hydrated projection
 * @param profiles - The harnesses to check
 * @returns One content key per unsettled pair, profile by profile
 */
export function harnessUnsettledKeys(view: HarnessReachView, profiles: readonly HarnessProfile[]): string[] {
  return profiles.flatMap((profile) => harnessFrontier(view, profile).map((entry) => entry.contentKey));
}

/**
 * Refuse a population that reaches a blob with no facts — a producer bug,
 * since the pass runs after every stage that can add a reachable blob.
 *
 * @param view - The population's base, after its last pass
 * @param profiles - The harnesses it derived for
 * @param unreadable - Keys a pass could not read — excused, and nothing else is
 * @throws {HarnessFactsAbsentError} For the first reached, underived blob
 */
export function assertHarnessSettled(
  view: HarnessReachView,
  profiles: readonly HarnessProfile[],
  unreadable: ReadonlySet<string>,
): void {
  for (const profile of profiles) {
    const missing = harnessFrontier(view, profile).find((entry) => !unreadable.has(entry.contentKey));
    if (missing !== undefined) throw new HarnessFactsAbsentError(profile.id, missing.contentKey, missing.path);
  }
}
