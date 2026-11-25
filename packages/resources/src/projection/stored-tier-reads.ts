/**
 * The one reader of the stored blob tier for one population: a store hit's read and, when the hit
 * turns into a miss, the derivation's reads all go through it, so no row is decoded twice.
 *
 * Each key's part of a request that an earlier read through the reader already decoded is not read
 * again: a key read under the query lane's narrowed request (the AST reference forms) and then
 * asked for by a derivation (every form) reads only the forms it lacks. A key asked under a request
 * it already holds reads nothing.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';

import { ReferenceSyntacticFormSchema, type ReferenceSyntacticForm } from '../schemas/projection-blobs.js';

import { EMPTY_STORED_TIER, emptyBlobRows, storedBlobTier, type StoredBlobTier } from './store-hydration.js';
import type { BlobRequest, BlobScopedRows, BlobScopedTableName, FactStore } from './store.js';
import { readBlobTier } from './stored-admission.js';

/** The `blobReferences` table, the one whose rows a request narrows by form. */
const REFERENCES: BlobScopedTableName = 'blobReferences';

/** Every reference form. */
const EVERY_FORM: ReadonlySet<ReferenceSyntacticForm> = new Set(ReferenceSyntacticFormSchema.options);

/** What the reader has decoded of one key: its tables, and of `blobReferences` its forms. */
interface HeldRead {
  readonly tables: ReadonlySet<BlobScopedTableName>;
  readonly forms: ReadonlySet<ReferenceSyntacticForm>;
}

/**
 * The stored blob tier one population reads: a hit's keys under the hit's request, the derivation's
 * base keys, and any key a demand promotion added, each decoded once.
 */
export interface StoredTierReads {
  /** Every read so far, as one tier. */
  current(): StoredBlobTier;
  /**
   * Read, of each key, the part of `request` no earlier read through this reader decoded; nothing
   * when every key already holds it.
   *
   * @param contentKeys - The keys the caller now holds
   * @param request - The tables and reference forms the caller consumes
   * @returns Every read so far, as one tier
   */
  cover(contentKeys: readonly string[], request: BlobRequest<BlobScopedTableName>): Promise<StoredBlobTier>;
}

/**
 * The forms a request names.
 *
 * @param request - The request
 * @returns Its `blobReferences` forms, `'all'` expanded; none when it does not name the table
 */
function formsOf(request: BlobRequest<BlobScopedTableName>): ReadonlySet<ReferenceSyntacticForm> {
  if (!request.tables.includes(REFERENCES)) return new Set();
  return request.referenceForms === 'all' ? EVERY_FORM : request.referenceForms;
}

/**
 * The part of `request` a key's earlier reads did not decode.
 *
 * @param request - What the caller consumes
 * @param held - What the reader decoded of the key, if anything
 * @returns The request still to read, or `undefined` when the key holds all of it
 */
function remainderOf(request: BlobRequest<BlobScopedTableName>, held: HeldRead | undefined): BlobRequest<BlobScopedTableName> | undefined {
  if (held === undefined) return request;
  const forms = new Set([...formsOf(request)].filter((form) => !held.forms.has(form)));
  const tables = request.tables.filter((table) => (table === REFERENCES ? forms.size > 0 : !held.tables.has(table)));
  return tables.length === 0 ? undefined : { tables, referenceForms: forms };
}

/**
 * A request's identity, so the keys that lack the same remainder are read together.
 *
 * @param request - A remainder
 * @returns Its tables and forms, sorted
 */
function requestId(request: BlobRequest<BlobScopedTableName>): string {
  return `${[...request.tables].sort(compareCodeUnits).join(',')}|${[...formsOf(request)].sort(compareCodeUnits).join(',')}`;
}

/**
 * One read's rows, every blob-scoped table present: the tables it did not name are empty.
 *
 * @param rows - What `readBlobTier` returned
 * @returns The rows as a whole bundle
 */
function wholeRows(rows: Partial<BlobScopedRows>): BlobScopedRows {
  return { ...emptyBlobRows(), ...rows };
}

/**
 * Two reads' rows as one, table by table: the reads decoded disjoint rows (other keys, or other
 * forms or tables of the same keys).
 *
 * @param first - The rows held so far
 * @param second - A read's rows
 * @returns Both, `first`'s rows first
 */
function joinRows(first: BlobScopedRows, second: BlobScopedRows): BlobScopedRows {
  const left = first as unknown as Record<string, readonly unknown[]>;
  const right = second as unknown as Record<string, readonly unknown[]>;
  const rows: Record<string, unknown[]> = {};
  for (const table of Object.keys(left)) rows[table] = [...(left[table] ?? []), ...(right[table] ?? [])];
  return rows as unknown as BlobScopedRows;
}

/**
 * The tier reader of one population, over `store`.
 *
 * @param store - The run's store, or undefined for a run with none (or that parses no content): nothing is read
 * @returns The reader
 */
export function storedTierReads(store: FactStore | undefined): StoredTierReads {
  const held = new Map<string, HeldRead>();
  let tier = EMPTY_STORED_TIER;
  return {
    current: () => tier,
    cover: async (contentKeys, request) => {
      if (store === undefined) return tier;
      const pending = new Map<string, { readonly request: BlobRequest<BlobScopedTableName>; readonly keys: string[] }>();
      for (const key of new Set(contentKeys)) {
        const remainder = remainderOf(request, held.get(key));
        if (remainder === undefined) continue;
        const id = requestId(remainder);
        const group = pending.get(id) ?? { request: remainder, keys: [] };
        group.keys.push(key);
        pending.set(id, group);
      }
      if (pending.size === 0) return tier;
      const groups = [...pending.values()];
      const reads = await Promise.all(groups.map(({ request: remainder, keys }) => readBlobTier(store, keys, remainder)));
      let rows = tier.rows;
      for (const [index, { request: remainder, keys }] of groups.entries()) {
        rows = joinRows(rows, wholeRows(reads[index] ?? {}));
        for (const key of keys) {
          const before = held.get(key);
          held.set(key, {
            tables: new Set([...(before?.tables ?? []), ...remainder.tables]),
            forms: new Set([...(before?.forms ?? []), ...formsOf(remainder)]),
          });
        }
      }
      // The one predicate, over every row held for every key asked: a key's coverage is judged on
      // all its rows, whichever reads decoded them.
      tier = storedBlobTier(rows, [...held.keys()]);
      return tier;
    },
  };
}
