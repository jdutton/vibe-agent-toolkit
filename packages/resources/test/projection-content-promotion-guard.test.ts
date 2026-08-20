/**
 * A rot guard pinning `afterClosurePromotion`'s deliberate no-op through the
 * real `populate()` driver: a `deferred` realization is genuinely promotable
 * today, and yet nothing currently promotes it, because `ProjectionBase` —
 * the read-only view every contributor receives — exposes no mutator. That
 * makes the merge driver's post-closure `populateBlobs` pass
 * (`afterClosurePromotion` in `projection/merge.ts`) a permanent no-op,
 * deliberately: the demand consumer is later-stage work.
 *
 * This drives `populate()` itself — the same entry point a real demand
 * consumer would land inside, as a contributor registered in the run's
 * `ContributorRegistry` — rather than constructing a `ProjectionBuilder` by
 * hand and never calling `populate()` at all. A hand-built builder can never
 * observe a future consumer that lands as a contributor, so it could never
 * fail when the no-op era actually ends; this test reaches the real path so
 * that when it does, this test starts failing.
 *
 * The signal is `BlobPopulationReport.afterClosurePromotion`'s presence:
 * `populate()` only sets that key when `builder.contentPromotions` moved
 * between the pre-closure blob pass and the post-closure one (see
 * `afterClosurePromotion` in `projection/merge.ts`), and it is an absent key
 * — never a zeroed result — specifically so "did not run again" and "ran
 * again and found nothing" stay distinguishable. Its absence here is
 * therefore a fact about today's wiring (no contributor holds a mutator), not
 * about there being nothing to promote.
 *
 * This is NOT where the promotion mechanism itself is exercised — that is
 * `projection-ensure-content-key.test.ts`, which drives `ensureContentKey`
 * directly and already asserts the promotion, the returned key, and the
 * cache-measured idempotence of a second call (and separately pins
 * `contentPromotions === 0` for every non-promoting path). This file only
 * pins the absence of a caller on the real `populate()` route. The single
 * test below is expected to fail once a real demand consumer lands: that
 * failure is the point — it tells the next author the no-op era is over, so
 * the test should be deleted, not "fixed" back to expecting the key absent.
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ExtentContribution, ExtentContributor } from '../src/projection/contributor.js';
import { ContributorRegistry } from '../src/projection/contributor.js';
import { populate, type BlobPopulationReport } from '../src/projection/merge.js';
import { collectRealization } from '../src/projection/realizations.js';

import { setupSubdirTestSuite, writeFileIn } from './test-helpers.js';

const DOC = 'guarded.md';
const DOC_CONTENT = '# Guarded\n';
const RESOURCE = 'res-guarded';
const EXTENT = 'ctx-guard';
const CONTRIBUTOR_ID = 'test:content-promotion-guard';

const suite = setupSubdirTestSuite('content-promotion-guard-');

/**
 * A base contributor realizing exactly one path, `deferred` — a row that
 * genuinely CAN be promoted, so asserting "nothing promoted it" below is a
 * claim about today's wiring rather than about a run with nothing to promote
 * in the first place.
 *
 * Built through `collectRealization` rather than by hand, for the same reason
 * `projection-ensure-content-key.test.ts` does: the whole property under test
 * is that a row the *real* enumeration path left `deferred` can be promoted,
 * and a hand-stamped `contentState: 'deferred'` would prove only that the
 * fixture agrees with itself.
 */
const guardContributor: ExtentContributor = {
  id: CONTRIBUTOR_ID,
  kind: 'test',
  stratum: 'base',
  readsBlobs: false,
  contribute: async (base): Promise<ExtentContribution> => {
    const row = await collectRealization(safePath.join(base.root, DOC), RESOURCE, {
      root: base.root,
      extentId: EXTENT,
      contentCache: base.contentCache,
      contentDemand: 'deferred',
    });
    return {
      contexts: [],
      resources: [],
      realizations: [row],
      memberships: [],
      tags: [],
      conditions: [],
    };
  },
};

describe('afterClosurePromotion via populate()', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('records the no-op promotion stage as a no-op, so its silence stays deliberate', async () => {
    writeFileIn(suite.tempDir, DOC, DOC_CONTENT);

    const registry = new ContributorRegistry();
    registry.register(guardContributor);

    const reports: BlobPopulationReport[] = [];
    await populate({
      root: suite.tempDir,
      registry,
      onBlobPopulation: (report) => reports.push(report),
    });

    expect(reports).toHaveLength(1);
    const [report] = reports;
    // This assertion is INTENDED to fail once a real demand consumer lands:
    // that failure is the whole point of writing this test now — it tells the
    // next author the no-op era described in `merge.ts` has ended, so this
    // test should be deleted (not "fixed" back to expecting the key absent).
    expect('afterClosurePromotion' in (report ?? {})).toBe(false);
  });
});
