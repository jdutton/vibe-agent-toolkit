/**
 * Refusing a filter that would widen the search
 *
 * 🚨 The failure this guards WIDENS rather than narrows: a filter that contributes no SQL
 * condition degrades into an UNFILTERED full-recall search over the entire index, with no
 * error and no warning. Unknown filter keys are refused by the strict `RAGQuerySchema`;
 * this is the guard for a SUPPLIED filter that still produced no condition.
 */

/**
 * Wrap an identifier in the backticks these messages use for code.
 *
 * @param name - The identifier to render
 * @returns The name in backticks
 */
function quoted(name: string): string {
  return `\`${name}\``;
}

/**
 * Refuse a filter set that asked for something and produced no condition at all.
 *
 * This is the backstop under the strict `RAGQuerySchema.shape.filters`, and it catches what a
 * schema structurally cannot: a key that IS declared whose value resolves to nothing.
 * `filters: { metadata: { tags: opts.tags } }` with an undefined `opts.tags` passes every
 * key check and still yields zero conditions — and zero conditions is indistinguishable,
 * at the point of use, from "no filter was requested", which is precisely how the original
 * defect widened.
 *
 * A filter object with no keys at all is NOT a request, and returns normally.
 *
 * ⚠️ KNOW WHAT THIS CANNOT SEE. It counts CONDITIONS, so a condition that matches every row
 * satisfies it completely — `metadata: { tags: [] }` once became `tags LIKE '%%'` and passed
 * this check while doing the exact thing the check exists to prevent. Counting cannot be
 * strengthened into catching that: only the code that BUILT a clause knows what the clause
 * means, and sniffing the emitted SQL for a tautology would be a guess about a string this
 * module did not write, wrong for the next tautology shape that appears. So the obligation
 * sits with the builder: a value satisfiable by nothing must emit an explicitly always-false
 * condition (`1 = 0`), never a vacuous one. This function's job is the different, narrower
 * one it can actually do — refusing a request that produced NO condition at all.
 *
 * 🔑 STATE THE OBLIGATION AS THE BUILDER MUST IMPLEMENT IT, because the first attempt
 * implemented the example instead of the property. `[]` is not the condition — STRINGIFYING TO
 * NOTHING is, and `['']`, a bare `''` and `[[]]` all do, so a builder guarding on
 * `value.length === 0` still emitted the tautology for three of the four and still satisfied
 * this count. The rule the builder owes is about the pattern it is about to emit, never about
 * the shape of the value it received.
 *
 * @param filters - The filter object the caller supplied
 * @param conditionCount - How many SQL conditions it produced
 * @throws Error if the caller asked for a filter and none survived
 */
export function assertFiltersProducedConditions(
  filters: Record<string, unknown>,
  conditionCount: number,
): void {
  if (conditionCount > 0) {
    return;
  }

  const requested = Object.entries(filters).filter(([, value]) => {
    if (value === undefined) {
      return false;
    }
    // An empty `metadata: {}` states no criteria, so it is not a request either.
    return !(typeof value === 'object' && value !== null && Object.keys(value).length === 0);
  });

  if (requested.length === 0) {
    return;
  }

  const named = requested.map(([key]) => quoted(`filters.${key}`)).join(', ');
  throw new Error(
    `RAG filter produced no condition: ${named} ` +
      'was supplied but resolved to nothing — most often a field whose value was `undefined`. ' +
      'Running the query anyway would perform an unfiltered search over the entire index and ' +
      'return results the filter was meant to exclude, so it is refused. Omit the filter to ' +
      'search everything deliberately.',
  );
}
