/**
 * Fault matrix: `vat skills package`, o-fresh — shard 7 of 15 (the injections with `shardOf(id, 15) === 6`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['skills/package/o-fresh'], 6);
for (const { name, run } of tests) it(name, run);
