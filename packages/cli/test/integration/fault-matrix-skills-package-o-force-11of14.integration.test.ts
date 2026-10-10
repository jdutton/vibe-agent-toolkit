/**
 * Fault matrix: `vat skills package`, o-force — shard 11 of 14 (the injections with `shardOf(id, 14) === 10`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['skills/package/o-force'], 10);
for (const { name, run } of tests) it(name, run);
