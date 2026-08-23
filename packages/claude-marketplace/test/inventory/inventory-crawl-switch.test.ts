/**
 * The crawler switch for `vat inventory`, pinned in both directions.
 *
 * This predicate had NO test before the projection became the default, which was
 * survivable only while it was gated off: the untested branch was the one nobody
 * reached. Flipping the default makes the untested branch the one EVERY user
 * takes, so the gate is pinned here rather than left to the integration tests —
 * those hand a population in directly and never consult the environment at all.
 *
 * ⚠️ `vitest.setup.js` deletes every `VAT_*` variable before any test module
 * loads, so the unset case below is the real shipped default and not an artifact
 * of a dirty environment. It is also why `projectionCrawlSelected` reads
 * `process.env` per call instead of binding at module load — a module-level
 * binding would make every assertion in this file unfalsifiable, since the value
 * would have been captured before any of them ran.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  INVENTORY_CRAWL_ENV,
  INVENTORY_CRAWL_PROJECTION,
  INVENTORY_CRAWL_WALKER,
  projectionCrawlSelected,
} from '../../src/inventory/inventory-population.js';

describe('projectionCrawlSelected', () => {
  afterEach(() => {
    delete process.env[INVENTORY_CRAWL_ENV];
  });

  it('selects the projection when nothing is set — the shipped default', () => {
    delete process.env[INVENTORY_CRAWL_ENV];

    expect(projectionCrawlSelected()).toBe(true);
  });

  it('selects the incumbent walk for the walker spelling — the escape hatch', () => {
    process.env[INVENTORY_CRAWL_ENV] = INVENTORY_CRAWL_WALKER;

    expect(projectionCrawlSelected()).toBe(false);
  });

  it('still honours the explicit projection spelling', () => {
    // The lab's A arm passes this, and it was the ONLY way to reach the lane
    // before the flip. It must keep meaning what it says rather than becoming a
    // silent no-op, or an A/B capture would quietly stop naming its own arm.
    process.env[INVENTORY_CRAWL_ENV] = INVENTORY_CRAWL_PROJECTION;

    expect(projectionCrawlSelected()).toBe(true);
  });

  it('lands an unrecognized value on the default rather than throwing', () => {
    // A typo'd instrument selector must not fail a user's command. Note the
    // destination of this rule MOVED with the flip: this used to resolve to the
    // walk, and now resolves to the projection. A near-miss of the escape hatch
    // is the case that matters — someone reaching for the walk and mistyping it
    // gets the default, not an error and not their intended arm.
    process.env[INVENTORY_CRAWL_ENV] = 'walkr';

    expect(projectionCrawlSelected()).toBe(true);
  });

  it('does not treat the empty string as the walker', () => {
    // An unset variable and one set to '' arrive here differently but must agree:
    // a shell exporting an empty value has not selected an instrument.
    process.env[INVENTORY_CRAWL_ENV] = '';

    expect(projectionCrawlSelected()).toBe(true);
  });
});
