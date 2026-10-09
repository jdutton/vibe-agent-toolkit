/**
 * Fault matrix: `vat skills install`, dir/fresh — shard 4 of 6 (the injections with `shardOf(id, 6) === 3`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['skills/install/dir/fresh'], 3);
for (const { name, run } of tests) it(name, run);
