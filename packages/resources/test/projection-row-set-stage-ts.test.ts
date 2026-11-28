/**
 * The row-set stage over two instances: the `ts` instance beside the `data` instance, through one
 * route, coverage, extract, write and read-back path. One writer serves both, and each write lists
 * every held head of both, so one instance's batch never evicts the other's row sets; a defective
 * `ts` pair is its own `TS_FILE_NO_ROWS`; a run naming no `ts` relation touches nothing of it; a `ts`
 * route is git content; `ts_imports` joins the routes to the imports through the one read.
 */

import { readWorkCounters, VatError } from '@vibe-agent-toolkit/utils';
import { GIT_NO_ANSWER_CODE } from '@vibe-agent-toolkit/utils/git';
import { describe, expect, it } from 'vitest';

import type { KeyedContent } from '../src/content-key.js';
import { instanceDemanded, rowSetDefectIssues, rowSetDemandOf, type RowSetDemand } from '../src/projection/data-stage.js';
import { tsRoutingFor } from '../src/projection/router.js';
import { rowSetIdText } from '../src/projection/row-set-id.js';
import type { RowSetWrite } from '../src/projection/store.js';

import { FakeFactStore, WIDE_STORE_BUDGETS } from './fake-fact-store.js';
import { countersMovedBy, EVERYTHING, EVERYTHING_TS, extractorOf, recordingStore, stage, staged, type Realized } from './helpers/data-stage-fixture.js';

/** Both instances, every relation. */
const BOTH: RowSetDemand = { ...EVERYTHING, tables: [...EVERYTHING.tables, ...EVERYTHING_TS.tables], tsRoutes: true, tsImports: true };

const A_TS = 'import { b } from \'./b.js\';\nimport fs from \'node:fs\';\nimport kit from \'@acme/kit/sub\';\nexport const a = b + fs.sep + kit;\n';
const B_TS = 'export const b = 1;\n';

/** Two data files and two `ts` files. */
const MIXED: readonly Realized[] = [
  { path: 'package.json', text: '{"name":"@acme/app"}' },
  { path: 'tsconfig.json', text: '{"compilerOptions":{}}' },
  { path: 'src/a.ts', text: A_TS },
  { path: 'src/b.ts', text: B_TS },
];

/** Code-unit order, for comparing sets of id texts. */
function byText(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Every head row id a write lists, as text. */
function headTexts(write: RowSetWrite): string[] {
  const data = (write.rows.dataFiles ?? []).map((row) => rowSetIdText({ contentKey: row.blob, instance: 'data', variant: row.variant }));
  const ts = (write.rows.tsFiles ?? []).map((row) => rowSetIdText({ contentKey: row.blob, instance: 'ts', variant: row.variant }));
  return [...data, ...ts];
}

describe('rowSetDemandOf over two instances', () => {
  it('demands the ts instance exactly for its tables, ts__routes and ts_imports, and nothing of data for them', () => {
    const ts = rowSetDemandOf(new Set(['ts__exports', 'ts_imports']));
    expect(ts).toStrictEqual({ tables: ['tsExports'], dataRoutes: false, dataValues: false, tsRoutes: false, tsImports: true, workspace: false, tsconfig: false });
    expect(ts !== undefined && instanceDemanded(ts, 'data')).toBe(false);
    const routes = rowSetDemandOf(new Set(['ts__routes']));
    expect(routes !== undefined && instanceDemanded(routes, 'ts')).toBe(true);
    const data = rowSetDemandOf(new Set(['data__routes']));
    expect(data !== undefined && instanceDemanded(data, 'ts')).toBe(false);
  });
});

describe('runDataStage over two instances: one writer', () => {
  it('makes every write list the held heads of both instances, each later write covering every earlier one', async () => {
    const { store, writes } = recordingStore();
    const result = staged(await stage(MIXED, { store, demand: BOTH, rowBytesHeld: 1 }));
    expect(result.defects).toStrictEqual([]);
    // One row set per write: four writes, across both instances.
    expect(writes).toHaveLength(4);
    const written: string[] = [];
    for (const [index, write] of writes.entries()) {
      expect(write.coveredAtRead.map((id) => rowSetIdText(id)).toSorted(byText)).toStrictEqual(written.toSorted(byText));
      written.push(...headTexts(write).filter((text) => !written.includes(text)));
      expect(headTexts(write)).toHaveLength(index + 1);
    }
    expect(new Set(writes.flatMap((write) => [...(write.rows.dataFiles ?? []).map(() => 'data'), ...(write.rows.tsFiles ?? []).map(() => 'ts')]))).toStrictEqual(new Set(['data', 'ts']));
  });

  // Red, seeded once and reverted: `BatchedRowSetWriter.#write` listing only the written batch's own
  // instance's heads (one write per instance): the second instance's write evicts the first's row sets
  // past the budget, and the read-back refuses the attempt with a row-set eviction.
  it('keeps both instances\' row sets under a budget below one row set, since no write leaves the other unlisted', async () => {
    const { store } = recordingStore({ ...WIDE_STORE_BUDGETS, rowSetTierBudgetBytes: 1 });
    const result = staged(await stage(MIXED, { store, demand: BOTH, rowBytesHeld: 1 }));
    expect(result.derived.dataRoutes?.map((row) => row.state)).toStrictEqual(['facts', 'facts']);
    expect(result.derived.tsRoutes?.map((row) => row.state)).toStrictEqual(['facts', 'facts']);
  });

  it('answers ts__routes and ts_imports identically store on, cold and warm, and store off', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const off = staged(await stage(MIXED, { demand: BOTH })).derived;
    const cold = staged(await stage(MIXED, { store, demand: BOTH })).derived;
    const warm = staged(await stage(MIXED, { store, demand: BOTH })).derived;
    expect(cold).toStrictEqual(off);
    expect(warm).toStrictEqual(off);
  });
});

describe('runDataStage: the ts instance', () => {
  it('routes by extension, extracts on the dispatcher, and names every pair in ts__routes', async () => {
    const result = staged(await stage([...MIXED, { path: 'types/x.d.ts', text: 'export declare const x: number;\n' }, { path: 'ui/c.tsx', text: 'export const c = <div />;\n' }], { demand: EVERYTHING_TS }));
    expect(result.derived.tsRoutes?.map(({ path, variant, state }) => ({ path, variant, state }))).toStrictEqual([
      { path: 'src/a.ts', variant: 'ts', state: 'facts' },
      { path: 'src/b.ts', variant: 'ts', state: 'facts' },
      { path: 'types/x.d.ts', variant: 'dts', state: 'facts' },
      { path: 'ui/c.tsx', variant: 'tsx', state: 'facts' },
    ]);
    expect(result.derived.dataRoutes).toBeUndefined();
    const files = result.sources.get('tsFiles');
    expect(files !== undefined && 'rows' in files ? files.rows.filter((row) => row['hasJsx'] === true).map((row) => row['variant']) : undefined).toStrictEqual(['tsx']);
  });

  it('makes a defective pair one TS_FILE_NO_ROWS at its path, and answers every relation from the other pairs', async () => {
    const result = staged(await stage([...MIXED, { path: 'src/bad.ts', text: 'import { from \'x\';\n' }], { demand: EVERYTHING_TS }));
    expect(result.derived.tsRoutes?.find((row) => row.path === 'src/bad.ts')).toMatchObject({ state: 'defective', code: 'TS_PARSE_ERROR' });
    expect(result.derived.tsImports?.map((row) => row.path)).toStrictEqual(['src/a.ts', 'src/a.ts', 'src/a.ts']);
    expect(result.defects.map(({ instance, path, state, code }) => ({ instance, path, state, code }))).toStrictEqual([
      { instance: 'ts', path: 'src/bad.ts', state: 'defective', code: 'TS_PARSE_ERROR' },
    ]);
    const [issue] = rowSetDefectIssues(result.defects);
    expect(issue).toMatchObject({ code: 'TS_FILE_NO_ROWS', severity: 'error', location: 'src/bad.ts' });
    expect(issue?.message).toMatch(/^'src\/bad\.ts' is routed to the ts instance and has no rows this run: defective TS_PARSE_ERROR: .*Every ts__\* relation and ts_imports answers without it; ts__routes names it\.$/su);
    expect(issue?.fix).toBe('fix the file, or route it away with resources.extractors.ts.exclude');
  });

  it('never serves a stored (A, ts) row set to a run routing the same bytes as (A, dts)', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const text = 'export declare const x: number;\n';
    await stage([{ path: 'a.ts', text }], { store, demand: EVERYTHING_TS });
    const moved = await countersMovedBy(() => stage([{ path: 'b.d.ts', text }], { store, demand: EVERYTHING_TS }));
    expect(moved).toMatchObject({ 'rowSet.extracted': 1, 'rowSet.storeServed': 0 });
    const again = await countersMovedBy(() => stage([{ path: 'a.ts', text }, { path: 'b.d.ts', text }], { store, demand: EVERYTHING_TS }));
    expect(again).toMatchObject({ 'rowSet.extracted': 0, 'rowSet.storeServed': 2 });
  });

  it('refuses CONFIG_INVALID-worthy emptiness for a declared ts block that routed nothing', async () => {
    const declared = await stage(MIXED.slice(0, 2), { demand: EVERYTHING_TS, tsRouting: tsRoutingFor({ resources: { extractors: { ts: {} } } }) });
    expect(declared).toMatchObject({ outcome: 'examined-nothing', message: expect.stringContaining('resources.extractors.ts is declared') });
  });
});

/** An extractor that fails the test the moment one instance's job is dispatched. */
function refusing(instance: 'dataRows' | 'tsRows'): ReturnType<typeof extractorOf> {
  const real = extractorOf();
  return { ...real, [instance]: () => Promise.reject(new Error(`a ${instance} job was dispatched`)) };
}

describe('runDataStage: a run demanding one instance touches nothing of the other', () => {
  it('routes no ts path and dispatches no ts job for a run naming only data__* relations, asking no git content', async () => {
    let asked = 0;
    const result = staged(await stage(MIXED, { demand: EVERYTHING, extractor: refusing('tsRows'), gitContentPaths: () => { asked++; return undefined; } }));
    expect(result.derived.tsRoutes).toBeUndefined();
    expect(result.derived.dataRoutes?.map((row) => row.state)).toStrictEqual(['facts', 'facts']);
    expect(asked).toBe(0);
  });

  it('routes no data path and dispatches no data job for a run naming only ts relations', async () => {
    const result = staged(await stage(MIXED, { demand: EVERYTHING_TS, extractor: refusing('dataRows') }));
    expect(result.derived.dataRoutes).toBeUndefined();
    expect(result.derived.tsRoutes?.map((row) => row.state)).toStrictEqual(['facts', 'facts']);
  });
});

describe('runDataStage: a ts route is git content', () => {
  it('routes only the git-content paths the forced filesystem lane intersects with, asking once per root', async () => {
    const files: readonly Realized[] = [...MIXED, { path: 'ignored/gen.ts', text: B_TS }, { path: 'ignored/package.json', text: '{}' }];
    const asked: string[] = [];
    const gitContentPaths = (rootPath: string): ReadonlySet<string> => {
      asked.push(rootPath);
      return new Set(['package.json', 'tsconfig.json', 'src/a.ts', 'src/b.ts']);
    };
    const result = staged(await stage(files, { demand: BOTH, gitContentPaths }));
    expect(result.derived.tsRoutes?.map((row) => row.path)).toStrictEqual(['src/a.ts', 'src/b.ts']);
    // The data instance is not git-content-only: its ignored file is still routed.
    expect(result.derived.dataRoutes?.map((row) => row.path)).toContain('ignored/package.json');
    expect(asked).toStrictEqual(['/repo']);
  });

  it('refuses the ts instance with the snapshot\'s coded error when git gives no answer, and still stages data', async () => {
    const noAnswer = new VatError(GIT_NO_ANSWER_CODE, 'not a git repository');
    const result = staged(await stage(MIXED, { demand: BOTH, gitContentPaths: () => { throw noAnswer; } }));
    expect(result.refusals).toStrictEqual(new Map([['ts', noAnswer]]));
    expect(result.derived.tsRoutes).toStrictEqual([]);
    expect(result.derived.dataRoutes?.map((row) => row.state)).toStrictEqual(['facts', 'facts']);
  });

  it('lets any other routing error stop the run', async () => {
    await expect(stage(MIXED, { demand: BOTH, gitContentPaths: () => { throw new Error('boom'); } })).rejects.toThrow('boom');
  });
});

describe('runDataStage: ts_imports', () => {
  it('joins each facts route to its imports with the facts its path and the running Node decide', async () => {
    const result = staged(await stage(MIXED, { demand: { ...EVERYTHING_TS, tables: [] } }));
    expect(result.derived.tsImports?.map(({ root, path, ordinal, kind, specifier, package: pkg, builtin, lexicalTarget }) => ({ root, path, ordinal, kind, specifier, pkg, builtin, lexicalTarget }))).toStrictEqual([
      { root: 'root-1', path: 'src/a.ts', ordinal: 0, kind: 'import', specifier: './b.js', pkg: null, builtin: false, lexicalTarget: 'src/b.js' },
      { root: 'root-1', path: 'src/a.ts', ordinal: 1, kind: 'import', specifier: 'node:fs', pkg: null, builtin: true, lexicalTarget: null },
      { root: 'root-1', path: 'src/a.ts', ordinal: 2, kind: 'import', specifier: '@acme/kit/sub', pkg: '@acme/kit', builtin: false, lexicalTarget: null },
    ]);
  });

  it('reads the imports in one extending read after the head read-back: no stored row decoded twice in the run', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const before = readWorkCounters();
    const cold = staged(await stage(MIXED, { store, demand: { ...EVERYTHING_TS, tables: [] } }));
    const after = readWorkCounters();
    expect(after['store.rows.decoded.repeated'] - before['store.rows.decoded.repeated']).toBe(0);
    // The two heads read back, then the three imports: each decoded once.
    expect(after['rowSet.rows.decoded'] - before['rowSet.rows.decoded']).toBe(5);
    expect(cold.derived.tsImports).toHaveLength(3);
  });

  it('makes a ts file whose bytes are not text defective BLOB_NOT_TEXT, dispatching no job', async () => {
    const nul = String.fromCodePoint(0);
    const binary: Realized = { path: 'src/bin.ts', text: `${nul}${String.fromCodePoint(1)}` };
    const result = staged(await stage([binary], { demand: EVERYTHING_TS, extractor: extractorOf((_variant: string, input: KeyedContent) => (input.content.includes(nul) ? new Error('never dispatched') : undefined)) }));
    expect(result.derived.tsRoutes?.[0]).toMatchObject({ state: 'defective', code: 'BLOB_NOT_TEXT' });
  });
});
