/**
 * Fault matrix: `vat rag clear`, db — shard 1 of 3 (the injections with `shardOf(id, 3) === 0`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['rag/clear/db'], 0);
for (const { name, run } of tests) it(name, run);
