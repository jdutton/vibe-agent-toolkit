/**
 * The checks overlap gate: once per `vat validate` run, whether the supervised checks child
 * starts during the resources phase or at its turn, and the one decision the turn awaits.
 *
 * Pure: the settlement, the blob tier and the spawn are fakes, and the routes are admission's own
 * (`storedComputeBy`), so a member the gate calls admitted is one admission admits from the store.
 */

import { createCollectionMimeResolver, type BlobFactsReader, type ResourceEnumeration } from '@vibe-agent-toolkit/resources';
import { describe, expect, it, vi } from 'vitest';

import { abandoningUnread, createChecksOverlapGate } from '../src/commands/checks-overlap-gate.js';
import type { OverlappedRun } from '../src/commands/resources/overlapped-supervision.js';

import {
  ADMITTED_HOME,
  FACTS,
  fakeOverlappedRun,
  HOME_KEY,
  hit,
  keyed,
  MARKDOWN_KEY,
  POPULATION_LIMITS,
  readerOf,
  ROOT,
  settledDecision,
  tierOf,
} from './helpers/overlap-gate-fixtures.js';

const OTHER_MARKDOWN_KEY = `markdown.${'b'.repeat(64)}`;
const RUN = { label: 'the overlapped run' } as unknown as OverlappedRun;
const PENDING = 'pending';

/** A spawn that records each call, and tears its scope down when the gate was disarmed by the mint. */
function fakeSpawn(mint: Promise<void> = Promise.resolve()): {
  calls: number;
  teardowns: number;
  children: number;
  spawn: (isArmed: () => boolean) => Promise<OverlappedRun | 'disarmed'>;
} {
  const fake = {
    calls: 0,
    teardowns: 0,
    children: 0,
    spawn: async (isArmed: () => boolean): Promise<OverlappedRun | 'disarmed'> => {
      fake.calls += 1;
      await mint;
      if (!isArmed()) {
        fake.teardowns += 1;
        return 'disarmed';
      }
      fake.children += 1;
      return RUN;
    },
  };
  return fake;
}

function gateOf(overrides: {
  debug?: boolean;
  cores?: number;
  limits?: typeof POPULATION_LIMITS;
  spawn: (isArmed: () => boolean) => Promise<OverlappedRun | 'disarmed'>;
}): ReturnType<typeof createChecksOverlapGate> {
  return createChecksOverlapGate({
    debug: overrides.debug ?? false,
    cores: () => overrides.cores ?? 4,
    childHomeKey: HOME_KEY,
    limits: overrides.limits ?? POPULATION_LIMITS,
    routing: { resolver: createCollectionMimeResolver(undefined), baseDir: ROOT },
    spawn: overrides.spawn,
  });
}

describe('createChecksOverlapGate', () => {
  it('declines under --debug before the tier is read', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ debug: true, spawn: fake.spawn });
    const { tier, settlement } = ADMITTED_HOME();
    gate.onHomeSettled(HOME_KEY, settlement);
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'debug' } });
    expect(tier.reads).toBe(0);
    expect(fake.calls).toBe(0);
  });

  it('declines on one core before the tier is read', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ cores: 1, spawn: fake.spawn });
    const { tier, settlement } = ADMITTED_HOME();
    gate.onHomeSettled(HOME_KEY, settlement);
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'cores' } });
    expect(tier.reads).toBe(0);
    expect(fake.calls).toBe(0);
  });

  it('declines a home the store did not serve', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    const derived: ResourceEnumeration = {
      paths: [],
      conditions: [],
      outcome: { population: 'derived', stored: 'written' },
      extentSource: 'git',
      stored: null,
    };
    gate.onHomeSettled(HOME_KEY, { ok: true, enumeration: derived });
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'not-hit' } });
    expect(fake.calls).toBe(0);
  });

  it('declines a rejected settlement, carrying its message', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    gate.onHomeSettled(HOME_KEY, { ok: false, error: new Error('the crawl refused') });
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'rejected', error: 'the crawl refused' } });
    expect(fake.calls).toBe(0);
  });

  it('ignores a settlement for another key, and a turn that never saw its own says not-settled', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    const { tier, settlement } = ADMITTED_HOME();
    gate.onHomeSettled('["dist"] home', settlement);
    expect(await settledDecision(gate.decision)).toBe(PENDING);
    expect(tier.reads).toBe(0);
    gate.disarm();
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'not-settled' } });
    expect(fake.calls).toBe(0);
  });

  it('declines when the run parses under other limits than the store\'s facts were filed under', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ limits: { ...POPULATION_LIMITS, outputRows: POPULATION_LIMITS.outputRows / 2 }, spawn: fake.spawn });
    const { tier, settlement } = ADMITTED_HOME();
    gate.onHomeSettled(HOME_KEY, settlement);
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'limits' } });
    expect(tier.reads).toBe(0);
    expect(fake.calls).toBe(0);
  });

  it('declines a member the tier does not cover, naming it and readRoute', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    const tier = tierOf({ [MARKDOWN_KEY]: FACTS, [OTHER_MARKDOWN_KEY]: { kind: 'uncovered', reason: 'evicted' } });
    gate.onHomeSettled(HOME_KEY, hit({ [`${ROOT}/a.md`]: keyed(MARKDOWN_KEY), [`${ROOT}/docs/b.md`]: keyed(OTHER_MARKDOWN_KEY) }, tier.facts));
    expect(await gate.decision).toEqual({
      mode: 'sequential',
      declinedBy: { condition: 'member', member: 'docs/b.md', route: 'readRoute' },
    });
    expect(fake.calls).toBe(0);
  });

  it('declines a member whose stored realization sends it cold, naming storedRoute', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    const tier = tierOf({});
    gate.onHomeSettled(HOME_KEY, hit({ [`${ROOT}/c.md`]: { contentKey: null, contentState: 'unreadable', mime: 'text/markdown' } }, tier.facts));
    expect(await gate.decision).toEqual({
      mode: 'sequential',
      declinedBy: { condition: 'member', member: 'c.md', route: 'storedRoute' },
    });
    expect(fake.calls).toBe(0);
  });

  it('overlaps a hit whose members are all admitted, an oversize readable one included, spawning once', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    const tier = tierOf({ [MARKDOWN_KEY]: FACTS });
    gate.onHomeSettled(HOME_KEY, hit({
      [`${ROOT}/a.md`]: keyed(MARKDOWN_KEY),
      [`${ROOT}/big.md`]: { contentKey: null, contentState: 'oversize', mime: 'text/markdown' },
    }, tier.facts));
    expect(await gate.decision).toEqual({ mode: 'overlapped', run: RUN });
    expect(fake.calls).toBe(1);
    expect(fake.children).toBe(1);
    gate.disarm();
    expect(fake.calls).toBe(1);
  });

  it('declines a rejected tier read with its message, and the memoized rejection still meets a later facts()', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    const refused = new Error('the blob tier could not be read');
    const read = Promise.reject(refused);
    const facts = (): Promise<BlobFactsReader> => read;
    gate.onHomeSettled(HOME_KEY, hit({ [`${ROOT}/a.md`]: keyed(MARKDOWN_KEY) }, facts));
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'rejected', error: 'the blob tier could not be read' } });
    await expect(facts()).rejects.toBe(refused);
    expect(fake.calls).toBe(0);
  });

  it('spawns nothing for a hit that settles after the turn disarmed it', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    gate.disarm();
    const { tier, settlement } = ADMITTED_HOME();
    gate.onHomeSettled(HOME_KEY, settlement);
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'not-settled' } });
    await settledDecision(gate.decision);
    expect(tier.reads).toBe(0);
    expect(fake.calls).toBe(0);
  });

  it('reads no row and spawns nothing when disarmed while the tier read is in flight', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    const read = Promise.withResolvers<BlobFactsReader>();
    const reader = readerOf({ [MARKDOWN_KEY]: FACTS });
    gate.onHomeSettled(HOME_KEY, hit({ [`${ROOT}/a.md`]: keyed(MARKDOWN_KEY) }, () => read.promise));
    gate.disarm();
    read.resolve(reader);
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'disarmed' } });
    await settledDecision(gate.decision);
    expect(reader.answered + reader.built).toBe(0);
    expect(fake.calls).toBe(0);
  });

  it('judges route-only: answers every member\'s key and builds no member\'s facts', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    const tier = tierOf({ [MARKDOWN_KEY]: FACTS, [OTHER_MARKDOWN_KEY]: FACTS });
    gate.onHomeSettled(HOME_KEY, hit({ [`${ROOT}/a.md`]: keyed(MARKDOWN_KEY), [`${ROOT}/b.md`]: keyed(OTHER_MARKDOWN_KEY) }, tier.facts));
    expect(await gate.decision).toEqual({ mode: 'overlapped', run: RUN });
    expect(tier.reads).toBe(2);
    expect(tier.reader.answered).toBe(2);
    expect(tier.reader.built).toBe(0);
  });

  it('tears the minted scope down and spawns no child when disarmed after the mint began', async () => {
    const mint = Promise.withResolvers<undefined>();
    const fake = fakeSpawn(mint.promise);
    const gate = gateOf({ spawn: fake.spawn });
    const { settlement } = ADMITTED_HOME();
    gate.onHomeSettled(HOME_KEY, settlement);
    await settledDecision(gate.decision);
    expect(fake.calls).toBe(1);
    gate.disarm();
    mint.resolve(undefined);
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'disarmed' } });
    await settledDecision(gate.decision);
    expect(fake.teardowns).toBe(1);
    expect(fake.children).toBe(0);
  });

  it('decides only once a scope the disarm caught minting is torn down', async () => {
    // The turn waits for the teardown, so a leftover line it says lands before the sequential
    // checks phase, and a run refusal leaves no minted directory behind.
    const mint = Promise.withResolvers<undefined>();
    const fake = fakeSpawn(mint.promise);
    const gate = gateOf({ spawn: fake.spawn });
    gate.onHomeSettled(HOME_KEY, ADMITTED_HOME().settlement);
    await settledDecision(gate.decision);
    expect(fake.calls).toBe(1);
    gate.disarm();
    expect(await settledDecision(gate.decision)).toBe(PENDING);
    mint.resolve(undefined);
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'disarmed' } });
    expect(fake.teardowns).toBe(1);
  });

  it('keeps the overlapped decision for a spawn that passed its armed check before the turn disarmed', async () => {
    // The spawn has answered `isArmed` and started its child; its handle reaches the gate only
    // after the turn's disarm. The decision must be that child, never `sequential` beside it.
    const handed = Promise.withResolvers<undefined>();
    let children = 0;
    const gate = gateOf({
      spawn: async (isArmed) => {
        await Promise.resolve();
        if (!isArmed()) return 'disarmed';
        children += 1;
        await handed.promise;
        // Asking again after the commit is the same answer.
        return isArmed() ? RUN : 'disarmed';
      },
    });
    const { settlement } = ADMITTED_HOME();
    gate.onHomeSettled(HOME_KEY, settlement);
    await settledDecision(gate.decision);
    expect(children).toBe(1);
    gate.disarm();
    handed.resolve(undefined);
    expect(await gate.decision).toEqual({ mode: 'overlapped', run: RUN });
    expect(children).toBe(1);
  });

  it('declines a spawn that rejects before its armed check, carrying the message', async () => {
    const gate = gateOf({ spawn: () => Promise.reject(new Error('the progress directory could not be minted')) });
    const { settlement } = ADMITTED_HOME();
    gate.onHomeSettled(HOME_KEY, settlement);
    expect(await gate.decision).toEqual({
      mode: 'sequential',
      declinedBy: { condition: 'rejected', error: 'the progress directory could not be minted' },
    });
  });

  it('declines a spawn that rejects after its armed check, carrying the message past a disarm', async () => {
    // The spawn contract: a rejection after `isArmed` answered true comes before the synchronous
    // spawn (the stderr sink would not open), so no child exists and the turn spawns sequentially.
    const opened = Promise.withResolvers<undefined>();
    const gate = gateOf({
      spawn: async (isArmed) => {
        await Promise.resolve();
        if (!isArmed()) return 'disarmed';
        await opened.promise;
        throw new Error('stderr.log could not be opened');
      },
    });
    const { settlement } = ADMITTED_HOME();
    gate.onHomeSettled(HOME_KEY, settlement);
    await settledDecision(gate.decision);
    gate.disarm();
    opened.resolve(undefined);
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'rejected', error: 'stderr.log could not be opened' } });
  });

  it('says a thrown non-Error as its string', async () => {
    const gate = gateOf({ spawn: () => Promise.reject('EMFILE') as Promise<OverlappedRun> });
    const { settlement } = ADMITTED_HOME();
    gate.onHomeSettled(HOME_KEY, settlement);
    expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'rejected', error: 'EMFILE' } });
  });
});

/** A gate that has decided to overlap `child`. */
async function overlappedGate(child: OverlappedRun): Promise<ReturnType<typeof createChecksOverlapGate>> {
  const gate = gateOf({ spawn: (isArmed) => Promise.resolve(isArmed() ? child : 'disarmed') });
  gate.onHomeSettled(HOME_KEY, ADMITTED_HOME().settlement);
  expect(await gate.decision).toEqual({ mode: 'overlapped', run: child });
  return gate;
}

describe('abandoningUnread', () => {
  it('kills the overlapped child on a run refusal', async () => {
    const child = fakeOverlappedRun({ turn: { stderrBytesAtTurn: 0 }, abandonFails: undefined });
    const gate = await overlappedGate(child.run);
    const refusal = new Error('the projection store would not open');

    await expect(abandoningUnread(gate, () => Promise.reject(refusal))).rejects.toBe(refusal);

    expect(child.abandons).toBe(1);
    expect(child.turns).toBe(0);
  });

  it('disarms a gate that has not decided, so a run refusal leaves no child behind', async () => {
    const fake = fakeSpawn();
    const gate = gateOf({ spawn: fake.spawn });
    const refusal = new Error('the blob tier could not be read');

    await expect(abandoningUnread(gate, () => Promise.reject(refusal))).rejects.toBe(refusal);
    gate.onHomeSettled(HOME_KEY, ADMITTED_HOME().settlement);

    expect(await settledDecision(gate.decision)).toEqual({ mode: 'sequential', declinedBy: { condition: 'not-settled' } });
    expect(fake.calls).toBe(0);
  });

  it('abandons a child whose turn never came, after phases that finished', async () => {
    const child = fakeOverlappedRun({ turn: { stderrBytesAtTurn: 0 }, abandonFails: undefined });
    const gate = await overlappedGate(child.run);

    expect(await abandoningUnread(gate, () => Promise.resolve('done'))).toBe('done');
    expect(child.abandons).toBe(1);
  });

  it('leaves a child whose turn came to that turn', async () => {
    const child = fakeOverlappedRun({ turn: { stderrBytesAtTurn: 0 }, abandonFails: undefined });
    const gate = await overlappedGate(child.run);

    expect(await abandoningUnread(gate, async () => {
      await child.run.atTurn(() => undefined);
      return 'done';
    })).toBe('done');
    expect(child.abandons).toBe(0);
  });

  it('throws an abandonment that failed after phases that finished, without saying it on stderr too', async () => {
    const failure = new Error('the progress directory could not be removed');
    const child = fakeOverlappedRun({ turn: { stderrBytesAtTurn: 0 }, abandonFails: failure });
    const gate = await overlappedGate(child.run);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const thrown = await abandoningUnread(gate, () => Promise.resolve('done')).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('the checks child could not be abandoned: the progress directory could not be removed');
      expect((thrown as Error).cause).toBe(failure);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('says an abandonment that failed on stderr and rethrows the original error', async () => {
    const child = fakeOverlappedRun({ turn: { stderrBytesAtTurn: 0 }, abandonFails: new Error('the progress directory could not be removed') });
    const gate = await overlappedGate(child.run);
    const refusal = new Error('the projection store would not open');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(abandoningUnread(gate, () => Promise.reject(refusal))).rejects.toBe(refusal);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual([
        'vat: the checks child could not be abandoned: the progress directory could not be removed\n',
      ]);
    } finally {
      stderr.mockRestore();
    }
  });
});

