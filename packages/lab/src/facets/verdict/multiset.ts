/**
 * The one multiset difference the verdict facet uses — for the finding layer
 * of a row (`compare.ts`) and for reconciling observed against declared deltas
 * (`deltas.ts`). Duplicates count: two equal items on one side and one on the
 * other leave one unmatched.
 */

/**
 * Match `left` against `right` item for item by `keyOf`, keeping duplicates.
 *
 * @param left - One side
 * @param right - The other side
 * @param keyOf - Identity both sides are matched on
 * @returns What only `left` has, and what only `right` has, each in its own order
 */
export function multisetDifference<TLeft, TRight>(
  left: readonly TLeft[],
  right: readonly TRight[],
  keyOf: (item: TLeft | TRight) => string,
): { readonly onlyLeft: TLeft[]; readonly onlyRight: TRight[] } {
  const pending = new Map<string, TLeft[]>();
  for (const item of left) {
    const key = keyOf(item);
    pending.set(key, [...(pending.get(key) ?? []), item]);
  }
  const onlyRight: TRight[] = [];
  for (const item of right) {
    const matches = pending.get(keyOf(item));
    if (matches === undefined || matches.length === 0) onlyRight.push(item);
    else matches.shift();
  }
  return { onlyLeft: [...pending.values()].flat(), onlyRight };
}
