/**
 * Fault matrix: `vat claude plugin uninstall`, key — shard 8 of 8 (the injections with `shardOf(id, 8) === 7`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['plugin/uninstall/key'], 7);
for (const { name, run } of tests) it(name, run);
