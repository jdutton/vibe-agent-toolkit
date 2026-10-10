/**
 * Fault matrix: `vat skill test configure` — shard 3 of 3 (the injections with `shardOf(id, 3) === 2`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['skill/test/configure'], 2);
for (const { name, run } of tests) it(name, run);
