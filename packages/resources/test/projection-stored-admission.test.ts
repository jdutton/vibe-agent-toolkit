/**
 * The warm admission decision: every branch of whether a registry admits a file
 * from what the store holds about it, or computes it the cold way.
 *
 * Pure: no store, no file. That a warm registry built through these branches
 * equals the cold one is the integration suites' job (`run-population-hydration`
 * here, `warm-registry-hydration` in projection-sqlite).
 */

import { describe, expect, it } from 'vitest';

import type { ContentKey } from '../src/content-key.js';
import { parseRefusal } from '../src/not-admitted.js';
import { ParseLimitError } from '../src/parse-limits.js';
import { AST_SYNTACTIC_FORMS } from '../src/projection/blob-references.js';
import { BLOB_FACT_READER_TABLES, type BlobFactsOutcome, type BlobFactsReader, type BlobResourceFacts } from '../src/projection/blob-resource-facts.js';
import { POPULATION_PARSE_LIMITS } from '../src/projection/content-cache.js';
import { emptyBlobRows, STORE_REQUEST_UNMET } from '../src/projection/store-hydration.js';
import type { BlobFactsRead, BlobRequest, BlobScopedRows, BlobScopedTableName, FactStore } from '../src/projection/store.js';
import {
  ADMISSION_BLOB_REQUEST,
  hydratesUnder,
  readRoute,
  respelledContent,
  storedComputeBy,
  storedContentOf,
  storedRoute,
  type StoredRealization,
} from '../src/projection/stored-admission.js';
import { runStoredReads } from '../src/projection/stored-reads.js';
import type { ResourceRealizationRow } from '../src/schemas/projection-resources.js';
import { testContentKey } from '../src/testing.js';

import { noDatabaseFile } from './fake-fact-store.js';
import { readNoRowSets, writeNoRowSets } from './helpers/no-row-sets.js';

const MARKDOWN_KEY = testContentKey('markdown', 'a');
const NONE_KEY = testContentKey('none', 'b');
const COMPUTE = { kind: 'compute' };

const keyed = (contentKey: ContentKey, mime: string): StoredRealization => ({ contentKey, contentState: 'keyed', mime });
const unkeyed = (contentState: StoredRealization['contentState'], mime: string | null): StoredRealization => ({ contentKey: null, contentState, mime });

describe('storedRoute: before the tier is read', () => {
  it('computes a path the store holds no realization for', () => {
    expect(storedRoute(undefined, 'markdown')).toEqual(COMPUTE);
  });

  it('reads the tier for a keyed realization routed to this view\'s parser', () => {
    expect(storedRoute(keyed(MARKDOWN_KEY, 'text/markdown'), 'markdown')).toEqual({ kind: 'read', contentKey: MARKDOWN_KEY });
    expect(storedRoute(keyed(NONE_KEY, 'application/json'), 'none')).toEqual({ kind: 'read', contentKey: NONE_KEY });
  });

  it('computes a keyed realization whose key names another parser than this view\'s', () => {
    // A view whose collections route the file elsewhere asks another question of the same bytes.
    expect(storedRoute(keyed(MARKDOWN_KEY, 'text/markdown'), 'none')).toEqual(COMPUTE);
    expect(storedRoute(keyed(NONE_KEY, 'text/plain'), 'markdown')).toEqual(COMPUTE);
  });

  it('states an oversize realization of a parsed kind as the cold input-cap refusal, without a read', () => {
    const route = storedRoute(unkeyed('oversize', 'text/markdown'), 'markdown');
    expect(route).toEqual({
      kind: 'not-admitted',
      entry: { log: 'parseRefused', entry: parseRefusal(new ParseLimitError('inputBytes', POPULATION_PARSE_LIMITS.inputBytes)) },
    });
  });

  it('computes an oversize realization nothing parses: the cold refusal states its size, which the store does not hold', () => {
    expect(storedRoute(unkeyed('oversize', 'text/csv'), 'none')).toEqual(COMPUTE);
  });

  it('computes an oversize realization routed to another parser than this view\'s', () => {
    // Under another parser the cold read caps differently (a kind nothing parses has no input cap).
    expect(storedRoute(unkeyed('oversize', 'text/markdown'), 'none')).toEqual(COMPUTE);
    expect(storedRoute(unkeyed('oversize', 'text/csv'), 'markdown')).toEqual(COMPUTE);
  });

  it('computes every other state: the cold read is the answer', () => {
    for (const state of ['unreadable', 'deferred', 'none'] as const) {
      expect(storedRoute(unkeyed(state, 'text/markdown'), 'markdown'), state).toEqual(COMPUTE);
    }
  });
});

describe('readRoute: what the tier\'s answer means', () => {
  const facts = (): BlobResourceFacts => ({ contentKey: MARKDOWN_KEY, links: [], headings: [], frontmatter: { id: 'a' } } as unknown as BlobResourceFacts);

  it('admits the stored facts once probed, deep-frozen as the cold lane\'s parse is', () => {
    const route = readRoute({ kind: 'facts', facts: facts(), decoding: { encoding: 'utf-8', encodingSource: 'assumed' } });
    expect(route).toEqual({ kind: 'probe', admitted: { kind: 'facts', facts: facts() } });
    const admitted = route.kind === 'probe' && route.admitted.kind === 'facts' ? route.admitted.facts : undefined;
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted?.frontmatter)).toBe(true);
  });

  it('admits the stated not-admitted entry once probed', () => {
    const entry = { log: 'unreadable', entry: { reason: 'the parser threw', code: 'EFOO' } } as const;
    expect(readRoute({ kind: 'not-admitted', entry })).toEqual({ kind: 'probe', admitted: { kind: 'not-admitted', entry } });
  });

  it('computes a key the tier does not cover: per-key fallback', () => {
    expect(readRoute({ kind: 'uncovered', reason: 'evicted' })).toEqual(COMPUTE);
  });
});

describe('storedComputeBy: the two routes, asked route-only', () => {
  const tier = (outcome: BlobFactsOutcome): { asked: string[]; built: number; facts: () => Promise<BlobFactsReader> } => {
    const probe = {
      asked: [] as string[],
      built: 0,
      facts: (): Promise<BlobFactsReader> => Promise.resolve({
        outcome: () => {
          probe.built += 1;
          return outcome;
        },
        answer: (key: string) => {
          probe.asked.push(key);
          return { kind: outcome.kind, rowsRead: 3 };
        },
      }),
    };
    return probe;
  };

  it('names storedRoute when the realization alone sends the member cold, without reading the tier', async () => {
    const probe = tier({ kind: 'uncovered', reason: 'unused' });
    expect(await storedComputeBy(unkeyed('unreadable', 'text/markdown'), 'markdown', probe.facts)).toEqual({ computeBy: 'storedRoute', rowsRead: 0 });
    expect(probe.asked).toEqual([]);
  });

  it('serves an oversize realization of a parsed kind without reading the tier', async () => {
    const probe = tier({ kind: 'uncovered', reason: 'unused' });
    expect(await storedComputeBy(unkeyed('oversize', 'text/markdown'), 'markdown', probe.facts)).toEqual({ computeBy: null, rowsRead: 0 });
    expect(probe.asked).toEqual([]);
  });

  it('names readRoute when the tier does not cover the key, counting the rows it read', async () => {
    const probe = tier({ kind: 'uncovered', reason: 'evicted' });
    expect(await storedComputeBy(keyed(MARKDOWN_KEY, 'text/markdown'), 'markdown', probe.facts)).toEqual({ computeBy: 'readRoute', rowsRead: 3 });
    expect(probe.asked).toEqual([MARKDOWN_KEY]);
  });

  it('serves a covered key (facts or a stated refusal) building nothing, and hands back the tier\'s rejection unchanged', async () => {
    const entry = { log: 'unreadable', entry: { reason: 'the parser threw', code: 'EFOO' } } as const;
    for (const outcome of [{ kind: 'not-admitted', entry }, { kind: 'facts', facts: {} as BlobResourceFacts, decoding: null }] as const) {
      const probe = tier(outcome);
      expect(await storedComputeBy(keyed(MARKDOWN_KEY, 'text/markdown'), 'markdown', probe.facts), outcome.kind).toEqual({ computeBy: null, rowsRead: 3 });
      expect(probe.built).toBe(0);
    }
    const refused = new Error('tier refused');
    await expect(storedComputeBy(keyed(MARKDOWN_KEY, 'text/markdown'), 'markdown', () => Promise.reject(refused))).rejects.toBe(refused);
  });

  it('agrees with readRoute on every kind the tier answers', async () => {
    const entry = { log: 'unreadable', entry: { reason: 'the parser threw', code: 'EFOO' } } as const;
    const outcomes: BlobFactsOutcome[] = [{ kind: 'facts', facts: {} as BlobResourceFacts, decoding: null }, { kind: 'not-admitted', entry }, { kind: 'uncovered', reason: 'evicted' }];
    for (const outcome of outcomes) {
      const answer = await storedComputeBy(keyed(MARKDOWN_KEY, 'text/markdown'), 'markdown', tier(outcome).facts);
      expect(answer.computeBy === null, outcome.kind).toBe(readRoute(outcome).kind === 'probe');
    }
  });
});

describe('hydratesUnder: the limits the store\'s facts were filed under', () => {
  it('hydrates under the population\'s limits alone', () => {
    expect(hydratesUnder({ ...POPULATION_PARSE_LIMITS })).toBe(true);
    expect(hydratesUnder({ ...POPULATION_PARSE_LIMITS, outputRows: POPULATION_PARSE_LIMITS.outputRows - 1 })).toBe(false);
    expect(hydratesUnder({ ...POPULATION_PARSE_LIMITS, timeMs: POPULATION_PARSE_LIMITS.timeMs + 1 })).toBe(false);
  });
});

/**
 * A store that answers every blob read with empty rows, or rejects with `fails`, and counts the reads.
 *
 * @param fails - What every blob read rejects with, or `undefined` to answer
 * @returns The store, the keys each read asked for, and what each read asked for of them
 */
function countingStore(fails?: Error): { store: FactStore; reads: (readonly string[])[]; requests: BlobRequest<BlobScopedTableName>[] } {
  const reads: (readonly string[])[] = [];
  const requests: BlobRequest<BlobScopedTableName>[] = [];
  const store: FactStore = {
    readBlobFacts: (keys, request) => {
      reads.push(keys);
      requests.push(request);
      return fails === undefined ? Promise.resolve({ rows: emptyBlobRows(), present: new Set() }) : Promise.reject(fails);
    },
    writeBlobFacts: () => Promise.resolve(),
    readRowSets: readNoRowSets,
    writeRowSets: writeNoRowSets,
    readExtent: () => Promise.resolve(undefined),
    writeExtent: () => Promise.resolve(),
    close: () => Promise.resolve(),
    attachedTo: noDatabaseFile,
  };
  return { store, reads, requests };
}

/**
 * @param path - The member's absolute path
 * @param realization - Its content columns
 * @returns A member as a hit hands it
 */
function member(path: string, realization: StoredRealization): { path: string; row: ResourceRealizationRow } {
  return { path, row: realization as ResourceRealizationRow };
}

describe('ADMISSION_BLOB_REQUEST: what the admission reads of the tier', () => {
  it('is the reader\'s tables and the AST forms, never a copy of either', () => {
    expect(ADMISSION_BLOB_REQUEST.tables).toBe(BLOB_FACT_READER_TABLES);
    expect(ADMISSION_BLOB_REQUEST.referenceForms).toBe(AST_SYNTACTIC_FORMS);
    // Literal, not the constant: the harness tables are not the reader's.
    expect(ADMISSION_BLOB_REQUEST.tables).not.toContain('harnessBlobFacts');
    expect(ADMISSION_BLOB_REQUEST.tables).not.toContain('harnessBlobImports');
  });

  it('cannot be changed at run time, since every caller shares it', () => {
    const forms = ADMISSION_BLOB_REQUEST.referenceForms as Set<string>;
    const [first] = [...forms];
    const before = [...forms];
    expect(Object.isFrozen(ADMISSION_BLOB_REQUEST)).toBe(true);
    expect(Object.isFrozen(ADMISSION_BLOB_REQUEST.tables)).toBe(true);
    expect(() => forms.add('not-a-form')).toThrow(TypeError);
    expect(() => forms.delete(first ?? '')).toThrow(TypeError);
    expect(() => forms.clear()).toThrow(TypeError);
    expect([...forms]).toEqual(before);
  });
});

describe('storedContentOf: the members\' stored content', () => {
  it('reads the tier once, for the keyed members alone, and only when asked', async () => {
    const { store, reads, requests } = countingStore();
    const stored = storedContentOf([
      member('/r/a.md', keyed(MARKDOWN_KEY, 'text/markdown')),
      member('/r/b.md', keyed(MARKDOWN_KEY, 'text/markdown')),
      member('/r/c.json', keyed(NONE_KEY, 'application/json')),
      member('/r/big.md', unkeyed('oversize', 'text/markdown')),
    ], runStoredReads().of(store));
    expect(reads, 'nothing asked yet').toEqual([]);
    const [first, second] = await Promise.all([stored.facts(), stored.facts()]);
    await stored.facts();
    expect(reads).toEqual([[MARKDOWN_KEY, NONE_KEY]]);
    expect(requests).toEqual([ADMISSION_BLOB_REQUEST]);
    expect(first).toBe(second);
    const outcome: BlobFactsOutcome = first.outcome(MARKDOWN_KEY);
    expect(outcome.kind).toBe('uncovered');
  });

  it('lets the first realization of a path speak for it', () => {
    const { store } = countingStore();
    const stored = storedContentOf([
      member('/r/a.md', keyed(MARKDOWN_KEY, 'text/markdown')),
      member('/r/a.md', unkeyed('unreadable', 'text/markdown')),
    ], runStoredReads().of(store));
    expect(stored.members.get('/r/a.md')).toEqual(keyed(MARKDOWN_KEY, 'text/markdown'));
  });

  it('respells every path and shares the one tier read', async () => {
    const { store, reads } = countingStore();
    const stored = storedContentOf([member('/tmp/r/a.md', keyed(MARKDOWN_KEY, 'text/markdown'))], runStoredReads().of(store));
    const respelled = respelledContent(stored, (path) => path.replace('/tmp/', '/private/tmp/'));
    expect([...respelled.members.keys()]).toEqual(['/private/tmp/r/a.md']);
    await respelled.facts();
    await stored.facts();
    expect(reads).toHaveLength(1);
  });

  it('rejects a failed tier read as the store\'s, never as a file\'s errno', async () => {
    const errno = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT', syscall: 'open', path: '/store/blobs' });
    const { store } = countingStore(errno);
    const stored = storedContentOf([member('/r/a.md', keyed(MARKDOWN_KEY, 'text/markdown'))], runStoredReads().of(store));
    await expect(stored.facts()).rejects.toMatchObject({ code: 'PROJECTION_STORE_READ_FAILED', cause: errno });
  });

  it('refuses, by code, a store that answers without a requested table, never reading it as empty', async () => {
    const withoutOne = Object.fromEntries(Object.entries(emptyBlobRows()).filter(([table]) => table !== 'skillTextMatches'));
    const store: FactStore = { ...countingStore().store, readBlobFacts: () => Promise.resolve({ rows: withoutOne as BlobScopedRows, present: new Set() }) };
    const stored = storedContentOf([member('/r/a.md', keyed(MARKDOWN_KEY, 'text/markdown'))], runStoredReads().of(store));
    await expect(stored.facts()).rejects.toMatchObject({ code: STORE_REQUEST_UNMET, tier: 'blob', table: 'skillTextMatches' });
  });

  it('refuses, by code, a store that answers without its presence, never inferring it from the rows', async () => {
    // A backend is code outside the reader: an answer typed whole may still arrive without `present`.
    const rowsOnly: unknown = { rows: emptyBlobRows() };
    const store: FactStore = { ...countingStore().store, readBlobFacts: () => Promise.resolve(rowsOnly as BlobFactsRead<BlobScopedTableName>) };
    const stored = storedContentOf([member('/r/a.md', keyed(MARKDOWN_KEY, 'text/markdown'))], runStoredReads().of(store));
    await expect(stored.facts()).rejects.toMatchObject({ code: STORE_REQUEST_UNMET, tier: 'blob', table: 'present' });
  });

  it('refuses, as the store\'s read, a stored row whose key column holds no content key, never dropping the row', async () => {
    // A damaged store, as an untyped source hands it: the row's key column is text no parser admits.
    const answer = JSON.stringify({ ...emptyBlobRows(), blobs: [{ contentKey: 'markdown.sha256.not-hex' }] });
    const damaged: BlobScopedRows = JSON.parse(answer);
    const store: FactStore = { ...countingStore().store, readBlobFacts: () => Promise.resolve({ rows: damaged, present: new Set() }) };
    const stored = storedContentOf([member('/r/a.md', keyed(MARKDOWN_KEY, 'text/markdown'))], runStoredReads().of(store));
    await expect(stored.facts()).rejects.toMatchObject({
      code: 'PROJECTION_STORE_READ_FAILED',
      cause: { message: 'a stored blobs row\'s contentKey is "markdown.sha256.not-hex", not a content key' },
    });
  });

  it('names the remedy: the store is a cache, so clear it or move it', async () => {
    const { store } = countingStore(new Error('database disk image is malformed'));
    const stored = storedContentOf([member('/r/a.md', keyed(MARKDOWN_KEY, 'text/markdown'))], runStoredReads().of(store));
    await expect(stored.facts()).rejects.toThrow(/database disk image is malformed.*`vat cache clear`.*VAT_CACHE_DIR/s);
  });
});
