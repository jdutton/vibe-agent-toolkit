/**
 * Filter Builder for LanceDB SQL WHERE clauses
 *
 * Introspects Zod schemas to build type-safe SQL filters.
 */

import type { ZodObject, ZodRawShape, ZodTypeAny } from 'zod';
import { z } from 'zod';

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
  // Unwrap optional types
  let actualType = zodType;
  if (zodType instanceof z.ZodOptional) {
    actualType = zodType.unwrap();
  }

  // Metadata fields are stored as top-level columns for scale-efficient filtering
  // Use backticks for column name escaping
  const fieldPath = `\`${key}\``;

  // Handle enum fields (enums are stored as strings)
  if (actualType instanceof z.ZodEnum) {
    const strValue = String(value);
    return `${fieldPath} = '${escapeSQLString(strValue)}'`;
  }

  // Handle string fields
  if (actualType instanceof z.ZodString) {
    const strValue = String(value);
    return `${fieldPath} = '${escapeSQLString(strValue)}'`;
  }

  // Handle number fields
  if (actualType instanceof z.ZodNumber) {
    return `${fieldPath} = ${Number(value)}`;
  }

  // Handle boolean fields (stored as 0/1 in LanceDB)
  if (actualType instanceof z.ZodBoolean) {
    const numericValue = value ? 1 : 0;
    return `${fieldPath} = ${numericValue}`;
  }

  // Handle array fields (stored as CSV strings)
  if (actualType instanceof z.ZodArray) {
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
 * Build complete WHERE clause from RAG query filters
 *
 * Handles both core filters (resourceId) and custom metadata filters.
 *
 * @param filters - RAG query filters
 * @param metadataSchema - Zod schema for metadata
 * @returns Complete SQL WHERE clause or null
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

  const conditions: string[] = [];

  // Handle resourceId filter
  if (filters.resourceId !== undefined) {
    const ids = Array.isArray(filters.resourceId) ? filters.resourceId : [filters.resourceId];

    // Handle empty array case - should match nothing
    if (ids.length === 0) {
      conditions.push('1 = 0'); // Always false condition
    } else {
      const idList = ids.map((id) => `'${escapeSQLString(id)}'`).join(', ');
      // Use backticks for column names
      conditions.push(`\`resourceId\` IN (${idList})`);
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
