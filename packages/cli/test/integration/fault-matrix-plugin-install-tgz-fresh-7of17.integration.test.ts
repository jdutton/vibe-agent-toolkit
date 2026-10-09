/**
 * Fault matrix: `vat claude plugin install`, tgz/fresh — shard 7 of 17 (the injections with `shardOf(id, 17) === 6`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['plugin/install/tgz/fresh'], 6);
for (const { name, run } of tests) it(name, run);
