/**
 * The loop that drives a target list — pull hand-out in, stepped windows out.
 *
 * Both crawl lanes share one loop (`driveInOrder`), and until now it stepped: it
 * sliced `width` targets, awaited **all** of them, emitted them, and only then
 * touched the next slice. That barrier is what starved the pool. A slice is as
 * long as its slowest member, so every fast preparation in it sat finished while
 * the pool it feeds went idle waiting for one straggler — measured at roughly
 * **20% worker utilization**, threads starved rather than contended.
 *
 * The approved shape is a PULL hand-out: a target is claimed the moment a slot
 * frees, so the tail is bounded by ONE preparation instead of by a whole slice.
 *
 * ## Why these tests drive the loop directly
 *
 * The two lane suites (`resource-registry-pool`, `projection-blob-population-pool`)
 * drive it through a real crawl, which is what makes them worth having and also
 * what makes them unable to see this: from outside, a stepped window and a pull
 * hand-out produce the same rows in the same order. The difference is *when a
 * target is claimed*, and only a fake preparation whose completion the test
 * controls can observe that. Every gate here is an explicit deferred, never a
 * timer — a timing-shaped assertion about a scheduler is a flake, not a proof.
 *
 * What each test pins:
 *
 * - **The barrier is gone.** A straggler must not stop the slot beside it from
 *   taking the next target. This is the one assertion the old loop cannot pass.
 * - **The look-ahead is bounded.** Preparation may run ahead of emission, but
 *   only so far — an unbounded read-ahead buffers the whole corpus's prepared
 *   facts in memory the moment the first target is slow.
 * - **The fan-out is bounded.** Still at most `width` preparations at once; that
 *   is the EMFILE argument the sequential loop existed for.
 * - **Order is unchanged.** Emission follows the target list, never completion.
 * - **Width 1 is still strictly sequential** — one prepared, one emitted, before
 *   the next is touched. That is what makes the pull loop inert while the pool
 *   ships off.
 * - **A failure surfaces corpus-first**, not whichever preparation raced ahead.
 */

import { describe, expect, it } from 'vitest';

import { driveInOrder, type ParsableRemainder, type ParseWindow } from '../src/parse-dispatcher.js';

/**
 * A remainder carrying `count` markdown documents and nothing else.
 *
 * Every case here is about the LOOP's hand-out, not about sizing, so one kind is
 * enough — and reading the markdown count back is how a case says which targets
 * the loop believed were still unclaimed.
 *
 * @param count - Documents still to be handed over
 * @returns The tally the loop's activation callback answers with
 */
const markdownRemainder = (count: number): ParsableRemainder => ({ markdown: count, html: 0 });

/** Nothing left to parse — the answer for a case that is not about the tally. */
const NOTHING_LEFT: ParsableRemainder = { markdown: 0, html: 0 };

/**
 * A window policy standing in for a `ParseDispatcher`.
 *
 * `width` is mutable so a test can widen it from inside `considerActivation`,
 * which is how activation reaches the loop in production.
 */
interface StubWindow {
  width: number;
  lookAhead: number;
  considerActivation: ParseWindow['considerActivation'];
  /** Every remaining markdown count the loop offered the activation policy. */
  readonly asked: number[];
}

/**
 * A fixed-width window that records what it was asked and never widens.
 *
 * @param width - Preparations allowed in flight at once
 * @param lookAhead - Multiple of the width preparation may run ahead by
 * @returns A stub the loop can be driven with
 */
const windowOf = (width: number, lookAhead = 4): StubWindow => {
  const stub: StubWindow = {
    width,
    lookAhead,
    considerActivation: (remainingParsable): void => {
      stub.asked.push(remainingParsable().markdown);
    },
    asked: [],
  };
  return stub;
};

/** One blocked preparation's resolvers. */
interface Gate {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

/** A preparation harness whose completions the test releases by hand. */
interface Gated {
  /** The `prepare` half to hand the loop. */
  prepare: (target: string) => Promise<string>;
  /** Targets whose preparation has STARTED, in start order. */
  readonly started: string[];
  /** Targets whose preparation is blocked right now. */
  outstanding: () => string[];
  /** The widest fan-out seen — the file-handle-relevant number. */
  peakInFlight: () => number;
  /** Let one target's preparation finish. */
  release: (target: string) => void;
  /** Let one target's preparation fail. */
  fail: (target: string, error: Error) => void;
}

/**
 * A `prepare` that blocks until the test says otherwise.
 *
 * Deferreds rather than timers: the questions here are about the ORDER in which
 * targets are claimed, and a timer-based fake answers them with a race.
 *
 * @returns The harness
 */
const gatedPrepare = (): Gated => {
  const gates = new Map<string, Gate>();
  const started: string[] = [];
  const flight = { now: 0, peak: 0 };

  /**
   * Take one gate, refusing to guess at a target that is not blocked.
   *
   * @param target - The target whose preparation should settle
   * @returns Its resolvers
   */
  const take = (target: string): Gate => {
    const gate = gates.get(target);
    if (gate === undefined) throw new Error(`no preparation is outstanding for ${target}`);
    gates.delete(target);
    flight.now -= 1;
    return gate;
  };

  return {
    started,
    outstanding: (): string[] => [...gates.keys()],
    peakInFlight: (): number => flight.peak,
    prepare: async (target: string): Promise<string> => {
      started.push(target);
      flight.now += 1;
      flight.peak = Math.max(flight.peak, flight.now);
      return new Promise<string>((resolve, reject) => {
        gates.set(target, { resolve, reject });
      });
    },
    release: (target: string): void => {
      take(target).resolve(target);
    },
    fail: (target: string, error: Error): void => {
      take(target).reject(error);
    },
  };
};

/**
 * Let every pending microtask and timer callback run.
 *
 * The loop takes several microtask hops between a settled preparation and the
 * claim it triggers, so a bare `await Promise.resolve()` would observe it
 * mid-step.
 */
const flush = async (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Release everything currently blocked, round after round, until the drive ends.
 *
 * @param gated - The harness
 * @param rounds - How many release/settle rounds to run
 * @param hold - One target to leave blocked throughout
 */
const drain = async (gated: Gated, rounds: number, hold?: string): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    for (const target of gated.outstanding()) {
      if (target !== hold) gated.release(target);
    }
    // Serial on purpose: a round must settle before the next one can see what
    // the loop claimed in response to it.
    await flush();
  }
};

/** Targets for the fixtures that do not care how many there are. */
const FOUR = ['a', 'b', 'c', 'd'];

/** A longer list, for the bound assertions. */
const TWELVE = Array.from({ length: 12 }, (_unused, index) => `t${String(index)}`);

/**
 * How far preparation may run ahead of emission, at width 2.
 *
 * Written out rather than imported from the source: a test that derived its
 * expectation from the constant under test would keep passing if that constant
 * were changed to something absurd.
 */
const LOOK_AHEAD_AT_WIDTH_TWO = 8;

/**
 * Start a drive over {@link FOUR}, with the emission log the order tests read.
 *
 * Extracted because three tests need the same five lines of preamble, and five
 * lines repeated is a duplication-check failure before it is a readability one.
 *
 * @param width - Preparations allowed in flight at once
 * @returns The gate harness, the emissions as they happen, and the drive to await
 */
const driveFour = (
  width: number,
): { gated: Gated; emitted: string[]; done: Promise<void> } => {
  const gated = gatedPrepare();
  const emitted: string[] = [];
  return {
    gated,
    emitted,
    done: driveInOrder(FOUR, windowOf(width), gated.prepare, (p) => emitted.push(p), () => NOTHING_LEFT),
  };
};

describe('driveInOrder', () => {
  it('claims the next target when a slot frees, without waiting for the straggler beside it', async () => {
    // THE test. Under the stepped window `c` belongs to the next slice and
    // cannot be touched until every member of this one has finished, so `a`
    // holding the slice hostage keeps `started` at two. Under the pull hand-out
    // `b` finishing frees a slot and `c` is claimed immediately.
    const { gated, emitted, done } = driveFour(2);

    await flush();
    expect(gated.started).toStrictEqual(['a', 'b']);

    gated.release('b');
    await flush();

    expect(gated.started).toStrictEqual(['a', 'b', 'c']);
    // And nothing was emitted: `b` is ready but `a` is the head, so order still
    // rules the emit side even though the claim side ran ahead.
    expect(emitted).toStrictEqual([]);

    await drain(gated, FOUR.length);
    await done;

    expect(emitted).toStrictEqual(FOUR);
  });

  it('stops claiming once preparation is a bounded distance ahead of emission', async () => {
    // The head never finishes, so nothing is ever emitted. An unbounded
    // read-ahead would claim all twelve and hold eleven prepared results in
    // memory; the bound is width x look-ahead.
    const gated = gatedPrepare();
    const done = driveInOrder(TWELVE, windowOf(2), gated.prepare, () => undefined, () => NOTHING_LEFT);

    await flush();
    await drain(gated, TWELVE.length, 't0');

    expect(gated.started).toHaveLength(LOOK_AHEAD_AT_WIDTH_TWO);
    // Still bounded by the width, never by the look-ahead: the extra distance is
    // prepared RESULTS waiting to be emitted, not open file handles.
    expect(gated.peakInFlight()).toBe(2);

    await drain(gated, TWELVE.length);
    await done;
  });

  it('takes the look-ahead distance from the window, not from a module constant', async () => {
    // The bound the previous case pins is `width x lookAhead`. Driving the same
    // width at a different look-ahead is what proves the loop READS it: with the
    // distance baked in, this would claim LOOK_AHEAD_AT_WIDTH_TWO regardless.
    const gated = gatedPrepare();
    const done = driveInOrder(TWELVE, windowOf(2, 3), gated.prepare, () => undefined, () => NOTHING_LEFT);

    await flush();
    await drain(gated, TWELVE.length, 't0');

    expect(gated.started).toHaveLength(6);

    await drain(gated, TWELVE.length);
    await done;
  });

  it('never prepares more than the window width at once', async () => {
    const gated = gatedPrepare();
    const done = driveInOrder(TWELVE, windowOf(3), gated.prepare, () => undefined, () => NOTHING_LEFT);

    await flush();
    await drain(gated, TWELVE.length);
    await done;

    expect(gated.started).toHaveLength(TWELVE.length);
    expect(gated.peakInFlight()).toBe(3);
  });

  it('emits in target order however preparation completes', async () => {
    const { gated, emitted, done } = driveFour(4);

    await flush();
    expect(gated.started).toStrictEqual(FOUR);

    for (const target of ['d', 'c', 'b', 'a']) gated.release(target);
    await done;

    expect(emitted).toStrictEqual(FOUR);
  });

  it('is strictly sequential at width 1', async () => {
    // The safety property that lets both lanes carry this loop while the pool
    // ships off: one target prepared, one target emitted, before the next is
    // touched. Any read-ahead here would change what an un-pooled crawl does.
    const gated = gatedPrepare();
    const log: string[] = [];
    const done = driveInOrder(
      FOUR,
      windowOf(1),
      async (target) => {
        log.push(`prepare ${target}`);
        return gated.prepare(target);
      },
      (prepared) => log.push(`emit ${prepared}`),
      () => NOTHING_LEFT,
    );

    await drain(gated, FOUR.length);
    await done;

    expect(log).toStrictEqual([
      'prepare a',
      'emit a',
      'prepare b',
      'emit b',
      'prepare c',
      'emit c',
      'prepare d',
      'emit d',
    ]);
    expect(gated.peakInFlight()).toBe(1);
  });

  it('raises the corpus-first failure, not whichever preparation raced ahead', async () => {
    const { gated, emitted, done } = driveFour(4);

    await flush();
    // `c` fails first in time; `b` is first in the corpus and must win.
    gated.fail('c', new Error('third'));
    gated.fail('b', new Error('second'));
    gated.release('a');
    gated.release('d');

    await expect(done).rejects.toThrow('second');
    expect(emitted).toStrictEqual(['a']);
  });

  it('offers the activation policy the count from the first UNCLAIMED target', async () => {
    // The count feeds `considerActivation`, which decides how many workers the
    // remaining work can pay for. Targets already claimed are being prepared
    // right now; a count that included them would buy threads for work that is
    // already in flight.
    //
    // ⚠️ Width 3, and that is the whole test. At width 1 the emitted head IS the
    // last claimed target, so the two candidate indexes coincide and this passes
    // whichever the loop uses — a green test proving nothing. Mutation-checked:
    // at width 1 swapping the two leaves all eight tests green.
    const targets = TWELVE.slice(0, 6);
    const gated = gatedPrepare();
    const stub = windowOf(3);
    const seen: number[] = [];
    const done = driveInOrder(
      targets,
      stub,
      gated.prepare,
      () => undefined,
      (from) => {
        seen.push(from);
        return markdownRemainder(targets.length - from);
      },
    );

    await drain(gated, targets.length);
    await done;

    // Three claimed up front and emitted together, then three more claimed and
    // emitted together: the count never counts a target already being prepared.
    expect(seen).toStrictEqual([3, 3, 3, 6, 6, 6]);
    expect(stub.asked).toStrictEqual([3, 3, 3, 0, 0, 0]);
  });

  it('lets a widened window reach the very next claim, not the next slice', async () => {
    const gated = gatedPrepare();
    const stub = windowOf(1);
    stub.considerActivation = (remainingParsable): void => {
      stub.asked.push(remainingParsable().markdown);
      stub.width = 4;
    };
    const done = driveInOrder(TWELVE, stub, gated.prepare, () => undefined, () => NOTHING_LEFT);

    await flush();
    expect(gated.started).toStrictEqual(['t0']);

    gated.release('t0');
    await flush();

    expect(gated.started).toStrictEqual(['t0', 't1', 't2', 't3', 't4']);

    await drain(gated, TWELVE.length);
    await done;
  });
});
