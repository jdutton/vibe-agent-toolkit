/**
 * `launchCharge` — whether one accounted row's bytes are paid when a session
 * starts — and `admissionLoadsAtLaunch`, which names the admission a
 * `claude_context_loads` row is reported under.
 *
 * ## Why the rows are hand-built rather than fixtured
 *
 * Both functions are pure predicates over one row or one admission, so a
 * projection fixture would add a population run to reach the handful of fields
 * they read. The tree-level claim — that the charged sum IS `vat claude
 * context`'s `alwaysTokens` — is the chains oracle's to hold, not this file's.
 *
 * ## ⛔ Depth and attribution do not move a charge
 *
 * An earlier version charged imports only at one hop and declined unattributed
 * imports, because a since-deleted token threshold had been calibrated there.
 * The harness loads a launch-time closure at every hop it admits, so those rows
 * are charged; the cases below are what keep that calibration from creeping
 * back. VAT's own tree has no import past one hop, so no fixture derived from
 * it can.
 */

import { describe, expect, it } from 'vitest';

import type { AccountedRow } from '../src/projection/claude-context-accounting.js';
import {
  admissionLoadsAtLaunch,
  LAUNCH_CHARGES,
  launchCharge,
} from '../src/projection/claude-context-launch-charge.js';
import type { Admission } from '../src/projection/claude-context-query.js';

/** The directory the admissions below name. */
const DIR = 'packages/thing';

/** The closure root the import admissions below hang off. */
const ROOT = 'CLAUDE.md';

/** The value a launch-time, measured row carries. */
const CHARGED = 'charged';

/**
 * An import admission at a given depth. `depth: null` is the unattributed row.
 *
 * @param depth - Hops from the closure root, or null
 * @returns The admission
 */
function imported(depth: number | null): Admission {
  return { kind: 'import', rootPath: ROOT, viaPath: ROOT, depth };
}

/**
 * Every rule kind that is NOT launch-time, spelled as `RuleAdmission` spells it.
 *
 * ⛔ The mutation guard against an over-broad predicate: written as
 * `admission.kind.endsWith('rule')`, `admissionLoadsAtLaunch` passes the
 * `root-rule` case and fails every row here.
 */
const ON_DEMAND_RULES: ReadonlyArray<readonly [string, Admission]> = [
  ['glob-rule', { kind: 'glob-rule', pattern: `${DIR}/src/*.ts` }],
  ['glob-rule-covers-dir', { kind: 'glob-rule-covers-dir', pattern: `${DIR}/**` }],
  [
    'glob-rule-may-fire',
    { kind: 'glob-rule-may-fire', pattern: `${DIR}/*.ts`, examplePath: `${DIR}/a.ts` },
  ],
];

/**
 * A launch-time, measured row, with whatever the case overrides.
 *
 * @param overrides - The fields under test
 * @returns The row
 */
function makeRow(overrides: Partial<AccountedRow> = {}): AccountedRow {
  return {
    resourceId: 'id:CLAUDE.md',
    path: ROOT,
    tokens: 100,
    bytes: 400,
    loadClass: 'always',
    sizeCliff: 'loaded',
    admissions: [{ kind: 'ancestry', dir: DIR, local: false }],
    headerTokens: 0,
    ...overrides,
  };
}

describe('launchCharge', () => {
  it('charges a measured always-class row', () => {
    expect(launchCharge(makeRow())).toBe(CHARGED);
  });

  it.each([0, 1, 2, 4, null])('charges an always-class import at depth %s', (depth) => {
    expect(launchCharge(makeRow({ admissions: [imported(depth)] }))).toBe(CHARGED);
  });

  it('charges a root-rule row', () => {
    expect(launchCharge(makeRow({ admissions: [{ kind: 'root-rule' }] }))).toBe(CHARGED);
  });

  it('marks an on-demand row not-always, whatever its size', () => {
    expect(launchCharge(makeRow({ loadClass: 'on-demand' }))).toBe('not-always');
    expect(launchCharge(makeRow({ loadClass: 'on-demand', tokens: null, sizeCliff: 'unmeasured' })))
      .toBe('not-always');
  });

  it.each(['oversize-skipped', 'pruned-by-oversize'] as const)(
    'marks a %s row oversize — the harness does not load it',
    (sizeCliff) => {
      expect(launchCharge(makeRow({ sizeCliff }))).toBe('oversize');
    },
  );

  it('marks an unmeasured row unknown-size, never charged', () => {
    expect(launchCharge(makeRow({ tokens: null, bytes: null, sizeCliff: 'unmeasured' })))
      .toBe('unknown-size');
    // ⛔ A null token count on an otherwise-loaded row is still unknown, never a
    // free file.
    expect(launchCharge(makeRow({ tokens: null }))).toBe('unknown-size');
  });

  it('lets the cliff outrank an unknown size', () => {
    expect(launchCharge(makeRow({ tokens: null, sizeCliff: 'oversize-skipped' }))).toBe('oversize');
  });

  it('only ever answers a published value', () => {
    const published: readonly string[] = LAUNCH_CHARGES;
    const answers = [
      makeRow(),
      makeRow({ loadClass: 'on-demand' }),
      makeRow({ sizeCliff: 'pruned-by-oversize' }),
      makeRow({ tokens: null, sizeCliff: 'unmeasured' }),
    ].map((row) => launchCharge(row));
    for (const answer of answers) expect(published).toContain(answer);
    expect(new Set(answers).size).toBe(LAUNCH_CHARGES.length);
  });
});

describe('admissionLoadsAtLaunch', () => {
  it.each([
    ['ancestry', { kind: 'ancestry', dir: DIR, local: false }],
    ['root-rule', { kind: 'root-rule' }],
    ['import', imported(3)],
    ['unattributed import', imported(null)],
  ] as ReadonlyArray<readonly [string, Admission]>)('admits %s', (_label, admission) => {
    expect(admissionLoadsAtLaunch(admission)).toBe(true);
  });

  it.each(ON_DEMAND_RULES)('never admits %s', (_label, admission) => {
    expect(admissionLoadsAtLaunch(admission)).toBe(false);
  });
});
