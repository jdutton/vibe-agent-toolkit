/**
 * Fault matrix: `vat claude plugin install`, local/force — shard 23 of 25 (the injections with `shardOf(id, 25) === 22`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['plugin/install/local/force'], 22);
for (const { name, run } of tests) it(name, run);
