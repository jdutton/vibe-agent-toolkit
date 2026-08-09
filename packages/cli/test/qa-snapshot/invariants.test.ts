/**
 * Unit tests for the pipeline's internal invariants.
 *
 * These are the assertions that keep every other artifact in this instrument
 * honest, so each one is tested in both directions: a manifest that genuinely
 * fires it, and an otherwise-identical manifest that genuinely does not. A
 * fixture that cannot produce both verdicts proves nothing about the code —
 * this repository has been burned by exactly that four times — so every pair
 * below differs in **one field only**, and the clean case is asserted empty.
 *
 * The load-bearing one is `RESTATEMENT_DRIFT`. It is the invariant that keeps
 * the oracle honest about *itself*: `pipeline-oracles/lanes.ts` restates each
 * lane's crawl, and a restatement that has drifted from the builder it claims
 * to describe makes every artifact that lane produced a fiction.
 */

import { describe, expect, it } from 'vitest';

import {
  checkInvariants,
  type InvariantReport,
} from '../../src/qa-snapshot/invariants.js';
import {
  SNAPSHOT_FORMAT_VERSION,
  type LaneManifestEntry,
  type SnapshotManifest,
} from '../../src/qa-snapshot/types.js';

const THROWN = 'TypeError: crawlAndResolveRegistry is not a function';

/** The lane the fixture defaults to. */
const DEFAULT_LANE = 'resources';

/** A second lane, for cases that need the violation attributed elsewhere. */
const OTHER_LANE = 'skills-build';

/** Only the four fields any invariant reads; everything else is a fixed default. */
type LaneShape = Partial<
  Pick<
    LaneManifestEntry,
    'laneId' | 'buildError' | 'restatementDriftCount' | 'collisionCount'
  >
>;

/**
 * A lane entry that is clean unless the test says otherwise.
 *
 * @param shape - The fields this test varies
 * @returns One lane manifest entry
 */
function lane(shape: LaneShape = {}): LaneManifestEntry {
  const entry: LaneManifestEntry = {
    laneId: shape.laneId ?? DEFAULT_LANE,
    artifact: 'oracle/enumeration.resources.txt',
    route: 'git-ls-files',
    orderPortable: true,
    enumeratedCount: 265,
    admittedCount: 265,
    collisionCount: shape.collisionCount ?? 0,
    restatementDriftCount: shape.restatementDriftCount ?? 0,
    buildError: shape.buildError ?? null,
  };
  return entry;
}

/**
 * A manifest carrying the given lanes and key-disagreement count.
 *
 * Every field an invariant does not read is filled with a fixed, uninteresting
 * value, so a difference between two fixtures is always the field under test.
 *
 * @param lanes - The lane entries to carry
 * @param keyDisagreements - `parseFactKeyDisagreementCount`; `null` means the
 *   parse-fact half was never captured
 * @returns The manifest
 */
function manifestOf(
  lanes: readonly LaneManifestEntry[],
  keyDisagreements: number | null = 0,
): SnapshotManifest {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    vatVersion: '0.1.42',
    cacheNamespace: '0.1.42',
    capturedAtIso: '2026-08-09T00:00:00.000Z',
    corpusRoot: '/workspaces/vibe-agent-toolkit',
    corpusLabel: 'vat',
    platform: 'darwin',
    nodeVersion: 'v22.11.0',
    corpusGitHead: 'abc1234',
    corpusGitDirty: false,
    lanes: [...lanes],
    commands: [],
    parseFactArtifact: keyDisagreements === null ? null : 'oracle/parse-facts.txt',
    parseFactBlobCount: keyDisagreements === null ? null : 37,
    parseFactKeyDisagreementCount: keyDisagreements,
    warnings: [],
  };
}

/**
 * Every violation code the report carries, in order.
 *
 * @param report - The invariant report
 * @returns The codes
 */
function codesOf(report: InvariantReport): string[] {
  return report.violations.map((violation) => violation.code);
}

describe('checkInvariants', () => {
  describe('positive control', () => {
    it('returns no violations at all for a clean manifest', () => {
      const report = checkInvariants(manifestOf([lane(), lane({ laneId: 'audit' })]));

      expect(report.violations).toEqual([]);
      expect(report.unchecked).toEqual([]);
      expect(report.collisions).toEqual([]);
    });
  });

  describe('BUILD_ERROR', () => {
    it('fires when a lane builder threw', () => {
      const report = checkInvariants(manifestOf([lane({ buildError: THROWN })]));

      expect(codesOf(report)).toEqual(['BUILD_ERROR']);
      expect(report.violations[0]?.laneId).toBe(DEFAULT_LANE);
      // The thrown message is the diagnosis; without it the row says only that
      // a zero count is untrustworthy, not why.
      expect(report.violations[0]?.detail).toContain(THROWN);
    });

    it('does not fire on the same lane with buildError null', () => {
      const report = checkInvariants(manifestOf([lane({ buildError: null })]));

      expect(codesOf(report)).toEqual([]);
    });
  });

  describe('RESTATEMENT_DRIFT', () => {
    it('fires when the restatement disagrees with the builder it describes', () => {
      const report = checkInvariants(
        manifestOf([lane({ laneId: OTHER_LANE, restatementDriftCount: 4 })]),
      );

      expect(codesOf(report)).toEqual(['RESTATEMENT_DRIFT']);
      expect(report.violations[0]?.laneId).toBe(OTHER_LANE);
      expect(report.violations[0]?.detail).toContain('4');
      expect(report.violations[0]?.detail).toContain('lanes.ts');
    });

    it('does not fire on the same lane with a drift count of zero', () => {
      const report = checkInvariants(
        manifestOf([lane({ laneId: OTHER_LANE, restatementDriftCount: 0 })]),
      );

      expect(codesOf(report)).toEqual([]);
    });
  });

  describe('KEY_DISAGREEMENT', () => {
    it('fires when paths sharing a content key parsed differently', () => {
      const report = checkInvariants(manifestOf([lane()], 2));

      expect(codesOf(report)).toEqual(['KEY_DISAGREEMENT']);
      // Corpus-wide, not attributable to one lane.
      expect(report.violations[0]?.laneId).toBeNull();
      expect(report.violations[0]?.detail).toContain('2');
    });

    it('does not fire when no key disagreed', () => {
      const report = checkInvariants(manifestOf([lane()], 0));

      expect(codesOf(report)).toEqual([]);
    });

    it('reports the invariant as UNCHECKED, not as holding, when parse facts were skipped', () => {
      // The deleted verb guarded this by hard-coding includeParseFacts: true.
      // With the guard gone, a capture that skipped the parse-fact half would
      // otherwise report key soundness as holding when it was never asked —
      // a vacuous green on the one invariant that has no other observer.
      const report = checkInvariants(manifestOf([lane()], null));

      expect(codesOf(report)).toEqual([]);
      expect(report.unchecked).toEqual(['KEY_DISAGREEMENT']);
    });
  });

  describe('duplicate-id collisions', () => {
    it('reports a collision as information, never as a violation', () => {
      const report = checkInvariants(manifestOf([lane({ collisionCount: 3 })]));

      expect(report.violations).toEqual([]);
      expect(report.collisions).toEqual([{ lane: DEFAULT_LANE, duplicateIdCount: 3 }]);
    });

    it('omits lanes that saw no collision', () => {
      const report = checkInvariants(
        manifestOf([lane({ collisionCount: 0 }), lane({ laneId: 'audit', collisionCount: 1 })]),
      );

      expect(report.collisions).toEqual([{ lane: 'audit', duplicateIdCount: 1 }]);
    });
  });

  describe('ordering and accumulation', () => {
    it('reports both per-lane invariants when one lane violates both', () => {
      const report = checkInvariants(
        manifestOf([lane({ buildError: THROWN, restatementDriftCount: 1 })]),
      );

      expect(codesOf(report)).toEqual(['BUILD_ERROR', 'RESTATEMENT_DRIFT']);
      expect(report.violations.every((violation) => violation.laneId === DEFAULT_LANE)).toBe(true);
    });

    it('puts every lane-scoped violation before the corpus-wide one', () => {
      const report = checkInvariants(
        manifestOf(
          [lane({ restatementDriftCount: 1 }), lane({ laneId: 'audit', buildError: THROWN })],
          5,
        ),
      );

      expect(codesOf(report)).toEqual(['RESTATEMENT_DRIFT', 'BUILD_ERROR', 'KEY_DISAGREEMENT']);
      expect(report.violations.map((violation) => violation.laneId)).toEqual([
        DEFAULT_LANE,
        'audit',
        null,
      ]);
    });
  });
});
