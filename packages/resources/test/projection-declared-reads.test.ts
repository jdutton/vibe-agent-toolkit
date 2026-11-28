/**
 * The declared-reads handle a resolve step reads data rows through: its fixed order (the declared
 * set, then the routing, then the pair's state), on both backings (store on through the run's
 * reader, store off over the stage's rows in hand), which answer alike.
 */

import { readWorkCounters } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { keyContent } from '../src/content-key.js';
import { NO_DATA_STAGE_SEAMS, runDataStageWithReads, type RowSetDemand, type DataStageSeams } from '../src/projection/data-stage.js';
import type { DeclaredAnswer, DeclaredPair, DeclaredReads } from '../src/projection/declared-reads.js';
import { isStoredRowsEvicted } from '../src/projection/query-projection.js';
import { dataRoutingFor, tsRoutingFor } from '../src/projection/router.js';
import type { RowSetId } from '../src/projection/row-set-id.js';
import type { RowSetTableName } from '../src/projection/row-set-table-registry.js';
import { runStoredReads } from '../src/projection/stored-reads.js';
import type { DataVariant } from '../src/schemas/projection-data.js';
import type { TsVariant } from '../src/schemas/projection-ts.js';

import { FakeFactStore, WIDE_STORE_BUDGETS } from './fake-fact-store.js';
import { stage, staged, stageInput, type Realized, type StageOptions } from './helpers/data-stage-fixture.js';

/** The declared-reads handle of a stage run over `files`, failing when the stage did not stage. */
async function stageReads(files: readonly Realized[], options: StageOptions = {}): Promise<(declared: readonly DeclaredPair[]) => DeclaredReads> {
  const { result, declaredReads } = await runDataStageWithReads(stageInput(files, options));
  staged(result);
  if (declaredReads === undefined) throw new Error('a staged answer carries a handle');
  return declaredReads;
}

const ROOT_ID = 'root-1';
const PACKAGE = 'package.json';
const MEMBER = 'packages/a/package.json';
const BAD = 'bad/package.json';
const TSCONFIG = 'tsconfig.json';
const NOTES = 'notes/a.json';
const SECRET = 'secret/package.json';

const FILES: readonly Realized[] = [
  { path: PACKAGE, text: '{"name": "root", "workspaces": ["packages/*"]}' },
  { path: MEMBER, text: '{"name": "a", "version": "1.0.0"}' },
  { path: BAD, text: '{' },
  { path: TSCONFIG, text: '{\n  // comment\n  "compilerOptions": { "strict": true, },\n}\n' },
  { path: NOTES, text: '{"n": 1}' },
  { path: SECRET, text: '{"s": 1}' },
];

/** `secret/**` excluded; `notes/a.json` matches no rule. */
const ROUTING = dataRoutingFor({ resources: { extractors: { data: { exclude: ['secret/**'] } } } });

/** Only `data__routes`: no relation of the stage reads a row-set table beyond the heads. */
const ROUTES_ONLY: RowSetDemand = { tables: [], dataRoutes: true, dataValues: false, tsRoutes: false, tsImports: false, workspace: false, tsconfig: false, tsResolve: false };

/** @returns The pair `path` read as `variant` under the fixture's one root */
function pair(path: string, variant: DataVariant = 'json'): DeclaredPair {
  return { root: ROOT_ID, path, instance: 'data', variant };
}

/** One backing the handle is built over. */
interface Arm {
  readonly name: string;
  /** The handle over `declared`, from a stage run on this arm. */
  readonly handle: (declared: readonly DeclaredPair[], seams?: DataStageSeams) => Promise<DeclaredReads>;
}

/** @returns An arm whose stage runs with `store` (store off when undefined), after `warmups` earlier runs on it */
function armOf(name: string, store: () => FakeFactStore | undefined, warmups = 0): Arm {
  return {
    name,
    handle: async (declared, seams) => {
      const held = store();
      const backing = held === undefined ? {} : { store: held };
      for (let run = 0; run < warmups; run++) await stage(FILES, { ...backing, routing: ROUTING, demand: ROUTES_ONLY });
      return (await stageReads(FILES, { routing: ROUTING, demand: ROUTES_ONLY, reads: runStoredReads(), ...backing, ...(seams === undefined ? {} : { seams }) }))(declared);
    },
  };
}

const ARMS: readonly Arm[] = [
  armOf('store off', () => undefined),
  armOf('store on, cold', () => new FakeFactStore(WIDE_STORE_BUDGETS)),
  armOf('store on, warm', () => new FakeFactStore(WIDE_STORE_BUDGETS), 1),
];

describe.each(ARMS)('declared reads ($name)', ({ handle }) => {
  it('throws on an undeclared pair and names it, the routed one included', async () => {
    const reads = await handle([pair(PACKAGE)]);
    // Routed, `facts`, and not declared: the declared set is asked before the routing.
    await expect(reads.read([pair(MEMBER)], { tables: ['dataNodes'] })).rejects.toThrow(/packages\/a\/package\.json/u);
    await expect(reads.read([pair(PACKAGE), pair(MEMBER)], { tables: ['dataNodes'] })).rejects.toThrow(/not declared/u);
    // Unrouted and not declared: still a throw, never an absence.
    await expect(reads.read([pair(NOTES)], { tables: ['dataNodes'] })).rejects.toThrow(/notes\/a\.json/u);
    // The same path under another variant is another pair.
    await expect(reads.read([pair(PACKAGE, 'jsonc')], { tables: ['dataNodes'] })).rejects.toThrow(/not declared/u);
  });

  it('answers a declared pair the routing does not read under its variant absent DATA_REQUEST_UNROUTED, saying why', async () => {
    const declared = [pair(NOTES), pair(SECRET), pair(PACKAGE, 'jsonc'), pair('missing/package.json'), { ...pair(PACKAGE), root: 'root-2' }];
    const answers = await (await handle(declared)).read(declared, { tables: ['dataNodes'] });
    expectUnrouted(answers, [
      { kind: 'unrouted' },
      { kind: 'excluded' },
      { kind: 'routed-as', variant: 'json' },
      { kind: 'not-in-run' },
      { kind: 'not-in-run' },
    ], /resources\.extractors\.data/u);
  });

  it('answers a declared pair the credentials rule refuses with its own reason and a rename remedy', async () => {
    const declared = [pair('tsconfig.service-account.json', 'jsonc')];
    const [answer] = await (await handle(declared)).read(declared, { tables: ['dataNodes'] });
    expect(answer).toMatchObject({ state: 'absent', cause: 'unrouted', code: 'DATA_REQUEST_UNROUTED', reason: { kind: 'credentials' } });
    if (answer?.state !== 'absent' || answer.cause !== 'unrouted') return;
    expect(answer.detail).toContain('refused by the credentials rule');
    expect(answer.remedy).toMatch(/rename the file/u);
    expect(answer.remedy).not.toMatch(/route it/u);
  });

  it('answers a routed facts pair present with exactly the requested tables, and a defective one absent with its code', async () => {
    const declared = [pair(PACKAGE), pair(MEMBER), pair(BAD), pair(TSCONFIG, 'jsonc')];
    const answers = await (await handle(declared)).read(declared, { tables: ['dataNodes', 'dataDocuments'] });
    const [root, member, bad, tsconfig] = answers;
    for (const [answer, path] of [[root, PACKAGE], [member, MEMBER], [tsconfig, TSCONFIG]] as const) {
      if (answer?.state !== 'present') throw new Error(`expected ${path} present, got ${JSON.stringify(answer)}`);
      expect(Object.keys(answer.rows).sort((a, b) => a.localeCompare(b))).toStrictEqual(['dataDocuments', 'dataNodes']);
      const blob = keyContent(FILES.find((file) => file.path === path)?.text ?? '', 'none').key;
      expect(answer.rows.dataNodes.length).toBeGreaterThan(0);
      expect(answer.rows.dataNodes.every((row) => row.blob === blob && row.variant === answer.pair.variant)).toBe(true);
    }
    if (member?.state !== 'present') throw new Error('expected the member present');
    expect(member.rows.dataNodes.find((row) => row.pointer === '/name')?.value).toBe('a');
    expect(bad).toStrictEqual({
      state: 'absent', cause: 'no-rows', pair: pair(BAD), code: 'DATA_PARSE_ERROR', routeState: 'defective',
      remedy: 'fix the file, or route it away with resources.extractors.data.exclude', retryable: false,
    });
  });

  it('answers a json pair the routing reads as jsonc present from the jsonc row set, the pair kept as requested', async () => {
    const declared = [pair(TSCONFIG)];
    const [answer] = await (await handle(declared)).read(declared, { tables: ['dataNodes'] });
    if (answer?.state !== 'present') throw new Error(`expected ${TSCONFIG} present, got ${JSON.stringify(answer)}`);
    expect(answer.pair).toStrictEqual(pair(TSCONFIG));
    expect(answer.rows.dataNodes.length).toBeGreaterThan(0);
    expect(answer.rows.dataNodes.every((row) => row.variant === 'jsonc')).toBe(true);
    expect(answer.rows.dataNodes.find((row) => row.pointer === '/compilerOptions/strict')?.value).toBe(true);
  });
});

describe('declared reads: the backings answer alike', () => {
  it('answers the same rows store off, store on cold and store on warm', async () => {
    const declared = [pair(PACKAGE), pair(MEMBER), pair(BAD), pair(NOTES)];
    const [off, ...on] = await Promise.all(ARMS.map(async ({ handle }) => (await handle(declared)).read(declared, { tables: ['dataNodes', 'dataConditions'] })));
    for (const arm of on) expect(arm).toStrictEqual(off);
  });
});

describe('declared reads: store on reads through the run reader', () => {
  const declared = [pair(PACKAGE), pair(MEMBER)];

  it('reads many pairs in one reader call, and a wider read decodes each table of a row set once', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const reads = (await stageReads(FILES, { store, routing: ROUTING, demand: ROUTES_ONLY }))(declared);
    const repeatedBefore = readWorkCounters()['store.rows.decoded.repeated'];
    const decodedBefore = readWorkCounters()['rowSet.rows.decoded'];
    const callsBefore = store.readRowSetsCalls;
    await reads.read(declared, { tables: ['dataNodes'] });
    expect(store.readRowSetsCalls - callsBefore).toBe(1);
    await reads.read(declared, { tables: ['dataNodes', 'dataDocuments'] });
    await reads.read(declared, { tables: ['dataDocuments'] });
    expect(readWorkCounters()['store.rows.decoded.repeated'] - repeatedBefore).toBe(0);
    expect(readWorkCounters()['rowSet.rows.decoded'] - decodedBefore).toBeGreaterThan(0);
  });

  it('throws a row-set StoredRowsEvictedError for a pair evicted between the coverage read and the declared read', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    let evicted: RowSetId | undefined;
    const seams: DataStageSeams = {
      ...NO_DATA_STAGE_SEAMS,
      beforeDeclaredRead: (ids) => {
        evicted = ids[0];
        if (evicted !== undefined) store.forgetRowSet(evicted);
      },
    };
    const reads = (await stageReads(FILES, { store, routing: ROUTING, demand: ROUTES_ONLY, seams }))(declared);
    const thrown = await reads.read(declared, { tables: ['dataNodes'] }).catch((error: unknown) => error);
    if (!isStoredRowsEvicted(thrown) || thrown.eviction.tier !== 'rowSet') throw new Error(`expected a row-set eviction, got ${String(thrown)}`);
    expect(thrown.eviction.ids).toStrictEqual([evicted]);
    expect(thrown.eviction.relation).toBe('data__nodes');
  });
});

const TS_OK = 'src/a.ts';
const TS_BAD = 'src/bad.ts';
const TS_EXCLUDED = 'gen/x.ts';
const TS_NODE_MODULES = 'node_modules/p/index.ts';
const TS_TEXT = 'src/notes.txt';
const TS_FILES: readonly Realized[] = [
  { path: TS_OK, text: "import { b } from './b';\nexport const a = b;\n" },
  { path: TS_BAD, text: 'import {{{ from' },
  { path: TS_EXCLUDED, text: 'export const x = 1;\n' },
  { path: TS_TEXT, text: 'plain' },
  { path: PACKAGE, text: '{"name": "root"}' },
];

/** Both instances' routes and the ts tables' rows: the ts instance staged beside the data one. */
const TS_AND_DATA: RowSetDemand = { tables: ['tsFiles', 'tsImports'], dataRoutes: true, dataValues: false, tsRoutes: true, tsImports: true, workspace: false, tsconfig: false, tsResolve: false };

/** @returns The ts pair `path` read as `variant` under the fixture's one root */
function tsPair(path: string, variant: TsVariant = 'ts'): DeclaredPair {
  return { root: ROOT_ID, path, instance: 'ts', variant };
}

const TS_ARMS: ReadonlyArray<{ readonly name: string; readonly store: () => FakeFactStore | undefined }> = [
  { name: 'store off', store: () => undefined },
  { name: 'store on', store: () => new FakeFactStore(WIDE_STORE_BUDGETS) },
];

describe.each(TS_ARMS)('declared reads over ts pairs ($name)', ({ store }) => {
  const handle = async (declared: readonly DeclaredPair[], demand: RowSetDemand = TS_AND_DATA): Promise<DeclaredReads> => {
    const held = store();
    const backing = held === undefined ? {} : { store: held };
    return (await stageReads(TS_FILES, { ...backing, reads: runStoredReads(), demand, tsRouting: tsRoutingFor({ resources: { extractors: { ts: { exclude: ['gen/**'] } } } }) }))(declared);
  };

  it('answers a routed ts pair present with its own rows of the requested tables', async () => {
    const declared = [tsPair(TS_OK)];
    const [answer] = await (await handle(declared)).read(declared, { tables: ['tsFiles', 'tsImports'] });
    if (answer?.state !== 'present') throw new Error(`expected present, got ${JSON.stringify(answer)}`);
    const blob = keyContent(TS_FILES[0]?.text ?? '', 'none').key;
    expect(answer.rows.tsFiles).toHaveLength(1);
    expect(answer.rows.tsImports.map((row) => row.specifier)).toStrictEqual(['./b']);
    expect(answer.rows.tsImports.every((row) => row.blob === blob && row.variant === 'ts')).toBe(true);
  });

  it('answers data and ts pairs in one read, each its own rows', async () => {
    const declared = [pair(PACKAGE), tsPair(TS_OK)];
    const [data, tsAnswer] = await (await handle(declared)).read(declared, { tables: ['dataNodes', 'tsImports'] });
    if (data?.state !== 'present' || tsAnswer?.state !== 'present') throw new Error('expected both present');
    expect(data.rows.dataNodes.length).toBeGreaterThan(0);
    expect(data.rows.tsImports).toHaveLength(0);
    expect(tsAnswer.rows.tsImports).toHaveLength(1);
    expect(tsAnswer.rows.dataNodes).toHaveLength(0);
  });

  it('answers an unrouted ts path absent DATA_REQUEST_UNROUTED with the ts remedy', async () => {
    const declared = [tsPair(TS_EXCLUDED), tsPair(TS_NODE_MODULES), tsPair(TS_TEXT), tsPair('src/missing.ts'), tsPair(TS_OK, 'tsx')];
    const answers = await (await handle(declared)).read(declared, { tables: ['tsFiles'] });
    expectUnrouted(answers, [
      { kind: 'excluded' },
      { kind: 'node-modules' },
      { kind: 'unrouted' },
      { kind: 'not-in-run' },
      { kind: 'routed-as', variant: 'ts' },
    ], /resources\.extractors\.ts/u, 'ts instance');
  });

  it('answers a defective ts pair absent with its TS_FILE_NO_ROWS remedy', async () => {
    const declared = [tsPair(TS_BAD)];
    const [answer] = await (await handle(declared)).read(declared, { tables: ['tsFiles'] });
    expect(answer).toMatchObject({ state: 'absent', cause: 'no-rows', routeState: 'defective', retryable: false });
    if (answer?.state !== 'absent' || answer.cause !== 'no-rows') return;
    expect(answer.remedy).toMatch(/resources\.extractors\.ts\.exclude/u);
  });

  it('throws on an undeclared ts pair, routed or not, naming it, before the routing is asked', async () => {
    const reads = await handle([tsPair(TS_OK)]);
    await expect(reads.read([tsPair(TS_BAD)], { tables: ['tsFiles'] })).rejects.toThrow(/src\/bad\.ts.*not declared/u);
    await expect(reads.read([tsPair(TS_EXCLUDED)], { tables: ['tsFiles'] })).rejects.toThrow(/not declared/u);
    // The same path as a data pair is another pair.
    await expect(reads.read([{ ...tsPair(TS_OK), instance: 'data', variant: 'json' }], { tables: ['dataNodes'] })).rejects.toThrow(/not declared/u);
  });

  it('never answers a ts path read as a data variant: the json fallback is data-only', async () => {
    const declared = [{ ...tsPair(TS_OK), instance: 'data', variant: 'json' } as DeclaredPair];
    const [answer] = await (await handle(declared)).read(declared, { tables: ['dataNodes'] });
    expect(answer).toMatchObject({ state: 'absent', cause: 'unrouted' });
  });
});

describe('declared reads over ts pairs: the ts instance must be staged', () => {
  it('throws a defect naming the pair when a ts pair is declared and the ts instance is not staged', async () => {
    const reads = await stageReads(TS_FILES, { demand: ROUTES_ONLY });
    expect(() => reads([tsPair(TS_OK)])).toThrow(/src\/a\.ts.*ts instance is not staged/u);
  });
});

describe('declared pair typing', () => {
  it('does not accept a data variant for the ts instance', () => {
    // @ts-expect-error the ts instance has no json variant
    const bad: DeclaredPair = { root: ROOT_ID, path: TS_OK, instance: 'ts', variant: 'json' };
    expect(bad.instance).toBe('ts');
  });
});

/**
 * Assert every answer is absent `DATA_REQUEST_UNROUTED` with the given reasons, in order, and a remedy naming the routing.
 *
 * @param answers - The handle's answers
 * @param reasons - The expected unrouted reasons, by answer
 * @param remedy - What the remedy must name
 * @param detailNames - A phrase the detail must also hold, when any
 */
function expectUnrouted<Table extends RowSetTableName>(answers: readonly DeclaredAnswer<Table>[], reasons: readonly unknown[], remedy: RegExp, detailNames?: string): void {
  expect(answers.map((answer) => (answer.state === 'absent' && answer.cause === 'unrouted' ? answer.reason : answer.state))).toStrictEqual(reasons);
  for (const answer of answers) {
    expect(answer).toMatchObject({ state: 'absent', cause: 'unrouted', code: 'DATA_REQUEST_UNROUTED' });
    if (answer.state !== 'absent' || answer.cause !== 'unrouted') continue;
    expect(answer.remedy).toMatch(remedy);
    if (detailNames !== undefined) expect(answer.detail).toContain(detailNames);
    expect(answer.detail).toContain(answer.pair.path);
  }
}
