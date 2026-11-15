/**
 * Fault matrix: `vat build` — shard 46 of 61 (the injections with `shardOf(id, 61) === 45`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['top-level-build'], 45);
for (const { name, run } of tests) it(name, run);
