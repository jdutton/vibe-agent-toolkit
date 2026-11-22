/**
 * `vat validate`'s checks overlap: built from the run it listens to, and, over a fake child and
 * stubbed counters, the post-spawn window its dump states, and how every ending of the run ends the
 * child and still writes the dump. Pure: the run, the child, the counters and the dump are fakes.
 */

import { RunPopulation } from '@vibe-agent-toolkit/resources';
import { WORK_COUNTER_NAMES, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  createValidateChecksOverlap,
  gateOptionsFor,
  liveOverlapSeams,
  type OverlapSeams,
  type ValidateChecksOverlap,
} from '../src/commands/validate-checks-overlap.js';
import { validateDebugFacts, type ChecksPhaseObservation, type ValidateDebugFacts } from '../src/commands/validate-debug-facts.js';
import type { RunContext } from '../src/utils/resource-loader.js';

import { ADMITTED_HOME, fakeOverlappedRun, HOME_KEY, POPULATION_LIMITS, ROOT, type FakeOverlappedRun } from './helpers/overlap-gate-fixtures.js';

/** A run carrying only what the gate reads. */
const runAt = (root: string): RunContext => ({ population: { root }, dispatcher: { limits: POPULATION_LIMITS } }) as unknown as RunContext;

/** Every queued callback, and the ones they queue, has run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('gateOptionsFor', () => {
  it('routes members against the population\'s own root spelling, not the root the verb resolved', () => {
    // The verb resolved `/tmp/project`; the population names its members by its realpath. A
    // routing base in the verb's spelling would make every member look foreign to the resolver.
    const options = gateOptionsFor(
      runAt('/private/tmp/project'),
      { root: '/tmp/project', debug: false, base: undefined, config: undefined },
      () => 4,
    );

    expect(options.routing.baseDir).toBe('/private/tmp/project');
    expect(options.childHomeKey).toBe(RunPopulation.homeKey([]));
    expect(options.limits).toBe(POPULATION_LIMITS);
    expect(options.debug).toBe(false);
  });
});

describe('liveOverlapSeams', () => {
  it('collects an unreachable object without the --expose-gc command-line flag', async () => {
    const seams = liveOverlapSeams({ root: ROOT, debug: false, base: undefined, config: undefined }, {});
    const held = new WeakRef({ payload: 'garbage once this job ends' });
    // A WeakRef target is kept alive until the job that created it ends.
    await flush();

    seams.collectGarbage();

    expect(held.deref()).toBeUndefined();
  });
});

/** The store and parse-cache writes the stubbed counters report; every other counter is 0. */
interface Writes {
  store: number;
  parseCache: number;
}

/** The major collections the parent ran. */
interface Collections {
  count: number;
}

/**
 * An overlap over `child`, its home settled as a store hit every member of which is admitted.
 *
 * @param child - The fake child
 * @param collectionFails - What the collector throws, or `undefined` for one that succeeds
 */
async function overlapOver(child: FakeOverlappedRun, collectionFails?: Error): Promise<{ overlap: ValidateChecksOverlap; writes: Writes; dumps: ChecksPhaseObservation[]; collections: Collections }> {
  const writes: Writes = { store: 0, parseCache: 0 };
  const dumps: ChecksPhaseObservation[] = [];
  const collections: Collections = { count: 0 };
  const spawned = Promise.withResolvers<undefined>();
  const seams: OverlapSeams = {
    cores: () => 4,
    start: (isArmed) => {
      const armed = isArmed();
      spawned.resolve(undefined);
      return Promise.resolve(armed ? child.run : 'disarmed');
    },
    counters: () => ({
      ...Object.fromEntries(WORK_COUNTER_NAMES.map((name) => [name, 0])) as Record<WorkCounter, number>,
      'store.writes.persistent': writes.store,
      'parse.cache.written': writes.parseCache,
    }),
    writeFacts: (observed) => dumps.push(observed),
    collectGarbage: () => {
      collections.count += 1;
      if (collectionFails !== undefined) throw collectionFails;
    },
  };
  const overlap = createValidateChecksOverlap({ root: ROOT, debug: false, base: undefined, config: undefined, checksPhase: true }, seams);
  overlap.homeSettledListener(runAt(ROOT))(HOME_KEY, ADMITTED_HOME().settlement);
  await spawned.promise;
  await flush();
  return { overlap, writes, dumps, collections };
}

/** The checks phase as validate runs it: take the decision, and read an overlapped child at its turn. */
async function checksPhase(overlap: ValidateChecksOverlap): Promise<void> {
  const decision = await overlap.checksTurn();
  // `runPhase` records a turn's throw as the phase's own; the run goes on.
  if (decision.mode === 'overlapped') await decision.run.atTurn(() => undefined).catch(() => undefined);
}

/** The one dump the run wrote. */
function onlyDump(dumps: readonly ChecksPhaseObservation[]): ValidateDebugFacts {
  expect(dumps).toHaveLength(1);
  const [observed] = dumps;
  if (observed === undefined) throw new Error('no dump');
  return validateDebugFacts(observed);
}

describe('createValidateChecksOverlap', () => {
  it('counts the parent\'s writes from the spawn to the child\'s exit, and none after the exit', async () => {
    const child = fakeOverlappedRun({ turn: { stderrBytesAtTurn: 7 }, abandonFails: undefined });
    const { overlap, writes, dumps, collections } = await overlapOver(child);
    // In the window: after the spawn, before the child exits.
    writes.store = 2;
    writes.parseCache = 1;
    child.exit();
    await flush();
    // After the child's exit, before the turn: the skills phase of a real run, say.
    writes.store = 5;
    writes.parseCache = 4;

    await overlap.runPhases(() => checksPhase(overlap));

    expect(onlyDump(dumps)).toEqual({
      checksOverlapped: 1,
      gateDeclinedBy: null,
      childStderrBytesAtTurn: 7,
      parentStoreWritesUntilChildExit: 2,
      parentParseCacheWritesUntilChildExit: 1,
    });
    expect(child.abandons).toBe(0);
    // One major collection at the overlapped turn, the one a sequential parent gets while it idles.
    expect(collections.count).toBe(1);
  });

  it('hands the checks turn its overlapped decision when the collector throws', async () => {
    const child = fakeOverlappedRun({ turn: { stderrBytesAtTurn: 7 }, abandonFails: undefined });
    const { overlap, collections } = await overlapOver(child, new Error('V8 refused --expose-gc after start'));

    const decision = await overlap.checksTurn();

    expect(decision.mode).toBe('overlapped');
    expect(collections.count).toBe(1);
    await overlap.runPhases(async () => {
      if (decision.mode === 'overlapped') await decision.run.atTurn(() => undefined);
    });
    expect(child.abandons).toBe(0);
    expect(child.turns).toBe(1);
  });

  it('abandons a child whose turn a run refusal took away, and still writes the dump without waiting for an exit that never comes', async () => {
    const child = fakeOverlappedRun({ turn: { stderrBytesAtTurn: 7 }, abandonFails: undefined });
    const { overlap, writes, dumps, collections } = await overlapOver(child);
    writes.store = 1;
    const refusal = new Error('the projection store would not open');

    await expect(overlap.runPhases(() => Promise.reject(refusal))).rejects.toBe(refusal);

    expect(child.abandons).toBe(1);
    expect(collections.count).toBe(0);
    expect(onlyDump(dumps)).toMatchObject({ checksOverlapped: 1, childStderrBytesAtTurn: 0, parentStoreWritesUntilChildExit: 1 });
  });

  it('writes the dump after a turn that rejected, for a child that never exits', async () => {
    const child = fakeOverlappedRun({ turn: new Error('stat refused'), abandonFails: undefined });
    const { overlap, writes, dumps } = await overlapOver(child);
    writes.parseCache = 3;

    await overlap.runPhases(() => checksPhase(overlap));

    expect(child.abandons).toBe(0);
    expect(onlyDump(dumps)).toMatchObject({ checksOverlapped: 1, childStderrBytesAtTurn: 0, parentParseCacheWritesUntilChildExit: 3 });
  });

  it('abandons a child whose turn never came after phases that finished, and writes the dump', async () => {
    const child = fakeOverlappedRun({ turn: { stderrBytesAtTurn: 7 }, abandonFails: undefined });
    const { overlap, dumps, collections } = await overlapOver(child);

    await overlap.runPhases(() => Promise.resolve());

    expect(child.abandons).toBe(1);
    expect(child.turns).toBe(0);
    expect(collections.count).toBe(0);
    expect(onlyDump(dumps)).toMatchObject({ checksOverlapped: 1 });
  });

  it('states a sequential run with the gate\'s decline and no window, and runs no collection at its turn', async () => {
    const dumps: ChecksPhaseObservation[] = [];
    const collections: Collections = { count: 0 };
    const overlap = createValidateChecksOverlap(
      { root: ROOT, debug: true, base: undefined, config: undefined, checksPhase: true },
      {
        cores: () => 4,
        start: () => Promise.reject(new Error('never spawned')),
        counters: () => { throw new Error('never read'); },
        writeFacts: (observed) => dumps.push(observed),
        collectGarbage: () => {
          collections.count += 1;
        },
      },
    );
    overlap.homeSettledListener(runAt(ROOT))(HOME_KEY, ADMITTED_HOME().settlement);

    await overlap.runPhases(() => checksPhase(overlap));

    expect(onlyDump(dumps)).toEqual({
      checksOverlapped: 0,
      gateDeclinedBy: { condition: 'debug' },
      childStderrBytesAtTurn: 0,
      parentStoreWritesUntilChildExit: 0,
      parentParseCacheWritesUntilChildExit: 0,
    });
    expect(collections.count).toBe(0);
  });
});
