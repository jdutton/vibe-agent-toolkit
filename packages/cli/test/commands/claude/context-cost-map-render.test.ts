/**
 * The `--all` cost-map rendering: bounded, honest about what it left out, and
 * never printing an unknown size as a zero.
 *
 * ## Why these are unit tests over a synthesized map
 *
 * The three properties under test are all properties of the RENDERER, and each
 * one is unobservable on a real tree:
 *
 * - **The truncation notice's N.** A system test can assert the notice matches
 *   `and \d+ more`, but not that the number is right — it does not know the
 *   tree's directory count independently of the command that reported it. Here
 *   the map is authored, so the expected N is arithmetic.
 * - **An unknown token count never rendering as `0`.** Every file in this
 *   repository has a measured blob, so no real row carries `tokens: null`; an
 *   assertion over a real run compares `false === false` and would keep passing
 *   if the renderer were changed to `${row.tokens ?? 0}`. The null this tree
 *   never supplies is supplied here.
 * - **The limits appearing exactly ONCE.** Counted rather than checked for
 *   presence — presence passes when the block is repeated ten thousand times,
 *   which is the exact defect `--all` shipped in its previous shape.
 *
 * ⛔ The cap is imported, never retyped as a literal. A test carrying its own `20`
 * passes on a renderer that slices at 20 and a constant that says 50, which is
 * the disagreement the constant exists to prevent.
 */

import {
  CLAUDE_CONTEXT_BOUNDS_STATEMENT,
  type AccountedRow,
  type ContextCostMap,
  type DirectoryCost,
  type RegionCost,
} from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import {
  COST_MAP_ROW_LIMIT,
  costMapEnvelope,
  renderCostMapText,
} from '../../../src/commands/claude/context.js';

/** How many directories beyond the cap the truncation fixture carries. */
const OVERFLOW = 5;

/**
 * One counter block's middle label — the marker used to locate a counter block.
 *
 * Named once because the block is printed in two places with two different
 * rules: per REGION only when something fired, and at TREE level always. Telling
 * those two apart is a matter of counting and locating this exact string, and a
 * retyped copy is one that can drift from the renderer while the count still
 * passes.
 */
const OVERSIZE_LABEL = 'skipped over 4 MiB';

/** The heading the tree-level roll-up sits under. */
const COVERAGE_HEADING = 'What this map looked at';

/**
 * One always-loaded row, defaulting to a measured one.
 *
 * @param overrides - Fields to replace on the default row
 * @returns The accounted row
 */
function rowOf(overrides: Partial<AccountedRow> = {}): AccountedRow {
  return {
    resourceId: 'r1',
    path: 'CLAUDE.md',
    tokens: 1200,
    bytes: 4800,
    loadClass: 'always',
    admissions: [{ kind: 'ancestry', dir: '' }],
    charge: 'charged',
    ...overrides,
  };
}

/**
 * One region, defaulting to a cheap, fully-measured one.
 *
 * @param overrides - Fields to replace on the default region
 * @returns The region cost record
 */
function regionOf(overrides: Partial<RegionCost> = {}): RegionCost {
  return {
    representative: '',
    locationCount: 3,
    alwaysTokens: 1200,
    unknownTokenRows: 0,
    skippedOversizeRows: 0,
    prunedRows: 0,
    alwaysRows: [rowOf()],
    ...overrides,
  };
}

/**
 * One directory, defaulting to a cheap, fully-measured one.
 *
 * ⛔ `totalTokens` is set EXPLICITLY rather than derived from the two halves
 * here, so a case can hand the renderer a total the halves do not add up to. The
 * rule under test is that the CLI READS the ranking key rather than computing
 * one, and a helper that computed it would make that rule untestable — the
 * renderer and the fixture would agree by construction however the renderer
 * behaved.
 *
 * @param overrides - Fields to replace on the default directory
 * @returns The directory cost record
 */
function directoryOf(overrides: Partial<DirectoryCost> = {}): DirectoryCost {
  return {
    directory: 'packages/p',
    representative: '',
    alwaysTokens: 1200,
    onDemandTokens: 0,
    totalTokens: 1200,
    unknownTokenRows: 0,
    ...overrides,
  };
}

/**
 * `count` directories, each cheaper than the one before it.
 *
 * Descending TOTAL cost matches the order `buildContextCostMap` guarantees, so
 * the rendering is exercised on the input shape it actually receives rather than
 * on one it would never see.
 *
 * @param count - How many directories to synthesize
 * @returns The directory cost records, worst-first
 */
function directoriesOf(count: number): DirectoryCost[] {
  return Array.from({ length: count }, (_unused, index) => directoryOf({
    directory: `packages/p${index}`,
    onDemandTokens: (count - index) * 100,
    totalTokens: 1200 + (count - index) * 100,
  }));
}

/**
 * A cost map, defaulting to one small enough that nothing is truncated.
 *
 * @param overrides - Fields to replace on the default map
 * @returns The cost map
 */
function mapOf(overrides: Partial<ContextCostMap> = {}): ContextCostMap {
  return {
    regions: [regionOf()],
    directories: directoriesOf(2),
    unmeasuredRows: { unknownTokenRows: 0, skippedOversizeRows: 0, prunedRows: 0 },
    queriedDirectories: 2,
    evaluatedDirectories: 2,
    skippedUnknownLocations: 0,
    ...overrides,
  };
}

/** Where a substring first appears in the rendering, asserted to be present. */
function indexIn(text: string, needle: string): number {
  const at = text.indexOf(needle);
  expect(at, `${JSON.stringify(needle)} is not in the rendering`).toBeGreaterThanOrEqual(0);
  return at;
}

describe('vat claude context --all — the text cost map', () => {
  it('states the limits exactly ONCE, however many regions and directories', () => {
    const text = renderCostMapText(mapOf({
      regions: [regionOf({ representative: 'a' }), regionOf({ representative: 'b' })],
      directories: directoriesOf(4),
    }));

    // The COUNT is the assertion. Presence passes on a rendering that repeats
    // the block per region — the shape `--all` shipped once already.
    const occurrences = text.split('What this answer does not settle').length - 1;
    expect(occurrences).toBe(1);
    // The block's other heading, counted too — the section is emitted whole or
    // not at all, so two headings agreeing is what rules out a partial repeat.
    // ⛔ NOT the bounds statement itself: `wrapStatement` soft-wraps it across
    // lines, so a contiguous-substring count of it is 0 however many times it is
    // printed — a test that would pass identically on a rendering that repeated
    // the paragraph per region.
    expect(text.split('Modelled Claude Code behaviours').length - 1).toBe(1);
  });

  it('says how many directories it left out, with the right number', () => {
    const total = COST_MAP_ROW_LIMIT + OVERFLOW;

    const text = renderCostMapText(mapOf({ directories: directoriesOf(total) }));

    // A silent cap reads as "this is everything". The number is what makes the
    // notice worth printing: "some were omitted" is not an answer.
    expect(text).toContain(`and ${OVERFLOW} more directories`);
    // And it really did print the cap's worth — a slice at the wrong bound would
    // still produce a plausible notice.
    expect(text).toContain('packages/p0');
    expect(text).toContain(`packages/p${COST_MAP_ROW_LIMIT - 1}`);
    expect(text).not.toContain(`packages/p${COST_MAP_ROW_LIMIT}`);
  });

  it('prints no truncation notice when nothing was truncated', () => {
    const text = renderCostMapText(mapOf({ directories: directoriesOf(COST_MAP_ROW_LIMIT) }));

    expect(text).not.toContain('more directories');
  });

  it('says how many regions it left out too', () => {
    const regions = Array.from(
      { length: COST_MAP_ROW_LIMIT + OVERFLOW },
      (_unused, index) => regionOf({ representative: `r${index}` }),
    );

    const text = renderCostMapText(mapOf({ regions }));

    expect(text).toContain(`and ${OVERFLOW} more regions`);
  });

  it('renders an unknown size as unknown, NEVER as 0 tokens', () => {
    const text = renderCostMapText(mapOf({
      regions: [regionOf({
        unknownTokenRows: 1,
        alwaysRows: [rowOf({ tokens: null, bytes: null, charge: 'unknown-size' })],
      })],
    }));

    expect(text).toContain('size unknown: no measured blob');
    expect(text).not.toMatch(/CLAUDE\.md — 0 tokens/);
  });

  it('surfaces the three counted-not-summed row counters per region', () => {
    const text = renderCostMapText(mapOf({
      regions: [regionOf({ unknownTokenRows: 2, skippedOversizeRows: 1, prunedRows: 3 })],
    }));

    expect(text).toMatch(/size unknown\s+2 rows/);
    expect(text).toMatch(/skipped over 4 MiB\s+1 row\b/);
    expect(text).toMatch(/pruned behind a skip\s+3 rows/);
  });

  it('surfaces the locations it could not answer for, rather than dropping them', () => {
    const text = renderCostMapText(mapOf({
      evaluatedDirectories: 9,
      queriedDirectories: 9,
      skippedUnknownLocations: 7,
    }));

    expect(text).toContain('7');
    expect(text).toMatch(/no answer/i);
  });

  it('never reads as a settled figure', () => {
    const text = renderCostMapText(mapOf({ directories: directoriesOf(COST_MAP_ROW_LIMIT + 1) }));

    expect(text).not.toMatch(/total cost|all context|complete context/i);
  });

  it('ranks the directory table by TOTAL, in the order it was handed', () => {
    // ⛔ The two directories disagree about which is worse depending on the key:
    // `deep` pays a large launch floor and admits no rule, `shallow` the
    // reverse. Ranked by on-demand, `shallow` leads; ranked by total, `deep`
    // does. A fixture where the keys agreed could not tell the two apart.
    const deep = directoryOf({
      directory: 'deep', alwaysTokens: 5000, onDemandTokens: 0, totalTokens: 5000,
    });
    const shallow = directoryOf({
      directory: 'shallow', alwaysTokens: 100, onDemandTokens: 900, totalTokens: 1000,
    });

    const text = renderCostMapText(mapOf({ directories: [deep, shallow] }));

    expect(indexIn(text, 'deep')).toBeLessThan(indexIn(text, 'shallow'));
    // And the total is SHOWN, with both halves beside it — a rank on a number a
    // reader cannot see is a rank they cannot check.
    expect(text).toMatch(/5,000\s+5,000\s+0\s+deep/);
    expect(text).toMatch(/1,000\s+100\s+900\s+shallow/);
  });

  it('reads the total rather than adding the two halves itself', () => {
    // ⛔ The halves deliberately do NOT sum to the total. The CLI must print
    // what it was handed: an arithmetic operator here would be a second, unowned
    // model of what "cost" means, free to disagree with the key the map sorted on.
    const text = renderCostMapText(mapOf({
      directories: [directoryOf({
        directory: 'odd', alwaysTokens: 1, onDemandTokens: 2, totalTokens: 9999,
      })],
    }));

    expect(text).toContain('9,999');
  });

  it('says "1 location" for a region of one, not "1 locations"', () => {
    // A plural-only renderer passes every multi-location fixture, so the
    // one-location region is the only input that can catch it.
    const text = renderCostMapText(mapOf({
      regions: [regionOf({ representative: 'solo', locationCount: 1 })],
    }));

    expect(text).toContain('1 location');
    expect(text).not.toContain('1 locations');
  });

  it('still says "locations" when there is more than one', () => {
    const text = renderCostMapText(mapOf({
      regions: [regionOf({ representative: 'many', locationCount: 4 })],
    }));

    expect(text).toContain('4 locations');
  });

  it('groups thousands in the row lines too, not only in the tables', () => {
    // Two spellings of one quantity within ten lines of each other reads as a
    // bug. The row lines go through the shared `chargeText`, which is why this
    // is asserted on a region's itemised bill rather than on a table column.
    const text = renderCostMapText(mapOf({
      regions: [regionOf({ alwaysTokens: 8385, alwaysRows: [rowOf({ tokens: 8385 })] })],
    }));

    expect(text).toContain('8,385 tokens');
    expect(text).not.toMatch(/\b8385\b/);
  });

  it('omits a region`s counter block when all three are zero', () => {
    // 27 lines of zeros across nine regions buried the launch bills that are
    // the point of the section. ⛔ COUNTED, not searched for: the tree-level
    // roll-up prints the same three labels unconditionally, so a `not.toContain`
    // would fail on the very line that makes this suppression safe. One
    // occurrence is the roll-up; two would mean the region printed as well.
    const text = renderCostMapText(mapOf({ regions: [regionOf()] }));

    expect(text.split(OVERSIZE_LABEL).length - 1).toBe(1);
    expect(text.split('pruned behind a skip').length - 1).toBe(1);
    // ⛔ And the one that survives is the ROLL-UP, not the region's. Counting
    // alone cannot tell them apart — an un-suppressed region plus no roll-up is
    // also one occurrence — so the surviving line is located: it sits AFTER the
    // coverage heading, where a region's block sits well before it.
    expect(indexIn(text, COVERAGE_HEADING)).toBeLessThan(indexIn(text, OVERSIZE_LABEL));
  });

  it('still prints a region`s counter block when any one of the three fires', () => {
    const text = renderCostMapText(mapOf({
      regions: [regionOf({ prunedRows: 1 })],
    }));

    // Whole block or nothing: a reader comparing two regions must be comparing
    // the same three lines, not one region's selected non-zeros.
    expect(text.split(OVERSIZE_LABEL).length - 1).toBe(2);
    expect(text).toMatch(/size unknown\s+0 rows/);
    expect(text).toMatch(/pruned behind a skip\s+1 row\b/);
  });

  it('names a directory`s unknown-size rows only when it has some', () => {
    // Same rule, same safety condition, as the per-region counter block: twenty
    // repetitions of "0 rows of unknown size" crowd out the paths the table is
    // ranking, and the unconditional tree-level roll-up is what still says the
    // rows were counted.
    const measured = renderCostMapText(mapOf({ directories: [directoryOf()] }));
    const blind = renderCostMapText(mapOf({
      directories: [directoryOf({ unknownTokenRows: 2 })],
    }));

    expect(measured).not.toContain('of unknown size');
    expect(blind).toContain('2 rows of unknown size');
  });

  it('prints the tree-level roll-up even when every one of its counts is zero', () => {
    // ⛔ The half that makes suppressing the per-region zeros safe. After that
    // suppression this is the ONLY thing in the report saying the rows were
    // counted at all, so an all-zero roll-up must still print — otherwise
    // "nothing was unmeasurable" becomes indistinguishable from "nobody counted".
    const text = renderCostMapText(mapOf());

    expect(text).toContain('could not measure');
    expect(text).toMatch(/size unknown\s+0 rows/);
    expect(text).toMatch(/skipped over 4 MiB\s+0 rows/);
    expect(text).toMatch(/pruned behind a skip\s+0 rows/);
  });

  it('surfaces the tree-level roll-up in the section about what it looked at', () => {
    const text = renderCostMapText(mapOf({
      unmeasuredRows: { unknownTokenRows: 12, skippedOversizeRows: 3, prunedRows: 45 },
    }));

    expect(indexIn(text, COVERAGE_HEADING)).toBeLessThan(indexIn(text, 'could not measure'));
    expect(text).toMatch(/size unknown\s+12 rows/);
    expect(text).toMatch(/skipped over 4 MiB\s+3 rows/);
    expect(text).toMatch(/pruned behind a skip\s+45 rows/);
  });
});

describe('vat claude context --all — the machine-readable envelope', () => {
  it('discriminates its shape and keeps the limits on the ENVELOPE', () => {
    const envelope = costMapEnvelope('/repo', mapOf());

    expect(envelope.kind).toBe('context-cost-map');
    expect(envelope.boundsStatement).toBe(CLAUDE_CONTEXT_BOUNDS_STATEMENT);
    expect(envelope.limits.find((limit) => limit.id === 'cliff-scope')?.direction).toBe('scope');
    expect(envelope.modelledBehaviours.length).toBeGreaterThan(0);
  });

  it('puts no limit field on any region or directory', () => {
    const envelope = costMapEnvelope('/repo', mapOf({
      regions: [regionOf({ representative: 'a' }), regionOf({ representative: 'b' })],
    }));

    for (const region of envelope.costMap.regions) {
      expect('limits' in region).toBe(false);
      expect('boundsStatement' in region).toBe(false);
    }
    for (const directory of envelope.costMap.directories) {
      expect('limits' in directory).toBe(false);
    }
    // Counted, not merely checked: the whole reason the block is hoisted is that
    // a per-row copy is byte-identical thousands of times over.
    const serialized = JSON.stringify(envelope);
    expect(serialized.split('neither a floor nor a ceiling').length - 1).toBe(1);
  });

  it('carries the map WHOLE, so the text cap never truncates a consumer', () => {
    const total = COST_MAP_ROW_LIMIT + OVERFLOW;

    const envelope = costMapEnvelope('/repo', mapOf({ directories: directoriesOf(total) }));

    // The cap bounds what a PERSON reads. A program asked for the map and gets
    // all of it — silently handing it 20 rows would be the same silent cap the
    // text rendering refuses.
    expect(envelope.costMap.directories).toHaveLength(total);
  });
});
