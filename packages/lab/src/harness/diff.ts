/**
 * The two pieces every facet's comparator needs before it can say anything
 * about its own numbers.
 *
 * Neither is about what is being measured, which is why neither belongs in a
 * facet: lining two reports up by name and naming *both* sides at fault are
 * properties of a comparison, not of call counts or milliseconds. Written per
 * facet they would drift — one comparator sorting its pairs and another
 * following read order, one refusal naming the baseline and stopping there —
 * and every one of those drifts produces a well-formed comparison that reads
 * differently from its sibling for no reason a reader could discover.
 */

/** One item as it appears on each side, either of which may be absent. */
export interface Pairing<T> {
  readonly key: string;
  readonly before: T | null;
  readonly after: T | null;
}

/**
 * Line two collections up by key, in a stable order.
 *
 * Sorted so that two identical comparisons serialise identically; a pairing that
 * followed read order would make a diff differ from itself.
 *
 * @param before - The baseline collection
 * @param after - The compared collection
 * @param key - How to identify an item across the two sides
 * @returns One pairing per distinct key, ascending
 */
export function pairByKey<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
): readonly Pairing<T>[] {
  const left = new Map(before.map((item) => [key(item), item] as const));
  const right = new Map(after.map((item) => [key(item), item] as const));
  const keys = [...new Set([...left.keys(), ...right.keys()])];
  keys.sort((a, b) => a.localeCompare(b));
  return keys.map((each) => ({
    key: each,
    before: left.get(each) ?? null,
    after: right.get(each) ?? null,
  }));
}

/**
 * Ask both sides the same question and join whatever they answer.
 *
 * Every two-sided gate must name **every** side at fault rather than the first
 * one found. A reason that stopped at the baseline would send a reader to
 * re-capture one report and leave them puzzled when the second capture refused
 * for the same reason all over again.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @param caveat - What to ask of one side, given how to name it
 * @returns The joined clauses, or `null` when neither side had one
 */
export function bothSides<TRow>(
  before: TRow,
  after: TRow,
  caveat: (row: TRow, side: string) => string | null,
): string | null {
  const clauses = [caveat(before, 'baseline'), caveat(after, 'compared side')].filter(
    (clause): clause is string => clause !== null,
  );
  return clauses.length === 0 ? null : clauses.join('; and ');
}
