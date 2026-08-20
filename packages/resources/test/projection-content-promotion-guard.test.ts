/**
 * The demand-promotion mechanism, pinned end to end over a realization the
 * SHIPPED deferral policy produced: `FilesystemExtentContributor`'s default
 * `contentDemand: 'deferGitignored'` leaves a gitignored path `deferred` with no
 * content key, `ProjectionBuilder.ensureContentKey` promotes it to `keyed`, and
 * the merge driver's post-fixpoint stage (`afterClosurePromotion` in
 * `projection/merge.ts`) then derives the blob and the references that promotion
 * made available.
 *
 * ## What this file used to assert, and why that assertion could not fail
 *
 * It previously drove `populate()` with a single `base` contributor of its own
 * and asserted `'afterClosurePromotion' in report === false`, describing itself
 * as a rot guard that would redden "once a real demand consumer lands". It could
 * not, for three independent reasons:
 *
 * 1. `PopulateOptions.registry` is **caller-supplied** and `populate()` registers
 *    nothing of its own, so the only contributors in that run were the test's. A
 *    future demand consumer would never appear in it.
 * 2. That registry held one `base` contributor and no `closure` one, so
 *    `iterateClosure` iterated an empty list: between `promotionsBeforeClosure`
 *    and the comparison inside `afterClosurePromotion`, **no code ran**. The
 *    assertion reduced to `0 === 0`.
 * 3. Measured, not reasoned: replacing `ensureContentKey`'s rewrite and its
 *    `#contentPromotions` increment with a no-op — gutting the entire mechanism
 *    the file exists for — left that test green.
 *
 * It also called its fixture "a row that genuinely CAN be promoted" and never
 * checked it, so a regression in `collectRealization` or `defers()` would have
 * left the test green while pinning a run with nothing to promote. Both tests
 * below therefore assert the fixture's starting state — the row exists, its
 * `contentState` really is `deferred`, and its `contentKey` really is null —
 * before anything is exercised.
 *
 * ## Why the promoting consumer is not a registered contributor here
 *
 * Because it cannot be one yet. `ProjectionBase` — the view `populate()` hands
 * every contributor, see `projection.ts` — is the twelve tables plus `root`,
 * `identities`, `gitTracker` and `contentCache`, and **exposes no mutator**;
 * `ensureContentKey` lives on `ProjectionBuilder`, which no contributor ever
 * receives. So no contributor, registered in any stratum, can promote anything
 * today, and a `populate()`-level test of promotion is not merely unwritten but
 * structurally unreachable. The test below calls `ensureContentKey` on the
 * builder directly, in the exact position the closure stratum occupies — after
 * the between-strata blob stage, before `afterClosurePromotion` — which is the
 * seam the demand consumer will have to be given. When it lands, the assertions
 * here describe what it must produce.
 *
 * The complementary claims live elsewhere and are not repeated:
 * `projection-ensure-content-key.test.ts` drives `ensureContentKey` against
 * hand-set demand policies (idempotence measured against the run cache, the
 * unreadable path, multi-extent promotion, in-place rewrite ordering), and
 * `projection-blob-population.test.ts` pins the two-run reporting rule.
 */
import { GitTracker } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { populateBlobs } from '../src/projection/blob-population.js';
import { RunContentCache } from '../src/projection/content-cache.js';
import { ContributorRegistry } from '../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { afterClosurePromotion, populate, type BlobPopulationReport } from '../src/projection/merge.js';
import { ProjectionBuilder } from '../src/projection/projection.js';

import { createGitRepo, setupSubdirTestSuite, writeFileIn } from './test-helpers.js';

/** The ignored subtree, so `deferGitignored` has something to defer. */
const IGNORED_DIR = 'ignored-tree';
/** The path this file promotes: gitignored, and it carries an outbound link. */
const DEFERRED_DOC = `${IGNORED_DIR}/notes.md`;
/** A second gitignored path, so "promoted one" stays distinct from "promoted all". */
const DEFERRED_LEAF = `${IGNORED_DIR}/b.md`;
/** Tracked, so the run has an eagerly keyed blob and the policy discriminates. */
const TRACKED_DOC = 'README.md';

/**
 * The link is load-bearing: a promoted blob with no references would make "the
 * blob was derived" and "it was not" produce identical `blob_references` tables.
 */
const DEFERRED_DOC_CONTENT = '# Notes\n\n[b](./b.md)\n';

/** A markdown content key, which is what a promoted row must carry. */
const MARKDOWN_KEY = /^markdown\.[\da-f]{64}$/u;

const suite = setupSubdirTestSuite('content-promotion-guard-');

/**
 * Plant a repository in which exactly one subtree is gitignored.
 *
 * A real repository with a real `.gitignore`, not a hand-set
 * `contentDemand: 'deferred'`: the property under test is that the row the
 * *shipped* policy produces is promotable, and `deferGitignored` is
 * indistinguishable from `eager` anywhere nothing is actually ignored. No commit
 * is needed — `isIgnored` falls back to `git check-ignore`, which reads
 * `.gitignore` directly.
 *
 * @returns The run's git oracle, already initialized
 */
async function plantIgnoredTree(): Promise<GitTracker> {
  writeFileIn(suite.tempDir, TRACKED_DOC, '# Readme\n');
  writeFileIn(suite.tempDir, DEFERRED_DOC, DEFERRED_DOC_CONTENT);
  writeFileIn(suite.tempDir, DEFERRED_LEAF, '# B\n');
  writeFileIn(suite.tempDir, '.gitignore', `${IGNORED_DIR}/\n`);
  createGitRepo(suite.tempDir);

  const tracker = new GitTracker(suite.tempDir);
  await tracker.initialize();
  return tracker;
}

/**
 * The base stratum, run by hand so the builder itself is reachable.
 *
 * Only the realization rows are merged: the blob stage reads
 * `resourceRealizations` and nothing else, and `ensureContentKey` rewrites rows
 * in that same table, so contexts and identities would be scenery.
 *
 * @param tracker - The run's git oracle, which is what fills `gitignored`
 * @returns A builder holding the filesystem extent's realizations
 */
async function baseStratum(tracker: GitTracker): Promise<ProjectionBuilder> {
  const builder = new ProjectionBuilder(suite.tempDir, tracker, new RunContentCache());
  const contribution = await new FilesystemExtentContributor().contribute(builder.base(), null);
  for (const row of contribution.realizations) {
    builder.addRealization(row);
  }
  return builder;
}

/** Every realization of one path, as the pair that says whether it was keyed. */
function statesAt(builder: ProjectionBuilder, path: string): { state: string; key: string | null }[] {
  return builder.build().resourceRealizations
    .filter((row) => row.path === path)
    .map((row) => ({ state: row.contentState, key: row.contentKey }));
}

describe('demand promotion, over a row the shipped deferral policy produced', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('promotes a deferred realization and derives the blob the promotion revealed', async () => {
    const tracker = await plantIgnoredTree();
    const builder = await baseStratum(tracker);

    // The premise, asserted rather than assumed. Without this, a regression in
    // `collectRealization` or `defers()` that keyed the path eagerly would leave
    // every assertion below passing over a run with nothing to promote.
    expect(statesAt(builder, DEFERRED_DOC)).toEqual([{ state: 'deferred', key: null }]);

    // The between-strata run, exactly where `populate()` places it.
    const first = await populateBlobs(builder);
    expect(first.realizationsContentDeferred).toBe(2);
    expect(builder.build().blobReferences).toHaveLength(0);

    const promotionsBeforeClosure = builder.contentPromotions;
    const attemptsBeforeClosure = builder.contentPromotionAttempts;
    expect(promotionsBeforeClosure).toBe(0);
    expect(attemptsBeforeClosure).toBe(0);

    // Where the closure stratum's demand consumer will sit. See the file
    // docstring for why it cannot be a registered contributor yet.
    const key = await builder.ensureContentKey(DEFERRED_DOC);

    // The three observable halves of one promotion: the key exists, the counter
    // the driver reads moved, and the row itself was rewritten in place. Any one
    // of them alone can be satisfied by a mechanism that is half-broken —
    // returning a key without rewriting the row leaves a realization that still
    // claims nobody asked, and rewriting without counting leaves the driver
    // believing there is no second run to make.
    expect(key).toMatch(MARKDOWN_KEY);
    expect(builder.contentPromotions).toBe(promotionsBeforeClosure + 1);
    expect(builder.contentPromotionAttempts).toBe(attemptsBeforeClosure + 1);
    expect(statesAt(builder, DEFERRED_DOC)).toEqual([{ state: 'keyed', key }]);

    const report = await afterClosurePromotion(builder, attemptsBeforeClosure);

    // Present, not absent — the opposite outcome to the no-promotion case that
    // `projection-blob-population.test.ts` pins.
    expect('afterClosurePromotion' in report).toBe(true);
    // One blob, not two: `DEFERRED_LEAF` is still deferred, so a stage that
    // simply re-derived everything keyed would report a different number.
    expect(report.afterClosurePromotion?.blobsDerived).toBe(1);
    expect(report.afterClosurePromotion?.realizationsContentDeferred).toBe(1);
    expect(builder.build().blobs.map((row) => row.contentKey)).toContain(key);
    // The edge the deferred row was hiding. Without the second stage the
    // realization would name a blob with no rows at all — a dangling key.
    expect(builder.build().blobReferences.map((row) => row.rawRef)).toEqual(['./b.md']);
  });

  it('leaves the gitignored path deferred through a whole populate(), and says so', async () => {
    // The state the promotion above starts from, reached through the real driver
    // rather than a hand-run base stratum: nothing shipped promotes, so a full
    // `populate()` must end with the row still `deferred`, its blob underived,
    // and the report carrying no second measurement.
    const tracker = await plantIgnoredTree();
    const registry = new ContributorRegistry();
    registry.register(new FilesystemExtentContributor());

    let report: BlobPopulationReport | undefined;
    const projection = await populate({
      root: suite.tempDir,
      registry,
      gitTracker: tracker,
      onBlobPopulation: (result) => {
        report = result;
      },
    });

    const deferred = projection.resourceRealizations.filter((row) => row.path === DEFERRED_DOC);
    expect(deferred.map((row) => [row.contentState, row.contentKey])).toEqual([['deferred', null]]);
    // Non-zero, so the absent key below is a fact about promotion rather than
    // about a corpus that had nothing to promote in the first place.
    expect(report?.realizationsContentDeferred).toBe(2);
    expect('afterClosurePromotion' in (report ?? {})).toBe(false);
    // The tracked file WAS keyed and derived, so the policy is discriminating
    // rather than deferring everything.
    expect(projection.resourceRealizations.find((row) => row.path === TRACKED_DOC)?.contentState)
      .toBe('keyed');
    expect(projection.blobReferences).toHaveLength(0);
  });
});
