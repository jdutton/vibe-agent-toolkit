/**
 * Fault matrix: `vat claude plugin uninstall`, all — shard 6 of 18 (the injections with `shardOf(id, 18) === 5`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['plugin/uninstall/all'], 5);
for (const { name, run } of tests) it(name, run);
