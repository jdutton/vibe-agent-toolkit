/**
 * The `data` instance's stage: routing states, extraction outcomes, the defects it lists, and the
 * store-on and store-off backings answering the same relations. Bytes come from an in-memory
 * reader and extraction runs the real extractor in-thread; the store is the in-memory fake.
 */

import { safePath, toForwardSlash, type FsFaultClass } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { keyContent, type KeyedContent } from '../src/content-key.js';
import { ParseLimitError, ParseWorkerDiedError, type ParseLimitName, resolveDataOutputCaps } from '../src/parse-limits.js';
import { NO_GIT_MEMBERS, RunContentCache } from '../src/projection/content-cache.js';
import { extractDataRows } from '../src/projection/data-extractor.js';
import { dataDefectIssues, dataDemandOf, NO_DATA_STAGE_SEAMS, type DataStageSeams } from '../src/projection/data-stage.js';
import { isStoredRowsEvicted } from '../src/projection/query-projection.js';
import { collectRealization } from '../src/projection/realizations.js';
import { dataRoutingFor } from '../src/projection/router.js';
import type { RowSetId } from '../src/projection/row-set-id.js';
import type { RowSetWrite } from '../src/projection/store.js';
import type { DataVariant } from '../src/schemas/projection-data.js';

import { FakeFactStore, WIDE_STORE_BUDGETS } from './fake-fact-store.js';
import { countersMovedBy, EVERYTHING, extractorOf, stage, staged, type Realized } from './helpers/data-stage-fixture.js';
import { dataStageOverCache } from './helpers/data-stage-over-cache.js';

/** The config mechanism a defective pair's remedy ends on. */
const ROUTE_AWAY = 'route it away with resources.extractors.data.exclude';
const EXHAUSTED_REMEDY = 'free open files, disk space or quota on this machine, then run again';
const BUSY_REMEDY = 'wait for whatever holds the file to release it, then run again';

const PACKAGE = '{\n  "name": "a",\n  "name": "b",\n  "version": "1.0.0"\n}\n';
const TSCONFIG = '{\n  // comment\n  "compilerOptions": { "strict": true, },\n}\n';

describe('dataDemandOf', () => {
  it('is undefined when no relation of the instance is named, and names exactly what is', () => {
    expect(dataDemandOf(new Set(['blobs', 'edges']))).toBeUndefined();
    expect(dataDemandOf(new Set(['data__nodes', 'data__files']))).toStrictEqual({ tables: ['dataFiles', 'dataNodes'], routes: false, values: false, workspace: false });
    expect(dataDemandOf(new Set(['data__values']))).toStrictEqual({ tables: [], routes: false, values: true, workspace: false });
    expect(dataDemandOf(new Set(['data__routes']))).toStrictEqual({ tables: [], routes: true, values: false, workspace: false });
    expect(dataDemandOf(new Set(['workspace_dependencies']))).toStrictEqual({ tables: [], routes: false, values: false, workspace: true });
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

  it('stages the files the defaults route when an include glob routes nothing: that glob is a finding, not a refusal', async () => {
    const files = [{ path: 'package.json', text: '{"name":"a"}' }, { path: 'notes/a.toml', text: 'a = 1' }];
    const result = await stage(files, { routing: dataRoutingFor({ resources: { extractors: { data: { include: ['notes/*.toml'] } } } }) });
    expect(result.outcome).toBe('staged');
  });

  it('routes the pnpm-workspace.yaml default and an included .yml as yaml row sets, and a %YAML 1.1 stream defective', async () => {
    const result = staged(await stage([
      { path: 'pnpm-workspace.yaml', text: 'packages:\n  - packages/*\n' },
      { path: 'ci/build.yml', text: 'on: &t [push]\nalso: *t\n' },
      { path: 'ci/old.yml', text: '%YAML 1.1\n---\na: 1\n' },
    ], { routing: dataRoutingFor({ resources: { extractors: { data: { include: ['ci/*.yml'] } } } }) }));
    expect(result.derived.dataRoutes?.map(({ path, state, code, variant }) => `${path} ${variant} ${state} ${code ?? ''}`)).toStrictEqual([
      'pnpm-workspace.yaml yaml facts ',
      'ci/build.yml yaml facts ',
      'ci/old.yml yaml defective DATA_YAML_VERSION',
    ]);
    expect(result.defects[0]?.remedy).toMatch(/exclude/u);
    const rows = result.sources.get('dataNodes');
    if (rows === undefined || !('rows' in rows)) throw new Error('expected rows in hand');
    const variants = new Set((rows.rows as ReadonlyArray<{ variant: string }>).map((row) => row.variant));
    expect([...variants]).toStrictEqual(['yaml']);
  });
});

describe('runDataStage: the defects it lists, beside the rows of every other file', () => {
  /** One healthy file beside a malformed one and an unreadable one. */
  const MIXED: readonly Realized[] = [
    { path: 'package.json', text: '{"name":"a"}' },
    { path: 'bad/package.json', text: '{' },
    { path: 'x/package.json', state: 'unreadable' },
  ];

  it('lists every pair that is not facts, and still answers every relation from the facts pairs', async () => {
    const result = staged(await stage(MIXED));
    expect(result.defects.map(({ path, state, code }) => ({ path, state, code }))).toStrictEqual([
      { path: 'bad/package.json', state: 'defective', code: 'DATA_PARSE_ERROR' },
      { path: 'x/package.json', state: 'refused', code: 'BLOB_UNREADABLE' },
    ]);
    expect(result.defects[0]?.remedy).toMatch(/exclude/u);
    expect(result.defects[0]?.detail).not.toBe('DATA_PARSE_ERROR');
    expect([...new Set(result.derived.dataValues?.map(({ path }) => path))]).toStrictEqual(['package.json']);
    expect(result.derived.dataValues?.filter(({ pointer }) => pointer === '/name').map(({ value }) => value)).toStrictEqual(['a']);
    expect(result.derived.dataRoutes).toHaveLength(3);
  });

  it('answers the same relations and lists the same defects store on, cold and warm', async () => {
    const off = staged(await stage(MIXED));
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    for (const arm of [staged(await stage(MIXED, { store })), staged(await stage(MIXED, { store }))]) {
      expect(arm.derived).toStrictEqual(off.derived);
      expect(arm.defects).toStrictEqual(off.defects);
    }
  });

  it('lists nothing when every pair is facts', async () => {
    expect(staged(await stage([{ path: 'package.json', text: '{}' }])).defects).toStrictEqual([]);
  });

  it('makes each defect one error finding at its path, carrying its state, code, detail and remedy', async () => {
    const { defects } = staged(await stage(MIXED));
    const issues = dataDefectIssues(defects);
    expect(issues.map(({ code, severity, location }) => ({ code, severity, location }))).toStrictEqual([
      { code: 'DATA_FILE_NO_ROWS', severity: 'error', location: 'bad/package.json' },
      { code: 'DATA_FILE_NO_ROWS', severity: 'error', location: 'x/package.json' },
    ]);
    expect(issues[0]?.message).toContain('defective DATA_PARSE_ERROR');
    expect(issues[0]?.message).toContain(defects[0]?.detail ?? '');
    expect(issues[0]?.fix).toBe(defects[0]?.remedy);
    expect(issues[1]?.message).toContain('refused BLOB_UNREADABLE');
  });

  it('counts every failed routed pair in rowSet.refused, two paths sharing one row set twice, and each extraction once', async () => {
    const moved = await countersMovedBy(() => stage([
      { path: 'a/package.json', text: '{"a":1}' },
      { path: 'b/package.json', text: '{"a":1}' },
      { path: 'c/package.json', text: '{' },
      { path: 'd/package.json', text: '{' },
      { path: 'e/package.json', state: 'unreadable' },
    ]));
    expect(moved).toStrictEqual({ 'rowSet.extracted': 1, 'rowSet.storeServed': 0, 'rowSet.refused': 3, 'rowSet.rows.decoded': 0 });
  });
});

describe('runDataStage: a filesystem fault takes its refusal from the one fault table', () => {
  it('makes a refused or failed read (EACCES, EPERM, EIO) defective, with a remedy for a routed file', async () => {
    const result = staged(await stage([
      { path: 'keyed/package.json', text: '{}', fault: 'EACCES' },
      { path: 'deferred/package.json', state: 'deferred', fault: 'EPERM' },
      { path: 'device/package.json', text: '{"d":1}', fault: 'EIO' },
    ]));
    expect(result.derived.dataRoutes?.map(({ path, state, code }) => `${path} ${state} ${code ?? ''}`)).toStrictEqual([
      'keyed/package.json defective BLOB_UNREADABLE',
      'deferred/package.json defective BLOB_UNREADABLE',
      'device/package.json defective BLOB_UNREADABLE',
    ]);
    expect(result.defects[0]?.remedy).toBe(`grant read permission on the file, or ${ROUTE_AWAY}`);
    expect(result.defects[2]?.remedy).toBe(`check the disk or network share holding the file, then run again, or ${ROUTE_AWAY}`);
    expect(result.defects[0]?.detail).toBe('reading it failed with EACCES');
  });

  it('keeps a machine fault (EMFILE, ENFILE, EBUSY) refused, with a remedy for a routed file', async () => {
    const result = staged(await stage([
      { path: 'a/package.json', text: '{}', fault: 'EMFILE' },
      { path: 'b/package.json', state: 'deferred', fault: 'ENFILE' },
      { path: 'c/package.json', text: '{"c":1}', fault: 'EBUSY' },
    ]));
    expect(result.derived.dataRoutes?.map(({ state, code }) => `${state} ${code ?? ''}`)).toStrictEqual(Array.from({ length: 3 }, () => 'refused BLOB_UNREADABLE'));
    expect(result.defects.map((pair) => pair.remedy)).toStrictEqual([
      EXHAUSTED_REMEDY,
      EXHAUSTED_REMEDY,
      BUSY_REMEDY,
    ]);
  });

  it('takes an unreadable route state from the fault the population recorded, and reads it no more', async () => {
    const contentReads = new Map<string, number>();
    const result = staged(await stage([
      { path: 'denied/package.json', state: 'unreadable', faultClass: 'refused', text: '{"now": true}' },
      { path: 'exhausted/package.json', state: 'unreadable', faultClass: 'exhausted' },
      { path: 'gone/package.json', state: 'unreadable', faultClass: 'absent' },
    ], { contentReads }));
    expect(result.derived.dataRoutes?.map(({ path, state, code }) => `${path} ${state} ${code ?? ''}`)).toStrictEqual([
      'denied/package.json defective BLOB_UNREADABLE',
      'exhausted/package.json refused BLOB_UNREADABLE',
      'gone/package.json refused BLOB_UNREADABLE',
    ]);
    expect(result.defects.map(({ detail }) => detail)).toStrictEqual([
      'the population could not read it: permission was refused',
      'the population could not read it: the machine ran out of open files, disk space or quota',
      'the file is gone',
    ]);
    expect(contentReads.size).toBe(0);
  });

  // Every class but absence, pinned: a routed file is one the user never named, so no remedy may
  // send them to "the message" or tell them to "point the command" anywhere.
  it.each<[Exclude<FsFaultClass, 'absent'>, 'defective' | 'refused', string, string]>([
    ['refused', 'defective', 'permission was refused', `grant read permission on the file, or ${ROUTE_AWAY}`],
    ['wrong-type', 'defective', 'it is not a regular file (a directory, a pipe, socket or device, a link loop, or a name too long)', `make the path a regular file, or ${ROUTE_AWAY}`],
    ['occupied', 'defective', 'something was in the way at the path', `remove what is in the way at the path, or ${ROUTE_AWAY}`],
    ['unsupported', 'defective', 'its filesystem does not support reading it', `move the file to a filesystem that can read it, or ${ROUTE_AWAY}`],
    ['device', 'defective', 'its disk or network share failed', `check the disk or network share holding the file, then run again, or ${ROUTE_AWAY}`],
    ['exhausted', 'refused', 'the machine ran out of open files, disk space or quota', EXHAUSTED_REMEDY],
    ['busy', 'refused', 'the file was busy', BUSY_REMEDY],
  ])('gives a population fault of class %s the state %s, its words and a remedy for a routed file', async (faultClass, state, words, remedy) => {
    const result = staged(await stage([{ path: 'package.json', state: 'unreadable', faultClass }]));
    expect(result.defects).toStrictEqual([{
      path: 'package.json', state, code: 'BLOB_UNREADABLE', detail: `the population could not read it: ${words}`, remedy,
    }]);
  });

  it('reads a file the population found unreadable once per run, through the run cache both read through', async () => {
    // A root never written, so the one real read fails ENOENT: absence, whatever the uid.
    const root = toForwardSlash(safePath.join(import.meta.dirname, 'never-written-root'));
    const cache = new RunContentCache(NO_GIT_MEMBERS);
    const realization = await collectRealization(safePath.join(root, 'package.json'), 'res-1', {
      root, extentId: 'extent-1', contentCache: cache, observedShape: 'file',
    });
    expect(realization.contentState).toBe('unreadable');
    const result = staged(await dataStageOverCache({ root, realizations: [realization], cache, demand: EVERYTHING, extractor: extractorOf() }));
    expect(result.defects.map(({ state, detail }) => `${state} ${detail}`)).toStrictEqual(['refused the file is gone']);
    expect(cache.stats.misses).toBe(1);
  });

  it('names what a refused pair is and what a user can do about it, never a limit no one can set', async () => {
    const result = staged(await stage([{ path: 'time/package.json', text: '{"timeMs": 1}' }], {
      extractor: extractorOf((_variant, input) => (input.content.includes('timeMs') ? new ParseLimitError('timeMs', 1) : undefined)),
    }));
    const remedy = result.defects[0]?.remedy ?? '';
    expect(remedy).toMatch(/^run again/u);
    expect(remedy).toMatch(/resources\.extractors\.data\.exclude/u);
    expect(remedy).not.toMatch(/too low/u);
  });
});

/** A clean corpus: duplicate keys, a JSONC file, and the same bytes read under both variants. */
const CLEAN: readonly Realized[] = [
  { path: 'package.json', text: PACKAGE },
  { path: 'tsconfig.json', text: TSCONFIG },
  { path: 'packages/a/package.json', text: '{"name": "a", "nested": {"list": [1, 1.0, "x"]}}' },
  { path: 'packages/a/tsconfig.json', text: '{"name": "a", "nested": {"list": [1, 1.0, "x"]}}' },
];

/** A wide fake store that records every row-set write it takes. */
function recordingStore(): { store: FakeFactStore; writes: RowSetWrite[] } {
  const writes: RowSetWrite[] = [];
  const store = new (class extends FakeFactStore {
    override writeRowSets(write: RowSetWrite): Promise<void> {
      writes.push(write);
      return super.writeRowSets(write);
    }
  })(WIDE_STORE_BUDGETS);
  return { store, writes };
}

describe('runDataStage: store on and store off', () => {
  it('answers data__routes and data__values identically on both backings, cold and warm', async () => {
    const off = staged(await stage(CLEAN));
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const cold = staged(await stage(CLEAN, { store }));
    const warm = staged(await stage(CLEAN, { store }));
    expect(off.defects).toStrictEqual([]);
    for (const arm of [cold, warm]) {
      expect(arm.derived).toStrictEqual(off.derived);
      expect(arm.defects).toStrictEqual([]);
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
    const cold = await countersMovedBy(() => stage(CLEAN, { store, demand: { tables: ['dataNodes'], routes: true, values: false, workspace: false } }));
    expect(cold).toMatchObject({ 'rowSet.extracted': ids, 'rowSet.storeServed': 0, 'rowSet.rows.decoded': ids });
    const warm = await countersMovedBy(() => stage(CLEAN, { store, demand: { tables: ['dataNodes'], routes: true, values: false, workspace: false } }));
    expect(warm).toMatchObject({ 'rowSet.extracted': 0, 'rowSet.storeServed': ids, 'rowSet.rows.decoded': ids });
    expect(store.writeRowSetsCalls).toBe(1);
  });

  it('writes the head rows of what it was served beside what it extracted, listed as covered', async () => {
    const { store, writes } = recordingStore();
    await stage(CLEAN.slice(0, 1), { store });
    await stage(CLEAN.slice(0, 2), { store });
    const write = writes[1];
    expect(write?.coveredAtRead.map((id) => id.variant)).toStrictEqual(['json']);
    expect(write?.rows.dataFiles?.map((row) => row.variant).sort((a, b) => a.localeCompare(b))).toStrictEqual(['json', 'jsonc']);
  });
});

/** The bytes of one small file's row set, as the data byte cap counts them. */
function oneRowSetBytes(): number {
  const extraction = extractDataRows({ text: '{"a":1}', variant: 'json', bom: false }, resolveDataOutputCaps(undefined));
  if (extraction.outcome !== 'rows') throw new Error('expected rows');
  return extraction.bytes;
}

describe('runDataStage: what a run holds of the rows it extracts', () => {
  /** Three files whose row sets are distinct and the same size. */
  const SAME_SIZE: readonly Realized[] = [
    { path: 'a/package.json', text: '{"a":1}' },
    { path: 'b/package.json', text: '{"b":1}' },
    { path: 'c/package.json', text: '{"c":1}' },
  ];

  it('store on, writes the row sets in batches of the bytes it holds, each later write covering every earlier one', async () => {
    const { store, writes } = recordingStore();
    const batched = staged(await stage(SAME_SIZE, { store, rowBytesHeld: 1 }));

    // One row set per write: the stage never held two before writing.
    expect(writes.map((write) => write.coveredAtRead.length)).toStrictEqual([0, 1, 2]);
    expect(writes.map((write) => write.rows.dataNodes?.length)).toStrictEqual([2, 2, 2]);
    // Each write holds the heads of every earlier one, so none is rewritten or evicted by a later one.
    expect(writes.map((write) => write.rows.dataFiles?.length)).toStrictEqual([1, 2, 3]);
    expect(batched.defects).toStrictEqual([]);
    expect(batched.derived).toStrictEqual(staged(await stage(SAME_SIZE)).derived);
  });

  it('store off, holds no more than the bytes it may, refusing each file past them by name', async () => {
    const result = staged(await stage(SAME_SIZE, { rowBytesHeld: 2 * oneRowSetBytes() }));

    expect(result.derived.dataRoutes?.filter((row) => row.state === 'facts')).toHaveLength(2);
    expect(result.defects.map(({ state, code }) => `${state} ${code}`)).toStrictEqual(['refused PARSE_LIMIT_EXCEEDED']);
    expect(result.defects[0]?.detail).toMatch(/no store to write them to/u);
    expect(result.defects[0]?.remedy).toMatch(/projection store on/u);
    const files = result.sources.get('dataFiles');
    expect(files !== undefined && 'rows' in files ? files.rows.length : undefined).toBe(2);
  });

  it('store off, holds every row set when they fit', async () => {
    expect(staged(await stage(SAME_SIZE, { rowBytesHeld: 3 * oneRowSetBytes() })).defects).toStrictEqual([]);
  });
});

describe('runDataStage: a row set gone from the store refuses the attempt by tier', () => {
  it('names the row set evicted between the coverage read and the data__values node read', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    await stage(CLEAN, { store });
    let evicted: RowSetId | undefined;
    const seams: DataStageSeams = {
      ...NO_DATA_STAGE_SEAMS,
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
    const result = staged(await stage(CLEAN, { store, seams: { ...NO_DATA_STAGE_SEAMS, afterWrite: (facts) => seen.push([...facts]) } }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.length).toBe(4);
    expect(result.defects).toStrictEqual([]);
  });
});
