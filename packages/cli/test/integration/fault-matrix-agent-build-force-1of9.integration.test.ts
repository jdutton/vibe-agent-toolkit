/**
 * Fault matrix: `vat agent build`, force — shard 1 of 9 (the injections with `shardOf(id, 9) === 0`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['agent/build/force'], 0);
for (const { name, run } of tests) it(name, run);
