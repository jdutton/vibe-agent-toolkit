/**
 * Filter Builder for LanceDB SQL WHERE clauses
 *
 * Introspects Zod schemas to build type-safe SQL filters.
 * Uses duck typing for Zod v3/v4 compatibility.
 */

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
      // Field not in schema - skip it
      continue;
    }

    conditions.push(buildMetadataFilter(key, value, zodType));
  }

  return conditions.length > 0 ? conditions.join(' AND ') : null;
}

/**
 * Filter keys VAT's published query surface declares that no shipped provider reads
 * at that position, each mapped to what the caller should do instead.
 *
 * 🚨 These are refused rather than ignored because ignoring them WIDENS. An unread
 * key contributes no SQL condition, and `LanceDBRAGProvider.query()` applies a WHERE
 * clause only when one was produced — so a query whose only filter is one of these
 * would run as an unfiltered full-recall vector search over the entire index, and
 * return plausible results drawn from exactly the documents the filter was meant to
 * exclude. A RAG filter is usually a correctness or access boundary, which makes the
 * silent-widening version closer to a data-exposure defect than to a missing feature.
 *
 * `tags`, `type` and `headingPath` are ordinary metadata fields; only their position
 * at the top level of `filters` is unsupported. `dateRange` is implemented nowhere.
 */
const UNSUPPORTED_FILTERS = new Map<string, string>([
  [
    'dateRange',
    'no provider implements a date-range filter at any position. Model the date as a field on your metadata schema and filter via `filters.metadata`, or filter the returned chunks yourself.',
  ],
  ['tags', 'move it to `filters.metadata.tags` — it is a metadata field and is honoured only there.'],
  ['type', 'move it to `filters.metadata.type` — it is a metadata field and is honoured only there.'],
  [
    'headingPath',
    'move it to `filters.metadata.headingPath` — it is a metadata field and is honoured only there.',
  ],
]);

/**
 * Refuse a filter object carrying a key no provider reads
 *
 * @param filters - RAG query filters, as supplied by the caller
 * @throws Error naming every unsupported key present, and its remedy
 */
export function assertFiltersAreSupported(filters: Record<string, unknown>): void {
  const offenders = Object.entries(filters)
    .filter(([key, value]) => value !== undefined && UNSUPPORTED_FILTERS.has(key))
    .map(([key]) => `  - \`filters.${key}\`: ${UNSUPPORTED_FILTERS.get(key) ?? ''}`);

  if (offenders.length === 0) {
    return;
  }

  throw new Error(
    `Unsupported RAG filter${offenders.length > 1 ? 's' : ''}:\n${offenders.join('\n')}\n\n` +
      'These are refused rather than ignored because ignoring them widens the search: ' +
      'an unread filter contributes no SQL condition, so the query would run as an ' +
      'unfiltered search over the entire index and return results the filter was meant ' +
      'to exclude.',
  );
}

/**
 * Build complete WHERE clause from RAG query filters
 *
 * Handles both core filters (resourceId) and custom metadata filters. Any key in
 * {@link UNSUPPORTED_FILTERS} throws rather than being dropped.
 *
 * @param filters - RAG query filters
 * @param metadataSchema - Zod schema for metadata
 * @returns Complete SQL WHERE clause or null
 * @throws Error if `filters` carries a declared-but-unimplemented key
 */
export function buildWhereClause<TMetadata extends Record<string, unknown>>(
  filters: {
    resourceId?: string | string[];
    metadata?: Partial<TMetadata>;
    /** 🚨 Implemented by no provider. Passing it THROWS — see {@link UNSUPPORTED_FILTERS}. */
    dateRange?: { start: Date; end: Date };
    /** 🚨 Unsupported at this position. Passing it THROWS; use `metadata.tags`. */
    tags?: string[];
    /** 🚨 Unsupported at this position. Passing it THROWS; use `metadata.type`. */
    type?: string;
    /** 🚨 Unsupported at this position. Passing it THROWS; use `metadata.headingPath`. */
    headingPath?: string;
  } | undefined,
  metadataSchema: ZodObject<ZodRawShape>
): string | null {
  if (!filters) {
    return null;
  }

  assertFiltersAreSupported(filters);

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
    const metadataClause = buildMetadataWhereClause(filters.metadata, metadataSchema);
    if (metadataClause) {
      conditions.push(metadataClause);
    }
  }

  return conditions.length > 0 ? conditions.join(' AND ') : null;
}
