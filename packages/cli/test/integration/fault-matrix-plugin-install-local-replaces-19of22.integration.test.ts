/**
 * Fault matrix: `vat claude plugin install`, local/replaces — shard 19 of 22 (the injections with `shardOf(id, 22) === 18`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['plugin/install/local/replaces'], 18);
for (const { name, run } of tests) it(name, run);
