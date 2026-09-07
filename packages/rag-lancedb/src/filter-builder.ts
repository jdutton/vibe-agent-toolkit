/**
 * Filter Builder for LanceDB SQL WHERE clauses
 *
 * Introspects Zod schemas to build type-safe SQL filters.
 * Uses duck typing for Zod v3/v4 compatibility.
 */

import { assertFiltersProducedConditions, assertQuerySupported, type QuerySupport } from '@vibe-agent-toolkit/rag';
import { getZodTypeName, unwrapZodType, ZodTypeNames } from '@vibe-agent-toolkit/utils';
import type { ZodObject, ZodRawShape, ZodTypeAny } from 'zod';

/**
 * The clause for "this filter is satisfiable by nothing".
 *
 * 🔑 Shared by every branch that can receive an empty list, so the branches cannot answer
 * the same question differently. `resourceId: []` and `metadata: { tags: [] }` are the same
 * request — filter to a set I have computed, and the set is empty — and an empty result is
 * the only honest answer to it. The alternative that produced itself accidentally, an
 * always-true `LIKE '%%'`, returns the entire index to a caller who asked to be filtered.
 */
const ALWAYS_FALSE = '1 = 0';

/**
 * Escape single quotes for SQL string literals
 *
 * Used to prevent SQL injection in WHERE clauses.
 * Doubles single quotes per SQL standard ('Bob's' → 'Bob''s')
 *
 * @param value - String value to escape
 * @returns Escaped string safe for SQL string literals
 */
export function escapeSQLString(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * The character that turns a `LIKE` metacharacter back into the character the caller typed.
 *
 * Backslash is the conventional choice and is not special inside a standard SQL single-quoted
 * literal, so `'%a\%b%'` reaches the engine with the backslash intact and the `ESCAPE` clause
 * is the only thing that gives it meaning.
 */
const LIKE_ESCAPE_CHAR = '\\';

/** `%` and `_` are `LIKE`'s wildcards; the escape character has to join them or it is unescapable. */
const LIKE_METACHARACTERS = /[\\%_]/u;

/**
 * Neutralise `LIKE` metacharacters so a member matches ITSELF rather than a family of strings.
 *
 * 🚨 THE MIRROR OF THE STRINGIFY-TO-NOTHING GUARD, and it was the half left open. That guard
 * closes "satisfiable by nothing"; this closes "satisfiable by EVERYTHING". Interpolating the
 * member raw made `['%']` emit `tags LIKE '%%%'` — every row in the index — and `['_']` emit
 * `tags LIKE '%_%'` — every non-empty one. Neither backstop can see it: `assertQuerySupported`
 * sees a supported key, and `assertFiltersProducedConditions` counts one condition and is
 * satisfied, because counting cannot tell a condition that discriminates from one that does not.
 *
 * The escape character is escaped FIRST by being a member of the same class, so `['\\']`
 * cannot slip through as an escape of the pattern's own trailing `%`.
 */
function escapeLikePattern(value: string): string {
  return value.replaceAll(/[\\%_]/gu, (char) => `${LIKE_ESCAPE_CHAR}${char}`);
}

/**
 * One `LIKE` condition for one member.
 *
 * 🔑 The `ESCAPE` clause is appended ONLY when the member actually carries a metacharacter, so
 * every member that works today — which is every member without a `%`, `_` or `\` — emits the
 * exact fragment it has always emitted. The clause changes no meaning where it would be a no-op,
 * and it appears only on the queries that are currently answered wrongly, which is also the
 * blast radius if an engine ever rejects `ESCAPE`: a loud refusal on a query that today returns
 * the whole index in silence.
 */
function buildMemberLike(fieldPath: string, member: string): string {
  const pattern = `%${escapeLikePattern(member)}%`;
  const clause = `${fieldPath} LIKE '${escapeSQLString(pattern)}'`;

  return LIKE_METACHARACTERS.test(member)
    ? `${clause} ESCAPE '${LIKE_ESCAPE_CHAR}'`
    : clause;
}

/**
 * Build the SQL fragment for an array-typed metadata field.
 *
 * 🚨 THE MECHANISM IS STRINGIFICATION, NOT LENGTH, and the first fix here named it wrongly.
 * The pattern is built from `String(member)`, so the tautology `tags LIKE '%%'` — a condition
 * matching EVERY row, handed to a caller who asked to be filtered — appears for every value
 * that stringifies to nothing, not only for `[]`. A guard phrased as `value.length === 0`
 * closed the one reported instance and left `['']`, a bare `''` and `[[]]` live, each of
 * which reaches here without a type error because `filters.metadata` is deliberately open
 * (`z.record(z.string(), z.unknown())`). So the branch is on the STRINGIFIED result.
 *
 * ⚠️ That guard is only HALF the widening class — it answers "satisfiable by nothing". The
 * mirror, "satisfiable by everything", lives in {@link escapeLikePattern}: a member that is
 * itself a `LIKE` metacharacter was read as a wildcard and matched the whole index. Read both
 * before touching either; closing one and declaring the class shut is how this reopened.
 *
 * "Filter to the tags I computed, and I computed none" is the ordinary way to arrive here,
 * and it is a request nothing satisfies — exactly as an empty `resourceId` array already
 * resolved, via the shared {@link ALWAYS_FALSE}.
 *
 * This also matters more than a normal tautology would: `assertFiltersProducedConditions`
 * counts conditions and cannot tell one that matches everything from one that discriminates,
 * so a vacuous clause sails through the backstop that exists to prevent exactly this.
 *
 * 🔑 Each member gets its OWN `LIKE`. Arrays are stored as `value.join(',')`
 * (`serializeArray` in `schema.ts`), so matching the whole list as one substring —
 * `tags LIKE '%auth,security%'` — required the caller to guess the stored ORDER: a document
 * tagged `security,auth` did not match `['auth','security']`, and the caller got zero rows
 * with nothing to say why. That direction is narrowing rather than widening, so it was never
 * a safety bug, but it is silently wrong and there is no reason to keep it.
 *
 * @param fieldPath - The lowercased column name
 * @param value - The filter value: a list of members, or a single member
 * @returns A SQL fragment, or the always-false clause when nothing can satisfy it
 */
function buildArrayFilter(fieldPath: string, value: unknown): string {
  const members = (Array.isArray(value) ? value : [value]).map(String);

  // An empty pattern is `LIKE '%%'`, which is every row. Nothing can satisfy a request for a
  // member that is the empty string, so the whole conjunction is unsatisfiable.
  if (members.length === 0 || members.includes('')) {
    return ALWAYS_FALSE;
  }

  const conditions = members.map((member) => buildMemberLike(fieldPath, member)).join(' AND ');

  // Parenthesised only when there is more than one, so a single-member list keeps the exact
  // fragment it has always emitted and stays composable with the outer ` AND ` join.
  return members.length > 1 ? `(${conditions})` : conditions;
}

/**
 * Build SQL filter expression for a single metadata field
 *
 * Strategy:
 * - Strings: Exact match with SQL escaping (`domain = 'security'`)
 * - Numbers: Exact match (`priority = 1`)
 * - Arrays (stored as CSV): one LIKE per member, ANDed (`(tags LIKE '%a%' AND tags LIKE '%b%')`)
 * - Booleans: Exact match (`active = true`)
 *
 * BREAKING CHANGE: Metadata fields are now stored as top-level columns.
 * Filters use direct column access instead of struct notation.
 *
 * @param key - Metadata field name
 * @param value - Filter value
 * @param zodType - Zod type for this field
 * @returns SQL WHERE clause fragment
 */
export function buildMetadataFilter(key: string, value: unknown, zodType: ZodTypeAny): string {
  // Unwrap optional/nullable types to get actual type
  const actualType = unwrapZodType(zodType);
  const typeName = getZodTypeName(actualType);

  // Metadata fields are stored with lowercase column names following SQL convention
  // No quotes needed since lowercase columns are unambiguous
  const fieldPath = key.toLowerCase();

  // Handle enum fields (enums are stored as strings)
  if (typeName === ZodTypeNames.ENUM || typeName === ZodTypeNames.NATIVENUM) {
    const strValue = String(value);
    return `${fieldPath} = '${escapeSQLString(strValue)}'`;
  }

  // Handle string fields
  if (typeName === ZodTypeNames.STRING) {
    const strValue = String(value);
    return `${fieldPath} = '${escapeSQLString(strValue)}'`;
  }

  // Handle number fields
  if (typeName === ZodTypeNames.NUMBER || typeName === ZodTypeNames.BIGINT) {
    return `${fieldPath} = ${Number(value)}`;
  }

  // Handle boolean fields (stored as 0/1 in LanceDB)
  if (typeName === ZodTypeNames.BOOLEAN) {
    const numericValue = value ? 1 : 0;
    return `${fieldPath} = ${numericValue}`;
  }

  // Handle array fields (stored as CSV strings)
  if (typeName === ZodTypeNames.ARRAY) {
    return buildArrayFilter(fieldPath, value);
  }

  // Fallback: string comparison
  const strValue = String(value);
  return `${fieldPath} = '${escapeSQLString(strValue)}'`;
}

/**
 * Build WHERE clause from metadata filters
 *
 * @param metadataFilters - Partial metadata object with filter values
 * @param schema - Zod schema for metadata validation
 * @returns SQL WHERE clause fragment or null if no filters
 */
export function buildMetadataWhereClause(
  metadataFilters: Record<string, unknown> | undefined,
  schema: ZodObject<ZodRawShape>
): string | null {
  if (!metadataFilters || Object.keys(metadataFilters).length === 0) {
    return null;
  }

  const conditions: string[] = [];

  for (const [key, value] of Object.entries(metadataFilters)) {
    if (value === undefined) {
      continue;
    }

    // Get Zod type for this field from schema
    const zodType = schema.shape[key];
    if (!zodType) {
      // 🚨 This used to `continue`, and skipping is the same silent-widening defect the
      // top-level guard refuses: a key with no branch contributes no condition, and a
      // query left with no conditions runs unfiltered over the whole index. It became
      // indefensible once the top-level refusals started telling callers to "move it to
      // `filters.metadata`" — under a custom metadata schema that lacks the field, obeying
      // that remedy landed the caller straight back in the bug. Column names are also
      // lowercased on write, so `headingpath` vs `headingPath` reached here too.
      const declared = Object.keys(schema.shape)
        .map((name) => ['`', name, '`'].join(''))
        .join(', ');
      throw new Error(
        `Unknown metadata filter field \`${key}\`: it is not declared in this provider's ` +
          `metadata schema, so it can never match. Declared fields are ${declared}. ` +
          'Filtering on an undeclared field would contribute no condition and let the query ' +
          'run unfiltered over the entire index, so it is refused rather than skipped.',
      );
    }

    conditions.push(buildMetadataFilter(key, value, zodType));
  }

  return conditions.length > 0 ? conditions.join(' AND ') : null;
}

/**
 * What this provider can honour in a query.
 *
 * 🔑 An ALLOWLIST, and the whole point of the shape. Enumerating the four fields known
 * to be unimplemented would close four instances and leave the class open: any other
 * unrecognised key — a typo'd `resourceid`, a field lifted from a design document, a
 * field a future release declares before implementing — would still widen in silence.
 * Declaring what IS read refuses everything else by construction.
 */
export const LANCEDB_QUERY_SUPPORT: QuerySupport = {
  filterKeys: ['resourceId', 'metadata'],
  hybridSearch: false,
};

/**
 * Build complete WHERE clause from RAG query filters
 *
 * Handles both core filters (resourceId) and custom metadata filters. A key this
 * provider does not read throws rather than being dropped, and so does a filter that
 * was supplied but resolved to no condition at all.
 *
 * @param filters - RAG query filters
 * @param metadataSchema - Zod schema for metadata
 * @returns Complete SQL WHERE clause, or null when no filter was requested
 * @throws Error if `filters` carries an unsupported key, an undeclared metadata field,
 *   or asks for a filter that produces no condition
 */
export function buildWhereClause<TMetadata extends Record<string, unknown>>(
  filters: {
    resourceId?: string | string[];
    metadata?: Partial<TMetadata>;
  } | undefined,
  metadataSchema: ZodObject<ZodRawShape>
): string | null {
  if (!filters) {
    return null;
  }

  // Guarded here as well as in `query()` because this is public API: a caller can reach
  // the filter→SQL path without going through the provider, and a guard with a bypass is
  // worse than none because it advertises a safety it does not have. One implementation,
  // two entry points.
  assertQuerySupported({ filters: filters as Record<string, unknown> }, LANCEDB_QUERY_SUPPORT);

  const conditions: string[] = [];

  // Handle resourceId filter
  if (filters.resourceId !== undefined) {
    const ids = Array.isArray(filters.resourceId) ? filters.resourceId : [filters.resourceId];

    // Handle empty array case - should match nothing
    if (ids.length === 0) {
      conditions.push(ALWAYS_FALSE);
    } else {
      const idList = ids.map((id) => `'${escapeSQLString(id)}'`).join(', ');
      // Use lowercase (no backticks needed)
      conditions.push(`resourceid IN (${idList})`);
    }
  }

  // Handle metadata filters
  if (filters.metadata) {
    const metadataClause = buildMetadataWhereClause(filters.metadata as Record<string, unknown>, metadataSchema);
    if (metadataClause) {
      conditions.push(metadataClause);
    }
  }

  // The backstop an allowlist structurally cannot provide: a SUPPORTED key whose value
  // resolves to nothing still yields zero conditions, and zero conditions is
  // indistinguishable at the point of use from "no filter was requested" — which is
  // exactly how the original defect widened.
  assertFiltersProducedConditions(filters as Record<string, unknown>, conditions.length);

  return conditions.length > 0 ? conditions.join(' AND ') : null;
}
