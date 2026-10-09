/**
 * Fault matrix: `vat agent build`, output — shard 4 of 7 (the injections with `shardOf(id, 7) === 3`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['agent/build/output'], 3);
for (const { name, run } of tests) it(name, run);
