/**
 * The `data` instance's stage: routing states, extraction outcomes, the refusal it lists, and the
 * store-on and store-off backings answering the same relations. Bytes come from an in-memory
 * reader and extraction runs the real extractor in-thread; the store is the in-memory fake.
 */

import { readWorkCounters } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { keyContent, type ContentKey, type KeyedContent, type ParserKind } from '../src/content-key.js';
import { DEFAULT_PARSE_LIMITS, ParseLimitError, ParseWorkerDiedError, type ParseLimitName } from '../src/parse-limits.js';
import { extractDataRows } from '../src/projection/data-extractor.js';
import {
  dataDemandOf,
  NO_DATA_STAGE_SEAMS,
  refusableDataRelations,
  runDataStage,
  type DataDemand,
  type DataStageContent,
  type DataStageInput,
  type DataStageProjection,
  type DataStageResult,
  type DataStageSeams,
} from '../src/projection/data-stage.js';
import { isStoredRowsEvicted } from '../src/projection/query-projection.js';
import { dataRoutingFor } from '../src/projection/router.js';
import type { RowSetId } from '../src/projection/row-set-id.js';
import type { FactStore, RowSetWrite } from '../src/projection/store.js';
import { runStoredReads } from '../src/projection/stored-reads.js';
import type { DataVariant } from '../src/schemas/projection-data.js';
import type { ContentState } from '../src/schemas/projection-resources.js';

import { FakeFactStore, WIDE_STORE_BUDGETS } from './fake-fact-store.js';

const ROOT = '/repo';
const EVERYTHING: DataDemand = { tables: ['dataFiles', 'dataDocuments', 'dataNodes', 'dataConditions'], routes: true, values: true };

/** One realization the fixture projection holds. */
interface Realized {
  readonly path: string;
  readonly state?: ContentState;
  /** The text on disk; absent for a file the reader finds gone. */
  readonly text?: string;
  /** The key the population recorded, when it differs from the text's own. */
  readonly recorded?: ContentKey;
}

/** The fixture projection: one root, one extent, the given realizations. */
function projectionOf(files: readonly Realized[]): DataStageProjection {
  return {
    roots: [{ id: 'root-1', path: ROOT }],
    resolutionContexts: [{ contextId: 'extent-1', species: 'extent', kind: 'tree', rootId: 'root-1', extentContextId: null, role: 'primary' }],
    resourceRealizations: files.map((file) => {
      const state = file.state ?? 'keyed';
      const keyed = state === 'keyed' ? file.recorded ?? keyContent(file.text ?? '', 'none').key : null;
      return { extentId: 'extent-1', path: file.path, contentState: state, contentKey: keyed, mime: 'application/json' };
    }),
  } as unknown as DataStageProjection;
}

/** A reader over the fixture's files, counting reads per path. */
function contentOf(files: readonly Realized[], reads: Map<string, number> = new Map()): DataStageContent {
  const byPath = new Map(files.map((file) => [`${ROOT}/${file.path}`, file.text]));
  const read = (absolutePath: string, parserKind: ParserKind): KeyedContent | null => {
    reads.set(absolutePath, (reads.get(absolutePath) ?? 0) + 1);
    const text = byPath.get(absolutePath);
    return text === undefined ? null : keyContent(text, parserKind);
  };
  return {
    read: ({ absolutePath }) => Promise.resolve(read(absolutePath, 'none')),
    readUnkeyed: (absolutePath, parserKind) => {
      const keyed = read(absolutePath, parserKind);
      return keyed === null ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })) : Promise.resolve(keyed);
    },
  };
}

/** The real extractor in-thread, throwing a limit as the pool does; `fail` replaces it for one variant's paths. */
function extractorOf(fail?: (variant: DataVariant, input: KeyedContent) => Error | undefined): DataStageInput['extractor'] {
  return {
    dataRows: (variant, input) => {
      const failure = fail?.(variant, input as KeyedContent);
      if (failure !== undefined) return Promise.reject(failure);
      const extraction = extractDataRows({ text: input.content, variant, bom: input.decoding.encodingSource === 'bom' }, DEFAULT_PARSE_LIMITS);
      if (extraction.outcome === 'breach') return Promise.reject(new ParseLimitError(extraction.limit, DEFAULT_PARSE_LIMITS[extraction.limit], extraction.found));
      return Promise.resolve(extraction);
    },
  };
}

/** Run the stage over `files`, store off unless a store is given. */
function stage(
  files: readonly Realized[],
  options: {
    readonly demand?: DataDemand;
    readonly store?: FactStore;
    readonly reads?: ReturnType<typeof runStoredReads>;
    readonly extractor?: DataStageInput['extractor'];
    readonly seams?: DataStageSeams;
    readonly routing?: DataStageInput['routing'];
  } = {},
): Promise<DataStageResult> {
  const { store } = options;
  return runDataStage({
    demand: options.demand ?? EVERYTHING,
    projection: projectionOf(files),
    routing: options.routing ?? dataRoutingFor(undefined),
    content: contentOf(files),
    extractor: options.extractor ?? extractorOf(),
    store: store === undefined ? undefined : { store, reads: (options.reads ?? runStoredReads()).of(store) },
    seams: options.seams ?? NO_DATA_STAGE_SEAMS,
  });
}

/** The staged answer, failing on examined-nothing. */
function staged(result: DataStageResult): Extract<DataStageResult, { outcome: 'staged' }> {
  if (result.outcome !== 'staged') throw new Error(`expected a staged answer, got ${JSON.stringify(result)}`);
  return result;
}

/** The counters a call moved. */
async function countersMovedBy(work: () => Promise<unknown>): Promise<Record<string, number>> {
  const before = readWorkCounters();
  await work();
  const after = readWorkCounters();
  return Object.fromEntries(Object.entries(after).filter(([name]) => name.startsWith('rowSet.')).map(([name, value]) => [name, value - (before[name as keyof typeof before] ?? 0)]));
}

const PACKAGE = '{\n  "name": "a",\n  "name": "b",\n  "version": "1.0.0"\n}\n';
const TSCONFIG = '{\n  // comment\n  "compilerOptions": { "strict": true, },\n}\n';

describe('dataDemandOf', () => {
  it('is undefined when no relation of the instance is named, and names exactly what is', () => {
    expect(dataDemandOf(new Set(['blobs', 'edges']))).toBeUndefined();
    expect(dataDemandOf(new Set(['data__nodes', 'data__files']))).toStrictEqual({ tables: ['dataFiles', 'dataNodes'], routes: false, values: false });
    expect(dataDemandOf(new Set(['data__values']))).toStrictEqual({ tables: [], routes: false, values: true });
    expect(dataDemandOf(new Set(['data__routes']))).toStrictEqual({ tables: [], routes: true, values: false });
  });

  it('can refuse every data relation but data__routes', () => {
    expect([...refusableDataRelations()].sort((a, b) => a.localeCompare(b))).toStrictEqual(['data__conditions', 'data__documents', 'data__files', 'data__nodes', 'data__values']);
  });
});

describe('runDataStage: routing states', () => {
  it('routes by path and gives each content state its pair state', async () => {
    const result = staged(await stage([
      { path: 'package.json', text: '{"name":"a"}' },
      { path: 'packages/x/package.json', state: 'unreadable' },
      { path: 'big/package.json', state: 'oversize' },
      { path: 'dangling/package.json', state: 'none' },
      { path: 'gitignored/package.json', state: 'deferred', text: '{"name":"d"}' },
      { path: 'gone/package.json', state: 'deferred' },
      { path: 'README.md', text: '# not data' },
    ]));
    expect(result.derived.dataRoutes?.map(({ path, state, code, variant }) => ({ path, state, code, variant }))).toStrictEqual([
      { path: 'package.json', state: 'facts', code: null, variant: 'json' },
      { path: 'packages/x/package.json', state: 'refused', code: 'BLOB_UNREADABLE', variant: 'json' },
      { path: 'big/package.json', state: 'defective', code: 'PARSE_LIMIT_EXCEEDED', variant: 'json' },
      { path: 'gitignored/package.json', state: 'facts', code: null, variant: 'json' },
      { path: 'gone/package.json', state: 'refused', code: 'BLOB_UNREADABLE', variant: 'json' },
    ]);
    expect(result.derived.dataRoutes?.[3]?.blob).toBe(keyContent('{"name":"d"}', 'none').key);
    expect(result.derived.dataRoutes?.every((row) => row.root === 'root-1')).toBe(true);
  });

  it('names each extraction failure by its state and code', async () => {
    const changed = keyContent('{"was": 1}', 'none').key;
    const limitOn = (limit: ParseLimitName) => (_variant: DataVariant, input: KeyedContent): Error | undefined =>
      input.content.includes(limit) ? new ParseLimitError(limit, 1) : undefined;
    const result = staged(await stage([
      { path: 'malformed/package.json', text: '{"a": }' },
      { path: 'strict/package.json', text: '{"a": 1 /* no */}' },
      { path: 'binary/package.json', text: '{"a": "\u0000"}' },
      { path: 'changed/package.json', text: '{"is": 2}', recorded: changed },
      { path: 'rows/package.json', text: '{"outputRows": 1}' },
      { path: 'time/package.json', text: '{"timeMs": 1}' },
      { path: 'died/package.json', text: '{"died": 1}' },
    ], {
      extractor: extractorOf((variant, input) => {
        if (input.content.includes('died')) return new ParseWorkerDiedError({ exitCode: 1 });
        return limitOn('outputRows')(variant, input) ?? limitOn('timeMs')(variant, input);
      }),
    }));
    expect(result.derived.dataRoutes?.map(({ path, state, code }) => `${path} ${state} ${code ?? ''}`)).toStrictEqual([
      'malformed/package.json defective DATA_PARSE_ERROR',
      'strict/package.json defective DATA_PARSE_ERROR',
      'binary/package.json defective BLOB_NOT_TEXT',
      'changed/package.json refused BLOB_CONTENT_CHANGED',
      'rows/package.json defective PARSE_LIMIT_EXCEEDED',
      'time/package.json refused PARSE_LIMIT_EXCEEDED',
      'died/package.json refused PARSE_WORKER_DIED',
    ]);
  });

  it('refuses CONFIG_INVALID-worthy emptiness only when the instance is declared and not allowEmpty', async () => {
    const files = [{ path: 'README.md', text: '# none' }];
    expect((await stage(files)).outcome).toBe('staged');
    expect((await stage(files, { routing: dataRoutingFor({ resources: { extractors: { data: {} } } }) })).outcome).toBe('examined-nothing');
    expect((await stage(files, { routing: dataRoutingFor({ resources: { extractors: { data: { allowEmpty: true } } } }) })).outcome).toBe('staged');
  });
});

describe('runDataStage: the refusal it lists', () => {
  it('lists every pair that is not facts, INPUT_UNREADABLE when any is defective, and builds no data__values', async () => {
    const result = staged(await stage([
      { path: 'package.json', text: '{"name":"a"}' },
      { path: 'bad/package.json', text: '{' },
      { path: 'x/package.json', state: 'unreadable' },
    ]));
    expect(result.refusal?.refusal).toBe('INPUT_UNREADABLE');
    expect(result.refusal?.pairs.map(({ path, state, code }) => ({ path, state, code }))).toStrictEqual([
      { path: 'bad/package.json', state: 'defective', code: 'DATA_PARSE_ERROR' },
      { path: 'x/package.json', state: 'refused', code: 'BLOB_UNREADABLE' },
    ]);
    expect(result.refusal?.pairs[0]?.remedy).toMatch(/exclude/u);
    expect(result.refusal?.pairs[0]?.detail).not.toBe('DATA_PARSE_ERROR');
    expect(result.derived.dataValues).toBeUndefined();
    expect(result.derived.dataRoutes).toHaveLength(3);
  });

  it('is RUN_INCOMPLETE when every failed pair is refused, and absent when all are facts', async () => {
    expect(staged(await stage([{ path: 'x/package.json', state: 'unreadable' }])).refusal?.refusal).toBe('RUN_INCOMPLETE');
    expect(staged(await stage([{ path: 'package.json', text: '{}' }])).refusal).toBeUndefined();
  });

  it('counts each failed pair once in rowSet.refused, and each extraction in rowSet.extracted', async () => {
    const moved = await countersMovedBy(() => stage([
      { path: 'a/package.json', text: '{"a":1}' },
      { path: 'b/package.json', text: '{"a":1}' },
      { path: 'c/package.json', text: '{' },
      { path: 'd/package.json', text: '{' },
      { path: 'e/package.json', state: 'unreadable' },
    ]));
    expect(moved).toStrictEqual({ 'rowSet.extracted': 1, 'rowSet.storeServed': 0, 'rowSet.refused': 2, 'rowSet.rows.decoded': 0 });
  });
});

/** A clean corpus: duplicate keys, a JSONC file, and the same bytes read under both variants. */
const CLEAN: readonly Realized[] = [
  { path: 'package.json', text: PACKAGE },
  { path: 'tsconfig.json', text: TSCONFIG },
  { path: 'packages/a/package.json', text: '{"name": "a", "nested": {"list": [1, 1.0, "x"]}}' },
  { path: 'packages/a/tsconfig.json', text: '{"name": "a", "nested": {"list": [1, 1.0, "x"]}}' },
];

describe('runDataStage: store on and store off', () => {
  it('answers data__routes and data__values identically on both backings, cold and warm', async () => {
    const off = staged(await stage(CLEAN));
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const cold = staged(await stage(CLEAN, { store }));
    const warm = staged(await stage(CLEAN, { store }));
    expect(off.refusal).toBeUndefined();
    for (const arm of [cold, warm]) {
      expect(arm.derived).toStrictEqual(off.derived);
      expect(arm.refusal).toBeUndefined();
    }
    expect(off.derived.dataValues?.filter((row) => row.path === 'package.json' && row.pointer === '/name')).toStrictEqual([
      expect.objectContaining({ value: 'b' }),
    ]);
  });

  it('hands rows in hand store off and a copy of exactly the facts row sets store on', async () => {
    const off = staged(await stage(CLEAN));
    expect(off.sources.get('dataNodes')).toStrictEqual({ rows: expect.any(Array) });
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const on = staged(await stage([...CLEAN, { path: 'bad/package.json', text: '{' }], { store }));
    const source = on.sources.get('dataNodes');
    if (source === undefined || !('stored' in source)) throw new Error('expected a stored source');
    expect(source.stored.store).toBe(store);
    expect(source.stored.ids.map((id) => `${id.variant}`)).toStrictEqual(['json', 'jsonc', 'json', 'jsonc']);
    expect([...on.sources.keys()]).toStrictEqual(['dataFiles', 'dataDocuments', 'dataNodes', 'dataConditions']);
  });

  it('extracts cold and serves warm: decoded head rows only, then the extending node read', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const ids = 4;
    const cold = await countersMovedBy(() => stage(CLEAN, { store, demand: { tables: ['dataNodes'], routes: true, values: false } }));
    expect(cold).toMatchObject({ 'rowSet.extracted': ids, 'rowSet.storeServed': 0, 'rowSet.rows.decoded': ids });
    const warm = await countersMovedBy(() => stage(CLEAN, { store, demand: { tables: ['dataNodes'], routes: true, values: false } }));
    expect(warm).toMatchObject({ 'rowSet.extracted': 0, 'rowSet.storeServed': ids, 'rowSet.rows.decoded': ids });
    expect(store.writeRowSetsCalls).toBe(1);
  });

  it('writes the head rows of what it was served beside what it extracted, listed as covered', async () => {
    const writes: RowSetWrite[] = [];
    const store = new (class extends FakeFactStore {
      override writeRowSets(write: RowSetWrite): Promise<void> {
        writes.push(write);
        return super.writeRowSets(write);
      }
    })(WIDE_STORE_BUDGETS);
    await stage(CLEAN.slice(0, 1), { store });
    await stage(CLEAN.slice(0, 2), { store });
    const write = writes[1];
    expect(write?.coveredAtRead.map((id) => id.variant)).toStrictEqual(['json']);
    expect(write?.rows.dataFiles?.map((row) => row.variant).sort((a, b) => a.localeCompare(b))).toStrictEqual(['json', 'jsonc']);
  });
});

describe('runDataStage: a row set gone from the store refuses the attempt by tier', () => {
  it('names the row set evicted between the coverage read and the data__values node read', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    await stage(CLEAN, { store });
    let evicted: RowSetId | undefined;
    const seams: DataStageSeams = {
      afterWrite: () => undefined,
      beforeValues: (facts) => {
        evicted = facts[0];
        if (evicted !== undefined) store.forgetRowSet(evicted);
      },
    };
    const thrown = await stage(CLEAN, { store, seams }).catch((error: unknown) => error);
    expect(isStoredRowsEvicted(thrown), String(thrown)).toBe(true);
    if (!isStoredRowsEvicted(thrown) || thrown.eviction.tier !== 'rowSet') throw new Error('expected a row-set eviction');
    expect(thrown.eviction.ids).toStrictEqual([evicted]);
    expect(thrown.eviction.relation).toBe('data__values');
  });

  it('names a written row set the read-back finds gone', async () => {
    const dropping = new (class extends FakeFactStore {
      override async writeRowSets(write: RowSetWrite): Promise<void> {
        await super.writeRowSets(write);
        const [head] = write.rows.dataFiles ?? [];
        if (head !== undefined) this.forgetRowSet({ contentKey: head.blob, instance: 'data', variant: head.variant });
      }
    })(WIDE_STORE_BUDGETS);
    const thrown = await stage(CLEAN.slice(0, 1), { store: dropping }).catch((error: unknown) => error);
    expect(isStoredRowsEvicted(thrown) && thrown.eviction.tier === 'rowSet' ? thrown.eviction.ids.length : 0).toBe(1);
  });

  it('runs the after-write seam with the facts row sets, after the read-back', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const seen: RowSetId[][] = [];
    const result = staged(await stage(CLEAN, { store, seams: { afterWrite: (facts) => seen.push([...facts]), beforeValues: () => undefined } }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.length).toBe(4);
    expect(result.refusal).toBeUndefined();
  });
});
