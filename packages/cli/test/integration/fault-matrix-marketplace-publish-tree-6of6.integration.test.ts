/**
 * Fault matrix: `vat claude marketplace publish`, the publish-tree lane — shard 6 of 6 (the injections with `shardOf(id, 6) === 5`).
 * The cases and the shard table are `fault-matrix/cases/build-family.ts`; the runner is `fault-matrix/matrix.ts`.
 */
import { it } from 'vitest';

// First: it makes the git lane a no-op before the publish command is loaded.
import '../fault-matrix/cases/publish-tree-git-mock.js';
import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { planMatrixShard } from '../fault-matrix/matrix.js';

const tests = await planMatrixShard(BUILD_FAMILY_SHARDS['marketplace/publish-tree'], 5);
for (const { name, run } of tests) it(name, run);
