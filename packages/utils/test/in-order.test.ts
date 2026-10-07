import { describe, expect, it } from 'vitest';

import {
  everyInOrder,
  forEachInOrder,
  FS_CONCURRENCY,
  mapConcurrentFailingInOrder,
  mapInOrder,
  mapWithConcurrency,
  promised,
} from '../src/in-order.js';

/** Resolves after `ms` milliseconds — a macrotask, so calls that overlap genuinely overlap. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A callback that records start/end events and the peak number of calls in
 * flight. Item `failOn` rejects instead of resolving; a reversed delay makes later
 * items finish FIRST when calls overlap, so an order-preserving result is earned.
 */
function recorder(options: { failOn?: number; count: number }) {
  const events: string[] = [];
  let active = 0;
  let peak = 0;
  const fn = (item: number, index: number): Promise<number> => {
    events.push(`start ${item}@${index}`);
    active++;
    peak = Math.max(peak, active);
    return tick(options.count - item).then(() => {
      active--;
      events.push(`end ${item}`);
      if (item === options.failOn) throw new Error(`boom ${item}`);
      return item * 10;
    });
  };
  return { events, fn, peak: () => peak };
}

const ITEMS = [0, 1, 2, 3, 4];

describe('forEachInOrder / mapInOrder', () => {
  it('runs one call at a time, in input order, passing the index', async () => {
    const rec = recorder({ count: ITEMS.length });
    await expect(mapInOrder(ITEMS, rec.fn)).resolves.toEqual([0, 10, 20, 30, 40]);
    expect(rec.peak()).toBe(1);
    expect(rec.events).toEqual(ITEMS.flatMap((i) => [`start ${i}@${i}`, `end ${i}`]));
  });

  it('stops at the first rejection and never starts a later item', async () => {
    const rec = recorder({ count: ITEMS.length, failOn: 2 });
    await expect(forEachInOrder(ITEMS, (item, index) => rec.fn(item, index).then(() => undefined))).rejects.toThrow('boom 2');
    expect(rec.events.at(-1)).toBe('end 2');
    expect(rec.events.some((e) => e.startsWith('start 3'))).toBe(false);
  });

  it('turns a synchronous throw into a rejection and accepts plain return values', async () => {
    const seen: number[] = [];
    const run = forEachInOrder([1, 2, 3], (item) => {
      if (item === 2) throw new Error('sync boom');
      seen.push(item);
    });
    await expect(run).rejects.toThrow('sync boom');
    expect(seen).toEqual([1]);
  });

  it('sees items appended during the run, as for…of does', async () => {
    const items = [1];
    const seen = await mapInOrder(items, (item) => {
      if (item < 3) items.push(item + 1);
      return item;
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('resolves on empty input without calling fn', async () => {
    let calls = 0;
    const count = (): void => {
      calls++;
    };
    await expect(forEachInOrder([], count)).resolves.toBeUndefined();
    await expect(mapInOrder([], count)).resolves.toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('everyInOrder', () => {
  it('stops at the first false without starting later items', async () => {
    const started: number[] = [];
    const result = await everyInOrder(ITEMS, (item) => {
      started.push(item);
      return tick().then(() => item < 2);
    });
    expect(result).toBe(false);
    expect(started).toEqual([0, 1, 2]);
  });

  it('resolves true when every call answers true, and vacuously for no items', async () => {
    await expect(everyInOrder(ITEMS, () => true)).resolves.toBe(true);
    await expect(everyInOrder([], () => false)).resolves.toBe(true);
  });

  it('rejects at the first rejection without starting later items', async () => {
    const rec = recorder({ count: ITEMS.length, failOn: 1 });
    await expect(everyInOrder(ITEMS, (item, index) => rec.fn(item, index).then(() => true))).rejects.toThrow('boom 1');
    expect(rec.events.some((e) => e.startsWith('start 2'))).toBe(false);
  });
});

describe('mapWithConcurrency', () => {
  const MANY = Array.from({ length: 12 }, (_, i) => i);

  it('honours the bound and returns results in input order though later items finish first', async () => {
    const rec = recorder({ count: MANY.length });
    await expect(mapWithConcurrency(MANY, rec.fn, 3)).resolves.toEqual(MANY.map((i) => i * 10));
    expect(rec.peak()).toBe(3);
    // Overlap really happened: some item ended before an earlier-started one.
    expect(rec.events.indexOf('end 2')).toBeLessThan(rec.events.indexOf('end 0'));
  });

  it('defaults the bound to FS_CONCURRENCY', async () => {
    const population = Array.from({ length: FS_CONCURRENCY * 2 }, (_, i) => i);
    const rec = recorder({ count: population.length });
    await mapWithConcurrency(population, rec.fn);
    expect(rec.peak()).toBe(FS_CONCURRENCY);
  });

  it('rejects, and starts no new item once one has rejected', async () => {
    const rec = recorder({ count: MANY.length, failOn: MANY.length - 1 });
    // limit 1 makes "after the rejection" well-defined: the failing item is last-started.
    const failFirst = [MANY.length - 1, ...MANY.slice(0, -1)];
    await expect(mapWithConcurrency(failFirst, rec.fn, 1)).rejects.toThrow(`boom ${MANY.length - 1}`);
    expect(rec.events.filter((e) => e.startsWith('start'))).toHaveLength(1);
  });

  it('resolves [] on empty input', async () => {
    await expect(mapWithConcurrency([], () => 1)).resolves.toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a limit of %s instead of silently resolving holes', async (limit) => {
    await expect(mapWithConcurrency([1], (x) => x, limit)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('mapConcurrentFailingInOrder', () => {
  it('returns results in input order though later items finish first', async () => {
    const rec = recorder({ count: ITEMS.length });
    await expect(mapConcurrentFailingInOrder(ITEMS, rec.fn)).resolves.toEqual([0, 10, 20, 30, 40]);
    expect(rec.events.indexOf('end 4')).toBeLessThan(rec.events.indexOf('end 0'));
  });

  it('settles every call, then rejects with the EARLIEST failure by position, not in time', async () => {
    const ended: number[] = [];
    // Item 0 fails LAST in time and item 2 first; a sequential loop raises item 0's.
    const delays = [30, 10, 1, 20];
    const run = mapConcurrentFailingInOrder(delays, (ms, index) =>
      tick(ms).then(() => {
        ended.push(index);
        if (index === 0 || index === 2) throw new Error(`item ${index}`);
        return index;
      }),
    );
    await expect(run).rejects.toThrow('item 0');
    expect([...ended].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('turns a synchronous throw into the rejection for that item', async () => {
    const boom = new Error('sync');
    const run = mapConcurrentFailingInOrder([1, 2], (item) => {
      if (item === 2) throw boom;
      return item;
    });
    await expect(run).rejects.toBe(boom);
  });

  it('bounds the calls in flight at FS_CONCURRENCY', async () => {
    const population = Array.from({ length: FS_CONCURRENCY * 2 }, (_, i) => i);
    const rec = recorder({ count: population.length });
    await mapConcurrentFailingInOrder(population, rec.fn);
    expect(rec.peak()).toBe(FS_CONCURRENCY);
  });
});

describe('promised', () => {
  it('resolves the body\'s value', async () => {
    const value = { answer: 'the body ran' };
    await expect(promised(() => value)).resolves.toBe(value);
  });

  it('delivers a synchronous throw as a rejection of the same error, never a throw', async () => {
    const boom = new Error('sync');
    let run: Promise<never> | undefined;
    expect(() => {
      run = promised(() => {
        throw boom;
      });
    }).not.toThrow();
    await expect(run).rejects.toBe(boom);
  });
});
