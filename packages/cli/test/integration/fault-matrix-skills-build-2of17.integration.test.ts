/**
 * Fault matrix: `vat skills build` — shard 2 of 17 (the injections with `shardOf(id, 17) === 1`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['skills/build'], 1);
for (const { name, run } of tests) it(name, run);
