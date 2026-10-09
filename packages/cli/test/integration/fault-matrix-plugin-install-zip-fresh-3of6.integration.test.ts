/**
 * Fault matrix: `vat claude plugin install`, zip/fresh — shard 3 of 6 (the injections with `shardOf(id, 6) === 2`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['plugin/install/zip/fresh'], 2);
for (const { name, run } of tests) it(name, run);
