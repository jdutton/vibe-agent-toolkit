/**
 * Fault matrix: `vat skills build` — shard 26 of 26 (the injections with `shardOf(id, 26) === 25`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['skills/build'], 25);
for (const { name, run } of tests) it(name, run);
