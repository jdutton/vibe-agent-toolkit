/**
 * Integrity of the duration-ratchet allowlist: every entry names a spec file
 * that exists, once, in the tier its suffix says, with a reason, and with a
 * recorded measurement that is not already under the stale line the reporter
 * would fail it at.
 */
import { existsSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import {
  LISTED_HEADROOM_FACTOR,
  MECHANISM,
  STALE_FRACTION,
  TEST_TIER_BUDGET_ALLOWLIST,
  TIER_BUDGET_MS,
  tierOf,
} from '../src/test-tier-budget-allowlist.js';

describe('TEST_TIER_BUDGET_ALLOWLIST', () => {
  it('lists each file once', () => {
    const files = TEST_TIER_BUDGET_ALLOWLIST.map((e) => e.file);
    const duplicates = files.filter((f, i) => files.indexOf(f) !== i);
    expect(duplicates).toEqual([]);
  });

  it('names only spec files that exist in the tree — a renamed or deleted file must take its entry with it', () => {
    const missing = TEST_TIER_BUDGET_ALLOWLIST
      .map((e) => e.file)
      .filter((file) => !existsSync(safePath.join(PROJECT_ROOT, file)));
    expect(missing).toEqual([]);
  });

  it('uses repo-relative forward-slash paths under packages/', () => {
    for (const { file } of TEST_TIER_BUDGET_ALLOWLIST) {
      expect(file, file).toMatch(/^packages\/[^/]+\/(test|src)\//);
      expect(file, file).not.toContain('\\');
    }
  });

  it('carries a tier the reporter can budget, and at least one mechanism', () => {
    for (const entry of TEST_TIER_BUDGET_ALLOWLIST) {
      expect(tierOf(entry.file), entry.file).toBeDefined();
      expect(entry.mechanisms.length, `${entry.file} lists no mechanism`).toBeGreaterThan(0);
    }
  });

  it('gives every OVER-BUDGET entry a real mechanism or a note — "unclassified" is only tolerated for a hover entry', () => {
    const unexplained = TEST_TIER_BUDGET_ALLOWLIST.filter((entry) => {
      const tier = tierOf(entry.file);
      if (tier === undefined || entry.measuredMs <= TIER_BUDGET_MS[tier]) return false;
      const classified = entry.mechanisms.some((m) => m !== MECHANISM.unclassified);
      return !classified && entry.note === undefined;
    });
    expect(unexplained.map((e) => e.file)).toEqual([]);
  });

  it('records a positive measurement — the stale line is a fraction of it, and a zero would make every run stale', () => {
    const zero = TEST_TIER_BUDGET_ALLOWLIST.filter((entry) => entry.measuredMs * STALE_FRACTION <= 0);
    expect(zero.map((e) => e.file)).toEqual([]);
  });

  it('records a measurement whose headroom exceeds the tier budget — below that the entry bounds nothing an unlisted file is not already bound to', () => {
    const pointless = TEST_TIER_BUDGET_ALLOWLIST.filter((entry) => {
      const tier = tierOf(entry.file);
      return tier !== undefined && entry.measuredMs * LISTED_HEADROOM_FACTOR <= TIER_BUDGET_MS[tier];
    });
    expect(pointless.map((e) => e.file)).toEqual([]);
  });

});
