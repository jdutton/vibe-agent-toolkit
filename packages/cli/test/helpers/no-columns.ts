/**
 * A `columnsOf` for a unit test whose check rows are faked: the statement's columns are not what
 * the test is about. A test about near misses passes the columns its statement selects instead.
 */

import type { ColumnsOfStatement } from '../../src/utils/projection-query.js';

/** No result columns, so no near miss. */
export const NO_COLUMNS: ColumnsOfStatement = () => [];
