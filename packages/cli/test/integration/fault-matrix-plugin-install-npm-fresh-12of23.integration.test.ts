/**
 * Fault matrix: `vat claude plugin install`, npm/fresh — shard 12 of 23 (the injections with `shardOf(id, 23) === 11`).
 * The cases and the shard table are `fault-matrix/cases/install-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

// First: it mocks the npm download before the install command is loaded.
import '../fault-matrix/cases/npm-download-mock.js';
import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(INSTALL_FAMILY_SHARDS['plugin/install/npm/fresh'], 11);
for (const { name, run } of tests) it(name, run);
