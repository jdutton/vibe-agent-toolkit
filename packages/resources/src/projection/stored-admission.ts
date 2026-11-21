/**
 * Whether a registry admits a file from what the store holds about it, or
 * reads, keys and parses it the cold way: the decision a warm run's
 * {@link RunPopulation.admit} makes per file.
 *
 * A store hit hands the run its home root's members with each member's stored
 * realization ({@link StoredContent}). A file whose realization the store holds
 * under the parser this view routes it to is built from the blob tier's facts
 * through the one fact reader (`blobFactsReader`), so a warm run reads, hashes
 * and parses nothing for it. Every other file is computed exactly as a cold run
 * computes it: the decision only ever chooses BETWEEN the stored answer and the
 * cold code, never a third answer, so a warm run's findings are the cold run's.
 *
 * - no stored realization for the path, or one routed to another parser than
 *   this view's: cold;
 * - `keyed`, and the tier holds the key's facts or its stated refusal: those,
 *   once the file is still readable now (a probe, counted as `fs.stat`); a file
 *   that cannot be read now is cold, so the cold read raises the cold error;
 * - `keyed`, and the tier does not cover the key (evicted, damaged): cold, for
 *   that key alone;
 * - `oversize` of a kind a parser reads: refused at the input cap before any
 *   read, as cold refuses it (`unkeyedEntry`, the one rule the not-admitted log
 *   reads), once the file is still readable now (the same probe); one that cannot
 *   be read now is cold. Of a kind nothing parses: cold, whose refusal states a
 *   size the store does not hold;
 * - any other state (`unreadable`, `deferred`, `none`): cold.
 *
 * And none of it unless the run parses under the limits the store's facts were
 * filed under ({@link hydratesUnder}).
 *
 * The two decisions are split by the one await between them: {@link storedRoute}
 * says whether the tier must be read at all, and {@link readRoute} what its answer
 * means. Both are pure.
 */

import { deepFreeze, VatError } from '@vibe-agent-toolkit/utils';

import { parserKindForMimeType } from '../mime-type.js';
import type { ParseLimits } from '../parse-limits.js';
import type { ResourceRealizationRow } from '../schemas/projection-resources.js';

import { parserKindOf } from './blob-population.js';
import { type NotAdmittedEntry, unkeyedEntry } from './blob-refusals.js';
import { blobFactsReader, type BlobFactsOutcome } from './blob-resource-facts.js';
import { POPULATION_PARSE_LIMITS } from './content-cache.js';
import type { AdmittedFacts } from './run-population.js';
import { keyedContentKeys } from './store-hydration.js';
import type { BlobScopedRows, FactStore } from './store.js';

/**
 * What the store holds about one member's bytes: its realization's content columns. The store's
 * key vouches for those bytes: git declines to key a tree whose index hides any file from the
 * snapshot (`gitTreeKey`), and no file beneath a gitlink is a member of any population.
 */
export type StoredRealization = Pick<ResourceRealizationRow, 'contentKey' | 'contentState' | 'mime'>;

/** One member's stored realization and the reader of the tier it names. */
export interface StoredMember {
  readonly realization: StoredRealization;
  /**
   * The blob tier's answer for the members' keyed content: read from the store
   * on first ask, once, and handed back every later time.
   */
  readonly facts: () => Promise<(contentKey: string) => BlobFactsOutcome>;
}

/**
 * What a store hit holds about the members it enumerated: each member's
 * stored realization, by absolute path, and one lazily read blob tier.
 */
export interface StoredContent {
  /** Each member, by absolute path; the first realization of a path speaks for it. */
  readonly members: ReadonlyMap<string, StoredRealization>;
  /** See {@link StoredMember.facts}. */
  readonly facts: () => Promise<(contentKey: string) => BlobFactsOutcome>;
}

/** The code of a blob tier that could not be read ({@link BlobTierReadError}): the store's refusal. */
export const PROJECTION_STORE_READ_FAILED_CODE = 'PROJECTION_STORE_READ_FAILED';

/**
 * The blob tier could not be read. The store's failure, never a file's: coded,
 * so the per-file read classifier cannot file it as a file's errno whatever the
 * store's own error carries, and the run refuses.
 */
class BlobTierReadError extends VatError {
  /** @param cause - What the store's blob read rejected with */
  constructor(cause: unknown) {
    super(
      PROJECTION_STORE_READ_FAILED_CODE,
      `The projection store's blob facts could not be read: ${cause instanceof Error ? cause.message : String(cause)}. `
        + 'The store is a cache: clear it (`vat cache clear`) or point VAT_CACHE_DIR elsewhere.',
      { cause },
    );
  }
}

/**
 * Read the blob tier for `contentKeys`, a failed read rejecting as the store's
 * ({@link BlobTierReadError}): the one read every lane that reads the tier back
 * goes through, the stored admission and a projection hit alike, so one failure
 * is one refusal whichever lane met it.
 *
 * @param store - The run's store
 * @param contentKeys - The keys to read
 * @returns The tier's rows for them
 * @throws A {@link BlobTierReadError} when the store's read rejects
 */
export function readBlobTier(store: FactStore, contentKeys: readonly string[]): Promise<BlobScopedRows> {
  return store.readBlobFacts(contentKeys).catch((error: unknown) => {
    throw new BlobTierReadError(error);
  });
}

/**
 * The stored content of a hit's members.
 *
 * The tier is read for the members' keyed content keys on the first ask, ONCE
 * (the promise is the memo), and only when something asks: a run that admits
 * nothing from the store reads no blob row. A store that throws is not a miss:
 * it surfaces as a {@link BlobTierReadError}, and the run refuses.
 *
 * @param members - The hit's member realizations, each with its absolute path
 * @param store - The store the hit was read from
 * @returns The members' stored content
 */
export function storedContentOf(
  members: ReadonlyArray<{ readonly path: string; readonly row: ResourceRealizationRow }>,
  store: FactStore,
): StoredContent {
  const stored = new Map<string, StoredRealization>();
  for (const { path, row } of members) {
    if (stored.has(path)) continue;
    stored.set(path, { contentKey: row.contentKey, contentState: row.contentState, mime: row.mime });
  }
  const keys = keyedContentKeys({ resourceRealizations: members.map(({ row }) => row) });
  let read: Promise<(contentKey: string) => BlobFactsOutcome> | undefined;
  return {
    members: stored,
    facts: () => (read ??= readBlobTier(store, keys).then((rows) => blobFactsReader(rows))),
  };
}

/**
 * The same stored content with every path respelled, sharing the one tier read.
 *
 * @param stored - The stored content
 * @param respell - Maps a path to its other spelling
 * @returns The respelled content
 */
export function respelledContent(stored: StoredContent, respell: (path: string) => string): StoredContent {
  return {
    members: new Map([...stored.members].map(([path, member]) => [respell(path), member])),
    facts: stored.facts,
  };
}

/**
 * Whether a run parsing under `limits` may admit from the store: only under the
 * limits the store's facts were filed under, every one of them
 * (`POPULATION_PARSE_LIMITS`, which the store's key holds). Tighter output caps
 * would refuse a parse whose facts the store holds, and per-run refusals are
 * never stored, so no stored answer can stand for such a run.
 *
 * @param limits - The run dispatcher's resolved limits
 * @returns True when they are the population's
 */
export function hydratesUnder(limits: ParseLimits): boolean {
  return (Object.keys(POPULATION_PARSE_LIMITS) as (keyof ParseLimits)[]).every((name) => limits[name] === POPULATION_PARSE_LIMITS[name]);
}

/** What a stored realization says to do before the tier is read. */
type StoredRoute =
  /** Compute it the cold way. */
  | { readonly kind: 'compute' }
  /** Refused by its size before any read, as cold refuses it, once the file is still readable now. */
  | { readonly kind: 'not-admitted'; readonly entry: NotAdmittedEntry }
  /** Ask the tier about this key. */
  | { readonly kind: 'read'; readonly contentKey: string };

const COMPUTE = { kind: 'compute' } as const;
const NOT_ADMITTED = 'not-admitted';

/**
 * @param realization - The member's stored realization, or `undefined` when the store holds none for it
 * @param parserKind - The parser this view routes the file to
 * @returns What to do before the tier is read
 */
export function storedRoute(realization: StoredRealization | undefined, parserKind: string): StoredRoute {
  if (realization === undefined) return COMPUTE;
  if (realization.contentState === 'keyed' && realization.contentKey !== null) {
    return parserKindOf(realization.contentKey) === parserKind ? { kind: 'read', contentKey: realization.contentKey } : COMPUTE;
  }
  if (realization.contentState !== 'oversize') return COMPUTE;
  // Only a kind a parser reads is refused at the one input cap, in a sentence that names the cap.
  // One nothing parses is refused by the cold read for its size, which the store does not hold.
  const kind = parserKindForMimeType(realization.mime);
  if (kind === null || kind !== parserKind) return COMPUTE;
  const entry = unkeyedEntry(realization);
  return entry === undefined ? COMPUTE : { kind: NOT_ADMITTED, entry };
}

/** What the tier's answer for a key says to do. */
type ReadRoute =
  /** Compute it the cold way. */
  | { readonly kind: 'compute' }
  /** Admit the stored answer, once the file is still readable now. */
  | { readonly kind: 'probe'; readonly admitted: AdmittedFacts };

/**
 * @param outcome - The one fact reader's answer for the key
 * @returns What to do with it. Stored facts are deep-frozen, as the cold lane's
 *   shared parse is, so every view is handed the same contract either way
 */
export function readRoute(outcome: BlobFactsOutcome): ReadRoute {
  if (outcome.kind === 'facts') return { kind: 'probe', admitted: { kind: 'facts', facts: deepFreeze(outcome.facts) } };
  if (outcome.kind === NOT_ADMITTED) return { kind: 'probe', admitted: { kind: NOT_ADMITTED, entry: outcome.entry } };
  return COMPUTE;
}

/** The predicate that sent a member to the cold lane: its stored realization, or the tier's answer for its key. */
export type StoredComputeBy = 'storedRoute' | 'readRoute';

/** What the store's answer for one member comes to, short of the readability probe. */
export type StoredAnswer =
  /** Compute it the cold way, as `by` decided. */
  | { readonly kind: 'compute'; readonly by: StoredComputeBy }
  /** Admit the stored answer, once the file is still readable now. */
  | { readonly kind: 'probe'; readonly admitted: AdmittedFacts };

/**
 * The ONE composition of {@link storedRoute} and {@link readRoute}: what the store
 * says about one member under the parser a view routes it to, short of the
 * readability probe. A warm admission (`RunPopulation.admit`) acts on it, and
 * `vat validate`'s checks overlap gate asks it of every member before it lets
 * the checks child start early, so the gate's "admitted from the store" is
 * admission's own, never a second reading of it. The tier is read only when the
 * route asks, through the members' one memoized read, so a rejection stays there
 * for every later caller.
 *
 * @param realization - The member's stored realization, or `undefined` when the store holds none for it
 * @param parserKind - The parser the view routes the file to
 * @param facts - The members' blob tier ({@link StoredContent.facts})
 * @returns Compute, naming the predicate that said so, or the stored answer to admit once probed
 * @throws What the tier read rejected with
 */
export async function storedAnswer(
  realization: StoredRealization | undefined,
  parserKind: string,
  facts: StoredContent['facts'],
): Promise<StoredAnswer> {
  const route = storedRoute(realization, parserKind);
  if (route.kind === 'compute') return { kind: 'compute', by: 'storedRoute' };
  if (route.kind === NOT_ADMITTED) return { kind: 'probe', admitted: { kind: NOT_ADMITTED, entry: route.entry } };
  const read = readRoute((await facts())(route.contentKey));
  return read.kind === 'compute' ? { kind: 'compute', by: 'readRoute' } : read;
}
