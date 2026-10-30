/**
 * Fault matrix: `vat claude plugin install`, npm-postinstall/fresh — shard 20 of 23 (the injections with `shardOf(id, 23) === 19`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['plugin/install/npm-postinstall/fresh'], 19);
for (const { name, run } of tests) it(name, run);
