/**
 * The LAZY harness pass: derive each harness's facts (`harness_blob_facts`,
 * `harness_blob_imports`) for exactly the blobs it can reach
 * ({@link harnessFrontier}), until nothing reached is underived.
 *
 * It runs inside `populate` — once after the blob stage, again after every
 * closure-fixpoint iteration (a declared closure's members arrive there), and
 * once after the post-closure promotion — so that when a population is
 * returned, every blob a strict reader can reach has its facts, and an absent
 * row can only ever mean "the harness never reaches this", never "not yet".
 */

import { isPathAbsentError } from '@vibe-agent-toolkit/utils';

import { harnessRowsFor } from '../blob-facts.js';
import { parserKindOf } from '../blob-population.js';
import { readKeyedContent, type RunContentCache } from '../content-cache.js';
import type { ProjectionBuilder } from '../projection.js';

import { HarnessFactsAbsentError } from './facts-index.js';
import type { HarnessProfile } from './profile.js';
import { harnessFrontier, type HarnessFrontierEntry, type HarnessReachView } from './reach.js';

/**
 * Reads one frontier blob's content, or answers null when its bytes cannot be
 * read or no longer key to it.
 */
export type HarnessContentReader = (entry: HarnessFrontierEntry) => Promise<string | null>;

/** What one {@link runHarnessPass} call did. */
interface HarnessPassResult {
  /** Facts rows added — 0 means the projection was already settled. */
  readonly derived: number;
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
 * @param builder - The builder to add rows to; its base is re-read every round
 * @param profiles - The harnesses to derive for
 * @param readContent - Where a frontier blob's bytes come from
 * @returns How many facts rows were added, and which blobs could not be read
 */
export async function runHarnessPass(
  builder: ProjectionBuilder,
  profiles: readonly HarnessProfile[],
  readContent: HarnessContentReader,
): Promise<HarnessPassResult> {
  let derived = 0;
  const unreadableKeys = new Set<string>();
  for (const profile of profiles) {
    for (;;) {
      const frontier = harnessFrontier(builder.base(), profile).filter((entry) => !unreadableKeys.has(entry.contentKey));
      if (frontier.length === 0) break;
      derived += await deriveFrontier(builder, profile, frontier, readContent, unreadableKeys);
    }
  }
  return { derived, unreadable: unreadableKeys.size, unreadableKeys };
}

/**
 * Derive one frontier's facts, in content-key order.
 *
 * @param builder - The builder to add rows to
 * @param profile - The harness deriving them
 * @param frontier - The blobs to derive
 * @param readContent - Where their bytes come from
 * @param unreadable - Collects the keys whose reader answered null
 * @returns How many facts rows were added
 */
async function deriveFrontier(
  builder: ProjectionBuilder,
  profile: HarnessProfile,
  frontier: readonly HarnessFrontierEntry[],
  readContent: HarnessContentReader,
  unreadable: Set<string>,
): Promise<number> {
  let derived = 0;
  for (const entry of frontier) {
    const content = await readContent(entry);
    if (content === null) {
      unreadable.add(entry.contentKey);
      continue;
    }
    const rows = harnessRowsFor(entry.contentKey, profile.id, profile.factsOf(content));
    for (const row of rows.imports) builder.addHarnessBlobImport(row);
    builder.addHarnessBlobFacts(rows.facts);
    derived += 1;
  }
  return derived;
}

/**
 * The on-disk reader: the run's cache when there is one — the same bytes the
 * base keyed and the blob stage parsed — and the disk when there is not.
 *
 * Null when the file is gone or its bytes no longer key to the blob: deriving
 * from other bytes would file one blob's facts under another blob's key. Any
 * other failure — a refusal, a bug — is rethrown: the blob stage read these
 * very bytes moments ago, so it is not an absence to paper over.
 *
 * @param cache - The run's content cache, or undefined outside a population
 * @returns The reader
 */
export function diskHarnessContentReader(cache: RunContentCache | undefined): HarnessContentReader {
  return async (entry) => {
    // Outside the `try`: a key naming no parser kind is a producer bug, and
    // reading it as "unreadable" would blame the corpus for it.
    const parserKind = parserKindOf(entry.contentKey);
    try {
      const keyed = await readKeyedContent(entry.absolutePath, parserKind, cache);
      return keyed.key === entry.contentKey ? keyed.content : null;
    } catch (error) {
      // Deleted since the base keyed it: counted as unreadable by the pass.
      if (isPathAbsentError(error)) return null;
      throw error;
    }
  };
}

/**
 * Whether a projection holds every harness's facts for everything it reaches.
 *
 * @param view - A populated or hydrated projection
 * @param profiles - The harnesses to check
 * @returns True when every profile's frontier is empty
 */
export function harnessSettled(view: HarnessReachView, profiles: readonly HarnessProfile[]): boolean {
  return profiles.every((profile) => harnessFrontier(view, profile).length === 0);
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
