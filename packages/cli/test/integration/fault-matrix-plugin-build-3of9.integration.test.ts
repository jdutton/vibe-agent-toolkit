/**
 * Fault matrix: `vat claude plugin build` — shard 3 of 9 (the injections with `shardOf(id, 9) === 2`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['plugin/build'], 2);
for (const { name, run } of tests) it(name, run);
