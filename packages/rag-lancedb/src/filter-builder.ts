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
 * Build SQL filter expression for a single metadata field
 *
 * Strategy:
 * - Strings: Exact match with SQL escaping (`domain = 'security'`)
 * - Numbers: Exact match (`priority = 1`)
 * - Arrays (stored as CSV): LIKE query for substring match (`tags LIKE '%auth%'`)
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
    const strValue = String(value);
    return `${fieldPath} LIKE '%${escapeSQLString(strValue)}%'`;
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
      conditions.push('1 = 0'); // Always false condition
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
