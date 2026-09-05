/**
 * The statement pre-flight in `utils/projection-query.ts`.
 *
 * A typo'd column used to cost a full projection population, because the only
 * place a statement met the schema was after the projection had been built —
 * measured at **8.3 s** on a real adopter tree for `SELECT contentKey,
 * no_such_column FROM blobs`. SQLite resolves names at prepare time, so none of
 * that work was ever needed to know the answer.
 *
 * 🔑 **The ordering is the claim, and it is what these tests assert.** That the
 * statement is refused is already pinned elsewhere; what is new is that it is
 * refused *first*. The negative control is a root that cannot be populated at
 * all: if the pre-flight ran after the population, that root would throw a crawl
 * error and the SQL would never be reached.
 */

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';
import { assertQueriesCompile, withQueriedProjection } from '../../src/utils/projection-query.js';

const logger = createLogger({ debug: false });

/**
 * A statement naming a column `blobs` does not have.
 *
 * The real column is `contentKey`; this is the shape of the typo the pre-flight
 * exists for, and the failure message must name the real one back.
 */
const TYPO_STATEMENT = 'SELECT contentHash FROM blobs';

describe('assertQueriesCompile', () => {
  it('accepts a statement the schema can answer, with no corpus anywhere in sight', async () => {
    // The function takes no root, which is the point: nothing has been
    // populated, and the schema alone decides.
    await expect(assertQueriesCompile(['SELECT path FROM resource_realizations'])).resolves.toBeUndefined();
  });

  it('refuses an unknown column and lists the columns the table DOES have', async () => {
    await expect(assertQueriesCompile([TYPO_STATEMENT])).rejects.toThrow(/contentKey/);
  });

  it('refuses the FIRST bad statement when given several', async () => {
    await expect(assertQueriesCompile([
      'SELECT path FROM resource_realizations',
      'SELECT * FROM no_such_table',
      TYPO_STATEMENT,
    ])).rejects.toThrow(/no such table: no_such_table/);
  });

  it('does nothing at all for an empty list, so a verb that declares none pays nothing', async () => {
    await expect(assertQueriesCompile([])).resolves.toBeUndefined();
  });
});

describe('withQueriedProjection preflight', () => {
  const suite = setupSyncTempDirSuite('vat-preflight');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('refuses the statement BEFORE it tries to populate an unpopulatable root', async () => {
    // 🔑 The ordering assertion. This root does not exist, so a population
    // attempt cannot succeed — and the error that comes back is about the SQL,
    // not about the tree. Reverse the two calls in `withQueriedProjection` and
    // this test reports a filesystem failure instead.
    const missingRoot = safePath.join(tempDir, 'no-such-directory');

    await expect(
      withQueriedProjection(
        { root: missingRoot, logger, preflight: [TYPO_STATEMENT] },
        () => undefined,
      ),
    ).rejects.toThrow(/contentKey/);
  });
});
