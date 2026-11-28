/**
 * The repository arm of the proof that the two ported `resources.checks` entries are exactly as
 * strong as the ESLint usage they replaced (SPEC section 11), both ways: over this repository's git
 * content, each check's findings equal the `(file, line)` set its rule reports, and the files each
 * check examines equal the files ESLint's own config resolution enables the rule for. The corpus
 * arms, which prove every form each rule visits and skips, are in
 * `integration/check-ports.integration.test.ts`.
 *
 * System tier, because its cost is the whole repository's: one cold `vat resources check` of the
 * built CLI over this checkout (the run populates a fresh store: every test file's cache is its
 * own) and one lint of every script in it. Both checks are answered by that one run, and the lint
 * runs while it does: it lints the boundary rule with no importer list as `ignores` (the list is
 * the check's own, read from the store the run leaves), and the files the list leaves the rule
 * enabled for are resolved once the run answers (`ruleSides` with `reportedUnder`).
 *
 * One more whole-repository proof rides on that run: the boundary check's resolved-target arm (its
 * corpus arms are `integration/projection-sqlite-resolved-arm.integration.test.ts`), read through
 * the same run's queries. The compiler differential of the resolved import graph over this
 * repository is its own file (`ts-resolve-repository.system.test.ts`): its oracle's programs would
 * otherwise share this fork's memory with the lint.
 */

import { describe, expect, it } from 'vitest';

import { expectRepositoryArm, REPO_ROOT, ruleReports, ruleSides, runChecksOverRepository, type CheckAnswer, type RuleSide } from '../check-port-differential.js';
import {
  BOUNDARY_ARMS_QUERY,
  BOUNDARY_CHECK,
  BOUNDARY_RULE,
  boundaryBlock,
  IMPORTERS_QUERY,
  importersOf,
  repoConfig,
  RESOLVED_GRAPH_QUERY,
  SCRIPTS,
  SELF_CHECK,
  SELF_RULE,
  selfImportBlocks,
  workspacePackages,
} from '../check-port-usages.js';
import { treeFiles } from '../eslint-clean-files.js';

/** The boundary check's answer from the one repository run, for the resolved-arm case. */
const repository: { boundary?: CheckAnswer } = {};

describe('the resources.checks ports over this repository', () => {
  it('are exactly as strong as their rules over this repository, both ways', async () => {
    const candidates = { [SELF_RULE]: treeFiles(REPO_ROOT, ['packages/*/src/**/*']), [BOUNDARY_RULE]: treeFiles(REPO_ROOT, [SCRIPTS]) };
    const selfBlocks = selfImportBlocks(workspacePackages());
    // Both rules, the union of both candidate sets linted once, while the one check run populates
    // the store: the boundary rule with no `ignores`, so its reports cover every file it could be enabled for.
    const [[selfAnswer, boundaryAnswer], reported] = await Promise.all([
      runChecksOverRepository([{ check: SELF_CHECK }, { check: BOUNDARY_CHECK, queries: { ...IMPORTERS_QUERY, ...BOUNDARY_ARMS_QUERY, ...RESOLVED_GRAPH_QUERY } }]),
      ruleReports({ root: REPO_ROOT, baseConfig: repoConfig, blocks: [...selfBlocks, boundaryBlock([])], candidates }),
    ]);
    if (selfAnswer === undefined || boundaryAnswer === undefined) throw new Error('the repository run answered fewer checks than it was asked');
    repository.boundary = boundaryAnswer;
    const importers = importersOf(boundaryAnswer.queried['importers'] ?? []);
    // The files each rule is enabled for under the deleted usage itself, importer list included.
    const sides = await ruleSides({ root: REPO_ROOT, baseConfig: repoConfig, blocks: [...selfBlocks, boundaryBlock(importers)], candidates }, reported);

    expectRepositoryArm(selfAnswer, sides[SELF_RULE] as RuleSide);
    // Every importer glob is in use, and no file outside them imports the backend.
    expect(boundaryAnswer.findings).toStrictEqual([]);
    expectRepositoryArm(boundaryAnswer, sides[BOUNDARY_RULE] as RuleSide);
  });

  it('the boundary check\'s resolved-target arm finds nothing, over a resolved graph that reaches the backend', () => {
    const answer = repository.boundary;
    if (answer === undefined) throw new Error('the repository run did not answer the boundary check');

    expect(answer.queried['resolved']).toStrictEqual([]);
    expect(answer.runFindings.filter((finding) => finding.startsWith('TS_FILE_NO_ROWS'))).toStrictEqual([]);
    expect(Number(answer.queried['programs']?.[0])).toBeGreaterThan(0);
    // Not blind: the one CLI module that injects the backend resolves into it, and is exempt.
    expect(answer.queried['reaching']).toContain('packages/cli/src/utils/projection-store.ts');
    expect(answer.examined).toBe(answer.population.length);
    expect(answer.examined).toBeGreaterThan(0);
  });
});
