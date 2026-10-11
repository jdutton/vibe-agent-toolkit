/**
 * Fault matrix: `vat agent install`, copy/force — shard 5 of 8 (the injections with `shardOf(id, 8) === 4`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['agent/install/copy/force'], 4);
for (const { name, run } of tests) it(name, run);
