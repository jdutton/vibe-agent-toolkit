/**
 * Ordered and bounded-parallel iteration over async work — THE replacement for
 * `await` inside a loop.
 *
 * `no-await-in-loop` (Sonar S9382) is on repo-wide, and it is right about the
 * default: independent work belongs in `Promise.all` / `mapWithConcurrency`.
 * When the order IS the contract, say so by name with one of the `*InOrder`
 * helpers instead of a disable. None of them is written with `async` or with a
 * loop: each step is chained onto the previous one's promise, so the rule has
 * nothing to see here and a caller's `await` sits behind a function boundary.
 *
 * Every helper starts its callback synchronously and turns a synchronous throw into
 * a rejection — exactly what the body of an `async` loop does — and a callback may
 * return a plain value.
 */

/** One item's callback: its value and its position in the run. */
type InOrderCallback<T, R> = (item: T, index: number) => Promise<R> | R;

/**
 * Enough parallelism to hide per-call filesystem latency, low enough to stay far
 * from the default file-descriptor ceiling even with several builds at once.
 * The default bound of `mapWithConcurrency`, and the bound every population-sized
 * parallel fs fan-out uses instead of a bare `Promise.all`.
 */
export const FS_CONCURRENCY = 16;

/**
 * `work()` as a promise — its value resolved, a synchronous throw rejected — for a
 * Promise-shaped API whose body is synchronous. `Promise.try`, until the Node floor
 * has it. A body that returns a promise is adopted, so its own throw still rejects.
 */
export function promised<T>(work: () => T): Promise<Awaited<T>> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    // Re-raised as-is: the caller's catch must see exactly what `work` threw.
    return Promise.reject(error as Error);
  }
}

/** Start `fn` now, turning a synchronous throw into a rejection. */
function settle<T, R>(fn: InOrderCallback<T, R>, item: T, index: number): Promise<R> {
  return promised(() => fn(item, index));
}

/**
 * The shared chain: pull the next item, run `fn`, hand the result to `keepGoing`,
 * and continue only when it says so. The iterator is closed on an early stop or a
 * rejection, as `for…of` closes it on `break` or `throw`.
 */
function chainInOrder<T, R>(
  items: Iterable<T>,
  fn: InOrderCallback<T, R>,
  keepGoing: (result: R) => boolean,
): Promise<boolean> {
  return new Promise<boolean>((resolveRun) => {
    const iterator = items[Symbol.iterator]();
    let index = 0;
    const step = (): Promise<boolean> => {
      const next = iterator.next();
      if (next.done === true) return Promise.resolve(true);
      return settle(fn, next.value, index++).then(
        (result) => {
          if (keepGoing(result)) return step();
          iterator.return?.();
          return Promise.resolve(false);
        },
        (error: unknown) => {
          iterator.return?.();
          throw error;
        },
      );
    };
    resolveRun(step());
  });
}

/**
 * Run `fn` over `items` one at a time, each call starting only after the previous
 * one settles.
 *
 * Reach for it when order is the CONTRACT, not an accident: ordered filesystem
 * mutation (mkdir before recursing, a later entry deliberately overwriting an
 * earlier one), first-refusal-wins (the error a user sees must name the FIRST bad
 * item, deterministically — `Promise.all` rejects with the first in time), a
 * shared memo/sink/walk-guard whose first use must not race, a report whose line
 * order is its meaning, or a measurement that must not overlap itself.
 *
 * A rejection stops the run there: later items are never started, exactly as
 * with `await` in `for…of`. Items are pulled lazily from the iterator, so an
 * array that grows during the run is seen. If the items are independent, use
 * `Promise.all` or {@link mapWithConcurrency} instead.
 */
export function forEachInOrder<T>(
  items: Iterable<T>,
  fn: InOrderCallback<T, void>,
): Promise<void> {
  return chainInOrder(items, fn, () => true).then(() => undefined);
}

/**
 * {@link forEachInOrder} that collects each call's result, in input order.
 *
 * For a sequential transform whose steps depend on shared state — a resolver that
 * stages into one root, a cache whose first user must not race — where the caller
 * also needs every result. Stops at the first rejection, like `forEachInOrder`.
 */
export function mapInOrder<T, R>(
  items: Iterable<T>,
  fn: InOrderCallback<T, R>,
): Promise<R[]> {
  const results: R[] = [];
  return chainInOrder(items, fn, (result) => {
    results.push(result);
    return true;
  }).then(() => results);
}

/**
 * `Array#every`, in order and awaited: resolves `false` at the first callback that
 * answers `false`, without starting any later item; resolves `true` when every item
 * answered `true` (vacuously so for no items).
 *
 * The idiom for a loop that used to `break` or `return` early: stop at the first
 * failure and leave the rest untouched — capture whatever the early exit carried in
 * a closure. A rejection stops the run too, and rejects.
 */
export function everyInOrder<T>(
  items: Iterable<T>,
  fn: InOrderCallback<T, boolean>,
): Promise<boolean> {
  return chainInOrder(items, fn, (result) => result);
}

/**
 * `Promise.all`-shaped, but with at most `limit` calls in flight. Results are in
 * input order whatever order the calls finish in.
 *
 * For INDEPENDENT work over a population-sized list — the files in a skill, the
 * skill directories of a plugin — where a bare `Promise.all` would open one file
 * descriptor per item at once. Results are returned rather than pushed into a
 * shared sink from inside the callbacks: concurrent pushes land in finish order,
 * not input order, so fold the returned array afterwards.
 *
 * Rejects with the first rejection in TIME, and stops starting new items once one
 * has rejected (calls already in flight run to completion). When the error a user
 * sees must name the first bad item in input order, this is the wrong tool — use
 * {@link forEachInOrder}.
 *
 * @throws RangeError when `limit` is not a whole number of at least 1 — a `NaN`
 *   or `0` limit would otherwise start no workers and silently resolve holes.
 */
export function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: InOrderCallback<T, R>,
  limit: number = FS_CONCURRENCY,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    return Promise.reject(new RangeError(`mapWithConcurrency limit must be a whole number of at least 1, got ${String(limit)}`));
  }
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  let failed = false;
  const worker = (): Promise<void> => {
    if (failed || next >= items.length) return Promise.resolve();
    const index = next++;
    return settle(fn, items[index] as T, index).then(
      (result) => {
        results[index] = result;
        return worker();
      },
      (error: unknown) => {
        failed = true;
        throw error;
      },
    );
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  return Promise.all(workers).then(() => results);
}

type Outcome<R> = { readonly ok: true; readonly value: R } | { readonly ok: false; readonly error: unknown };

/**
 * {@link mapWithConcurrency} for independent read-only work whose failure must
 * still be the one a sequential loop would have raised: every call settles, then
 * the rejection of the EARLIEST item by position is rethrown. Results are in
 * input order.
 */
export function mapConcurrentFailingInOrder<T, R>(
  items: readonly T[],
  fn: InOrderCallback<T, R>,
): Promise<R[]> {
  return mapWithConcurrency(items, (item, index): Promise<Outcome<R>> =>
    settle(fn, item, index).then(
      (value): Outcome<R> => ({ ok: true, value }),
      (error: unknown): Outcome<R> => ({ ok: false, error }),
    ),
  ).then((outcomes) =>
    outcomes.map((outcome) => {
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    }),
  );
}
