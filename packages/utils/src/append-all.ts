/**
 * Append every item to `target`, in order, one at a time.
 *
 * `target.push(...items)` passes each item as an argument, and an argument list
 * past roughly 125,000 entries throws `RangeError: Maximum call stack size
 * exceeded`. A walk is unbounded (a gitignored `.venv` holds 200,000 paths), and
 * a list that is small today is a walk's output tomorrow, so no array is spread
 * into a call here: `local/no-spread-push` refuses the spread and names this.
 *
 * @param target - The array appended to
 * @param items - What to append, in order
 */
export function appendAll<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item);
}
