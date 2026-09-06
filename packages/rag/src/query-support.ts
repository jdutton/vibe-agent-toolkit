/**
 * Refusing a query a provider cannot honour
 *
 * 🚨 The failure this exists to prevent WIDENS rather than narrows. A filter key a
 * provider does not read contributes no SQL condition, and a provider applies a WHERE
 * clause only when one was produced — so a query whose only filter is an unread key
 * degrades into an UNFILTERED full-recall search over the entire index. Plausible
 * results, drawn from exactly the documents the filter was meant to exclude, with no
 * error and no warning. A RAG filter is usually a correctness or access boundary, which
 * puts that closer to a data-exposure defect than to a missing feature.
 *
 * 🔑 This is an ALLOWLIST, deliberately. An earlier shape enumerated the four fields
 * known to be unimplemented, which closed four instances and left the class open: any
 * OTHER unrecognised key — a typo'd `resourceid`, a field from a design document, a
 * field a future release declares before implementing it — still widened silently. A
 * provider declares what it supports; everything else is refused.
 *
 * 🔑 Support is DECLARED BY THE PROVIDER rather than hardcoded here, because "which
 * filters work" is a property of the provider, not of the query surface. A provider that
 * implements `dateRange` says so and stops refusing it, with no edit to this module.
 */

/**
 * What a provider can actually honour in a query.
 *
 * Every provider declares this for itself; there is no default, because a default would
 * quietly become the answer for a provider that never thought about the question.
 */
export interface QuerySupport {
  /** Filter keys this provider reads. Any other key in `query.filters` is refused. */
  readonly filterKeys: readonly string[];

  /** Whether this provider performs a keyword pass. When false, `hybridSearch` is refused. */
  readonly hybridSearch: boolean;
}

/**
 * Remedies for filter keys VAT's published query surface declares.
 *
 * Only consulted for a key the provider did NOT declare support for, so a provider that
 * implements one of these never shows its remedy. A key with no entry gets the generic
 * message naming the supported keys.
 */
const KNOWN_FILTER_REMEDIES = new Map<string, string>([
  [
    'dateRange',
    'this provider implements no date-range filter. Model the date as a field on your metadata schema and filter via `filters.metadata`, or filter the returned chunks yourself.',
  ],
  ['tags', 'move it to `filters.metadata.tags` — it is a metadata field and is honoured only there.'],
  ['type', 'move it to `filters.metadata.type` — it is a metadata field and is honoured only there.'],
  [
    'headingPath',
    'move it to `filters.metadata.headingPath` — it is a metadata field and is honoured only there.',
  ],
]);

/** Shared tail explaining why refusal beats being ignored. Stated once, not per key. */
const WIDENING_EXPLANATION =
  'These are refused rather than ignored because ignoring them widens the search: an ' +
  'unread filter contributes no SQL condition, so the query would run as an unfiltered ' +
  'search over the entire index and return results the filter was meant to exclude.';

/**
 * Wrap an identifier in the backticks these messages use for code.
 *
 * A named helper rather than an inline template: nesting one template literal inside
 * another is a readability smell the linter rejects, and every message here needs it.
 *
 * @param name - The identifier to render
 * @returns The name in backticks
 */
function quoted(name: string): string {
  return `\`${name}\``;
}

/**
 * Describe one unsupported filter key.
 *
 * @param key - The offending key
 * @param supported - Filter keys the provider declared
 * @returns A bullet line naming the key and what to do about it
 */
function describeOffender(key: string, supported: readonly string[]): string {
  const supportedList = supported.map(quoted).join(' and ');
  const remedy =
    KNOWN_FILTER_REMEDIES.get(key) ??
    `this provider reads only ${supportedList}. Check the spelling, or move the value ` +
      'under `filters.metadata` if it is a metadata field.';
  return `  - ${quoted('filters.' + key)}: ${remedy}`;
}

/**
 * Refuse a query carrying anything the provider cannot honour.
 *
 * Reports EVERY offending key in one error — both unsupported filters and an unsupported
 * `hybridSearch` — so a query carrying several does not have to be fixed several times.
 *
 * Call this before doing any work: it is deterministic and needs neither a connection nor
 * an embedding, so an unindexed provider reports the unsupported field rather than
 * reporting that nothing is indexed yet.
 *
 * @param query - The query as supplied by the caller
 * @param support - What this provider declares it can honour
 * @throws Error naming every unsupported key present, and its remedy
 */
export function assertQuerySupported(
  query: { filters?: Record<string, unknown> | undefined; hybridSearch?: { enabled: boolean; keywordWeight?: number } | undefined },
  support: QuerySupport,
): void {
  const problems: string[] = [];

  if (query.filters) {
    const supported = new Set(support.filterKeys);
    for (const [key, value] of Object.entries(query.filters)) {
      if (value !== undefined && !supported.has(key)) {
        problems.push(describeOffender(key, support.filterKeys));
      }
    }
  }

  // `keywordWeight` is refused alongside `enabled` because it too reaches nothing. Leaving
  // it silent would keep a smaller version of the same defect: a caller who tuned a weight
  // would get results indistinguishable from not having tuned it.
  if (!support.hybridSearch && query.hybridSearch !== undefined) {
    if (query.hybridSearch.enabled) {
      problems.push(
        '  - `hybridSearch.enabled`: this provider implements no hybrid search — every search is pure vector search. Omit `hybridSearch`, or set `enabled: false` to say a pure vector search is what you want.',
      );
    }
    if (query.hybridSearch.keywordWeight !== undefined) {
      problems.push(
        '  - `hybridSearch.keywordWeight`: this provider implements no keyword pass, so a weight reaches nothing. Remove it.',
      );
    }
  }

  if (problems.length === 0) {
    return;
  }

  throw new Error(
    `Unsupported RAG query field${problems.length > 1 ? 's' : ''}:\n${problems.join('\n')}\n\n${WIDENING_EXPLANATION}`,
  );
}

/**
 * Refuse a filter set that asked for something and produced no condition at all.
 *
 * This is the backstop under {@link assertQuerySupported}, and it catches what an
 * allowlist structurally cannot: a key that IS supported whose value resolves to nothing.
 * `filters: { metadata: { tags: opts.tags } }` with an undefined `opts.tags` passes every
 * key check and still yields zero conditions — and zero conditions is indistinguishable,
 * at the point of use, from "no filter was requested", which is precisely how the original
 * defect widened.
 *
 * A filter object with no keys at all is NOT a request, and returns normally.
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
