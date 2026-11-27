/**
 * The row-set tier of a store double that holds none: what a double whose suite never extracts
 * data rows answers the two row-set members with.
 */

import type { RowSetId } from '../../src/projection/row-set-id.js';
import type { RowSetRows, RowSetTableName } from '../../src/projection/row-set-table-registry.js';
import type { RowSetRead, RowSetRequest } from '../../src/projection/store.js';

/**
 * A read of a store holding no row set: every requested table present and empty, every id absent.
 *
 * @param _ids - The row sets asked
 * @param request - The tables asked
 * @returns The empty answer
 */
export function readNoRowSets<Table extends RowSetTableName>(_ids: readonly RowSetId[], request: RowSetRequest<Table>): Promise<RowSetRead<Table>> {
  const rows = Object.fromEntries(request.tables.map((table) => [table, []])) as unknown as Pick<RowSetRows, Table>;
  return Promise.resolve({ rows, present: new Set() });
}

/**
 * A write to a store that keeps no row set: nothing is filed.
 *
 * @returns Settles at once
 */
export function writeNoRowSets(): Promise<void> {
  return Promise.resolve();
}
