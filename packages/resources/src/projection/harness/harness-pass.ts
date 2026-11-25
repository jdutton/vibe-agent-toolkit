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

import { countWork, forEachInOrder } from '@vibe-agent-toolkit/utils';

import type { MeasuredContent } from '../../content-key.js';
import type { ParseDispatcher } from '../../parse-dispatcher.js';
import { isPerRunParseRefusal } from '../../parse-limits.js';
import type { HarnessBlobFactsRow, HarnessBlobImportRow } from '../../schemas/projection-harness.js';
import { harnessRowsFor } from '../blob-facts.js';
import { parseRefusalCondition } from '../blob-population.js';
import type { ProjectionBuilder } from '../projection.js';
import type { RunContentSource } from '../run-population.js';
import type { StoredBlobTier } from '../store-hydration.js';
import type { HarnessPair } from '../store.js';

import { HarnessFactsAbsentError } from './facts-index.js';
import type { HarnessContentFacts, HarnessId, HarnessProfile } from './profile.js';
import { harnessFrontier, type HarnessFrontierEntry, type HarnessReachView } from './reach.js';

/** One stored `(blob, harness)` pair: its facts row and its import rows, in ordinal order. */
interface StoredHarnessPair {
  readonly facts: HarnessBlobFactsRow;
  readonly imports: readonly HarnessBlobImportRow[];
}

/**
 * The stored harness rows a pass may serve, looked up by pair. Only a key the
 * stored tier covers is held: a key the store does not cover is derived whole.
 */
export interface StoredHarnessRows {
  /** The stored rows for one pair, or undefined when the store holds none for it. */
  readonly rowsFor: (pair: HarnessPair) => StoredHarnessPair | undefined;
}

/**
 * The harness rows of a stored tier's covered keys, by pair.
 *
 * Served at the frontier, pair by pair, never up front: a stored pair this run
 * does not reach must not enter the projection, or it would disagree row for row
 * with a run that never read the store.
 *
 * @param tier - What the derivation read of the stored tier
 * @returns The covered keys' harness rows
 */
export function storedHarnessRows(tier: StoredBlobTier): StoredHarnessRows {
  const byPair = new Map<string, { facts: HarnessBlobFactsRow; imports: HarnessBlobImportRow[] }>();
  for (const facts of tier.rows.harnessBlobFacts) {
    if (tier.covered.has(facts.blob)) byPair.set(pairKey({ contentKey: facts.blob, harness: facts.harness }), { facts, imports: [] });
  }
  for (const row of tier.rows.harnessBlobImports) {
    byPair.get(pairKey({ contentKey: row.blob, harness: row.harness }))?.imports.push(row);
  }
  for (const held of byPair.values()) held.imports.sort((left, right) => left.ordinal - right.ordinal);
  return { rowsFor: (pair) => byPair.get(pairKey(pair)) };
}

/**
 * @param pair - A (blob, harness) pair
 * @returns One string per pair: a content key holds no NUL
 */
function pairKey(pair: HarnessPair): string {
  return `${pair.contentKey}\0${pair.harness}`;
}

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
  /** Facts rows derived from content: with nothing served, 0 means the projection was already settled. */
  readonly derived: number;
  /** The pairs this call settled from their stored rows, in frontier order. */
  readonly served: readonly HarnessPair[];
  /** Blobs whose read this run refused — a per-run condition row each, no facts. */
  readonly refused: number;
  /** Frontier blobs whose bytes were gone or no longer keyed to them. */
  readonly unreadable: number;
  /** Their content keys — excused from {@link assertHarnessSettled}, and nothing else. */
  readonly unreadableKeys: ReadonlySet<string>;
}

/**
 * Settle the frontier until it is empty: a pair the store holds is served from
 * its stored rows, every other pair is derived from content.
 *
 * Each round asks for the frontier afresh, because settling one blob's facts
 * is what reveals its imports — the next hop's frontier. A blob whose bytes are
 * gone or no longer key to it is remembered for the rest of the call, or the
 * loop would ask for it forever.
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
 * @param stored - The stored rows a reached pair is served from before any read
 * @returns How many facts rows were derived, which pairs were served, how many
 *   reads were refused, and which blobs could not be read
 */
export async function runHarnessPass(
  builder: ProjectionBuilder,
  profiles: readonly HarnessProfile[],
  readContent: RunContentSource,
  deriveFacts: HarnessFactsDeriver,
  stored: StoredHarnessRows,
): Promise<HarnessPassResult> {
  const tally: FrontierTally = { derived: 0, served: [], refused: 0, unreadable: new Set<string>() };
  // One round per frontier, each only after the last one's rows are in the builder.
  const drain = async (profile: HarnessProfile, attempted: Set<string>): Promise<void> => {
    const frontier = harnessFrontier(builder.base(), profile).filter((entry) => !tally.unreadable.has(entry.contentKey));
    if (frontier.length === 0) return;
    assertProgress(profile, frontier, attempted);
    await settleFrontier(builder, profile, frontier, { readContent, deriveFacts, stored }, tally);
    return drain(profile, attempted);
  };
  await forEachInOrder(profiles, (profile) => drain(profile, new Set<string>()));
  return {
    derived: tally.derived,
    served: tally.served,
    refused: tally.refused,
    unreadable: tally.unreadable.size,
    unreadableKeys: tally.unreadable,
  };
}

/**
 * Refuse a frontier that demands a blob this pass already settled (ADR I8).
 *
 * A settled blob leaves the frontier by its facts row, a refused one by its
 * condition row, an unreadable one by the pass's own filter. A blob back on the
 * frontier after one of those means a round filed neither row — and the next
 * round would demand it again, forever. That is a VAT defect, so the run ends
 * with the coded absence, never another loop.
 *
 * @param profile - The harness the frontier is for
 * @param frontier - This round's blobs
 * @param attempted - Every key an earlier round of this pass settled; this
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
  /** The pairs served from their stored rows. */
  readonly served: HarnessPair[];
  refused: number;
  /** The keys whose bytes were gone or no longer keyed to them. */
  readonly unreadable: Set<string>;
}

/** The stored rows a pass serves first, where other bytes come from, and what runs over them. */
interface HarnessSources {
  readonly readContent: RunContentSource;
  readonly deriveFacts: HarnessFactsDeriver;
  readonly stored: StoredHarnessRows;
}

/**
 * Settle one frontier, in frontier order: each pair from its stored rows when
 * the store holds them, otherwise derived from its bytes.
 *
 * @param builder - The builder to add rows to
 * @param profile - The harness settling them
 * @param frontier - The blobs to settle
 * @param sources - The stored rows, where bytes come from, and what runs over them
 * @param tally - Counts what was derived and refused, and collects the served
 *   pairs and the keys whose bytes could not be read
 */
async function settleFrontier(
  builder: ProjectionBuilder,
  profile: HarnessProfile,
  frontier: readonly HarnessFrontierEntry[],
  sources: HarnessSources,
  tally: FrontierTally,
): Promise<void> {
  await forEachInOrder(frontier, async (entry) => {
    const pair: HarnessPair = { contentKey: entry.contentKey, harness: profile.id };
    const held = sources.stored.rowsFor(pair);
    if (held !== undefined) {
      // The facts row last, as for a derived pair: it is what settles the pair.
      for (const row of held.imports) builder.addHarnessBlobImport(row);
      builder.addHarnessBlobFacts(held.facts);
      tally.served.push(pair);
      return;
    }
    const content = await sources.readContent.read(entry);
    // Gone, or rewritten since the base keyed it: deriving from other bytes would
    // file one blob's facts under another blob's key.
    if (content?.key !== entry.contentKey) {
      tally.unreadable.add(entry.contentKey);
      return;
    }
    await derivePair(builder, profile, entry.contentKey, content, sources.deriveFacts, tally);
  });
}

/**
 * Derive one pair's facts from its bytes, or file its per-run refusal.
 *
 * @param builder - The builder to add rows to
 * @param profile - The harness deriving them
 * @param contentKey - The blob
 * @param content - Its bytes
 * @param deriveFacts - Runs the harness's read over them
 * @param tally - Counts what was derived and refused
 */
async function derivePair(
  builder: ProjectionBuilder,
  profile: HarnessProfile,
  contentKey: string,
  content: MeasuredContent,
  deriveFacts: HarnessFactsDeriver,
  tally: FrontierTally,
): Promise<void> {
  let facts: HarnessContentFacts;
  try {
    facts = await deriveFacts(profile.id, content);
  } catch (error) {
    // Refused for this run (I6): a condition row, never a facts row (I1).
    // Anything else — a broken install, a bug — is not the file's doing.
    if (!isPerRunParseRefusal(error)) throw error;
    builder.addBlobCondition(parseRefusalCondition(contentKey, error));
    tally.refused += 1;
    return;
  }
  const rows = harnessRowsFor(contentKey, profile.id, facts);
  for (const row of rows.imports) builder.addHarnessBlobImport(row);
  builder.addHarnessBlobFacts(rows.facts);
  tally.derived += 1;
  countWork('harness.pairsDerived', 1);
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
