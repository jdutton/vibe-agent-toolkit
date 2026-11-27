/**
 * I0's workspace defect seeds (spec 6.4, under the one-finding-per-broken-file ruling): the pnpm
 * corpus plus one plant, each its own corpus (`../helpers/workspace-rows.ts`), asserted alike on
 * every arm (store-off, cold, warm, half the blob tier evicted):
 *
 * - a `<<` read key (`WORKSPACE_MERGE_KEY`), a duplicated read key (`WORKSPACE_DUPLICATE_KEY`), a defective root
 *   input (`WORKSPACE_ROOT_NO_ROWS`) and an excluded `pnpm-workspace.yaml` the pnpm root needs
 *   (`DATA_REQUEST_UNROUTED`): the one root refuses, so the family does, and both workspace checks break with the code
 *   leading their reason and naming the file, while `data__values` (and `data__conditions`) over
 *   the same file answers;
 * - a defective member `package.json`: no refusal; its row is kept with nulls and a
 *   `WORKSPACE_MEMBER_NO_ROWS` condition, every range that could name it a `WORKSPACE_TARGET_UNKNOWN`;
 * - a workspace root above the analysis root (`WORKSPACE_ROOT_OUTSIDE_ROOT`) and a pnpm root with
 *   no `pnpm-workspace.yaml` (`WORKSPACE_NOT_DECLARED`): no refusal; no members, and one condition
 *   at the manifest that declares the `workspace:` dependency.
 *
 * Every run reports exactly the defective file's `DATA_FILE_NO_ROWS` finding, and nothing else.
 * The dump leaves the workspace family out: a statement naming a refused relation refuses whole.
 */

import { describe, expect, it } from 'vitest';

import { seedRunner, treeSeedSuite } from '../helpers/cache-differential.js';
import { NON_WORKSPACE_QUERY, WORKSPACE_DEFECT_TREE, WORKSPACE_DEFECTS, workspaceDefectSeedNamed } from '../helpers/workspace-rows.js';

/**
 * Reds, each seeded once in `workspace-packages.ts` and reverted, each failing on store-off first:
 * - `refuseYamlRules` returning at once: mergeKey and duplicateKey, "the checks the refusal breaks"
 *   `[]`, 2 failures;
 * - `refuseUndeclared` returning at once: rootOutsideRoot and notDeclared, likewise, 2 failures
 *   (seeded while they refused; they are `reportUndeclared`'s conditions now, not re-seeded);
 * - `rootFile` answering a root file with no rows (or unrouted) as empty: rootNoRows and
 *   excludedWorkspaceYaml, likewise, 2 failures;
 * - `readMembers` dropping a member with no rows: memberNoRows, "the workspace checks' rows", 3
 *   members for 5, 1 failure.
 */
describe('every workspace defect reports alike in every arm', () => {
  const run = seedRunner(treeSeedSuite(WORKSPACE_DEFECT_TREE, import.meta.url, { query: NON_WORKSPACE_QUERY }));
  for (const { name } of WORKSPACE_DEFECTS) {
    const seed = workspaceDefectSeedNamed(name);
    it(name, async () => expect(await run(seed)).toEqual(seed.arms));
  }
});
