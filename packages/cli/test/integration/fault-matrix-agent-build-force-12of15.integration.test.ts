/**
 * Fault matrix: `vat agent build`, force — shard 12 of 15 (the injections with `shardOf(id, 15) === 11`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['agent/build/force'], 11);
for (const { name, run } of tests) it(name, run);
