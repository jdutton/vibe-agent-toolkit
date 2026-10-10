/**
 * Fault matrix: `vat agent install`, dev/fresh — shard 2 of 3 (the injections with `shardOf(id, 3) === 1`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['agent/install/dev/fresh'], 1);
for (const { name, run } of tests) it(name, run);
