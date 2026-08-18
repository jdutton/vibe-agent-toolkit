/**
 * How a projection table or column name is spelled inside SQL.
 *
 * Here rather than in each storage backend because the *names* are here: the
 * table registry mints them, so it owns the one rule for quoting them. DuckDB
 * and SQLite happen to agree on that rule (both take the SQL standard's
 * double-quoted delimited identifier), which is what makes one helper honest
 * rather than a coincidence two backends would eventually diverge on.
 */

/**
 * Quote a SQL identifier: double quotes, with any internal double quote doubled.
 *
 * Every table and column name a backend emits comes from the registry, so none
 * of them are hostile today. They are quoted anyway, because "the input is
 * trusted" is a property of today's caller and not of the function: an unquoted
 * identifier path is one new column name away from being either a syntax error
 * (a name with a space or a dash) or an injection point.
 *
 * @param identifier - A table or column name
 * @returns The identifier, quoted and escaped
 *
 * @example
 * quoteIdentifier('blob_sections')  // '"blob_sections"'
 * quoteIdentifier('we"ird')         // '"we""ird"'
 */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
