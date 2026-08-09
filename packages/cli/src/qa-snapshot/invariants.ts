/**
 * The pipeline's internal invariants, asserted over a captured manifest.
 *
 * ## What this is
 *
 * The third function of the QA snapshot instrument, beside `capture` and
 * `diff`. It answers a different question from either: not *"did anything
 * move?"* but *"is anything this instrument just produced trustworthy at all?"*
 *
 * It reads a {@link SnapshotManifest} and nothing else. No filesystem, no
 * spawning, no build required — every invariant here is a property of the
 * **builders**, recorded at capture time, and the moment you most want to ask
 * about them is mid-refactor, when `dist/` is stale or absent.
 *
 * ⛔ There is no verb behind this. `vat pipeline check` implemented it inside
 * the command file and was deleted with the rest of the verb; this is the
 * capability restored as library code, reached by writing a test.
 *
 * ## What is a violation, and what is only information
 *
 * A violation means an artifact this instrument produces cannot be trusted:
 *
 * - **`BUILD_ERROR`** — the lane's production builder threw, so its admitted
 *   and collision counts are 0 because nothing ran, not because the corpus is
 *   empty. A vacuous green is the failure mode this whole instrument exists to
 *   avoid, and a dead builder is the cheapest way to produce one.
 * - **`RESTATEMENT_DRIFT`** — `pipeline-oracles/lanes.ts` restates each lane's
 *   crawl so the ordered, pre-deduplication path list can be observed. Drift
 *   means the restatement no longer matches the builder it claims to describe,
 *   so every artifact that lane produced is a fiction about a crawl that did
 *   not happen. **This is the invariant that keeps the oracle honest about
 *   itself, and the most valuable of the three.**
 * - **`KEY_DISAGREEMENT`** — two paths carrying the same content key parsed
 *   *differently*. A content-addressed cache over this pipeline would be
 *   unsound: it would serve one path's parse for the other.
 *
 * Duplicate-id collisions are reported as **information, never a violation**.
 * They are real and pre-existing — failing on them would make this check red on
 * VAT's own repository from day one, and a check that is red on arrival is a
 * check nobody runs.
 *
 * ## Why the report distinguishes "clean" from "never asked"
 *
 * `parseFactKeyDisagreementCount` is `null` when the capture skipped the
 * parse-fact half, and there is no other observer of key soundness anywhere in
 * VAT. The deleted verb closed that hole by hard-coding `includeParseFacts:
 * true` on the request it built; a library function cannot, because it never
 * sees the request. So a skipped half is surfaced in
 * {@link InvariantReport.unchecked} rather than silently counted as a pass —
 * an empty `violations` list from a capture that never asked is a vacuous
 * green wearing the same clothes as a real one.
 */

import type { LaneId } from '../pipeline-oracles/types.js';

import type { InvariantViolation, LaneManifestEntry, SnapshotManifest } from './types.js';

/** One lane's duplicate-id collision count — reported, never failed on. */
export interface CollisionNote {
  lane: LaneId;
  duplicateIdCount: number;
}

/** Everything asserting the invariants over one manifest produced. */
export interface InvariantReport {
  /** Every violated invariant: lane-scoped rows first, then corpus-wide. */
  violations: InvariantViolation[];
  /**
   * Invariant codes that could **not** be asserted, because the capture omitted
   * their input. Non-empty means `violations` is narrower than it looks: read
   * it as "these did not fire", never as "these hold".
   */
  unchecked: InvariantViolation['code'][];
  /** Duplicate-id collisions, as information. Never affects `violations`. */
  collisions: CollisionNote[];
}

/**
 * Assert every pipeline invariant the manifest carries enough evidence to test.
 *
 * @param manifest - A captured manifest; commands and artifacts are not read
 * @returns The violations, what could not be checked, and the collision notes
 */
export function checkInvariants(manifest: SnapshotManifest): InvariantReport {
  const violations: InvariantViolation[] = [];
  for (const lane of manifest.lanes) {
    violations.push(...laneViolations(lane));
  }

  const unchecked: InvariantViolation['code'][] = [];
  const disagreements = manifest.parseFactKeyDisagreementCount;
  if (disagreements === null) {
    unchecked.push('KEY_DISAGREEMENT');
  } else if (disagreements > 0) {
    violations.push({
      laneId: null,
      code: 'KEY_DISAGREEMENT',
      detail:
        `${String(disagreements)} content key(s) are shared by paths whose parses DISAGREE. ` +
        'A content-addressed cache over this pipeline would be unsound: asked about one path, ' +
        'it would serve the parse of the other.',
    });
  }

  return { violations, unchecked, collisions: collisionNotes(manifest.lanes) };
}

/**
 * The two per-lane invariants.
 *
 * @param lane - One lane's manifest entry
 * @returns Zero, one or two violations
 */
function laneViolations(lane: LaneManifestEntry): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (lane.buildError !== null) {
    violations.push({
      laneId: lane.laneId,
      code: 'BUILD_ERROR',
      detail:
        `the production builder threw: ${lane.buildError}. ` +
        'Its admitted and collision counts are 0 because nothing ran, not because the corpus is empty.',
    });
  }

  if (lane.restatementDriftCount > 0) {
    violations.push({
      laneId: lane.laneId,
      code: 'RESTATEMENT_DRIFT',
      detail:
        `${String(lane.restatementDriftCount)} path(s) where the crawl restated in ` +
        'pipeline-oracles/lanes.ts disagrees with the builder it claims to describe. ' +
        'Every artifact this lane produced describes a crawl that did not happen.',
    });
  }

  return violations;
}

/**
 * Duplicate-id collisions, as information.
 *
 * @param lanes - Every captured lane's manifest entry
 * @returns One note per lane that saw a collision; empty when none did
 */
function collisionNotes(lanes: readonly LaneManifestEntry[]): CollisionNote[] {
  return lanes
    .filter((lane) => lane.collisionCount > 0)
    .map((lane) => ({ lane: lane.laneId, duplicateIdCount: lane.collisionCount }));
}
