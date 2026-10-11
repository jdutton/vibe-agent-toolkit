/**
 * Fault matrix: `vat build` — shard 27 of 36 (the injections with `shardOf(id, 36) === 26`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['top-level-build'], 26);
for (const { name, run } of tests) it(name, run);
