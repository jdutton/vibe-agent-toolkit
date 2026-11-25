/**
 * The debug-facts dump has two contracts: the cli's writer (`validate-debug-facts.ts`, whose
 * `gateDeclinedBy` is the gate's `GateDecline`) and the lab's strict reader
 * (`ValidateDebugFactsSchema`). Every variant of `GateDecline` (every condition, and a `member`
 * decline under every route) and the overlapped dump go through the real writer to disk and must
 * parse under the lab's schema, as written.
 *
 * The variants are enumerated from the cli's own lists: `GATE_DECLINE_CONDITIONS` and
 * `GATE_MEMBER_ROUTES`, which typecheck holds to the `GateDecline` union and to `StoredComputeBy`.
 * A condition or route added on the cli side fails this test until {@link DECLINES} or
 * {@link MEMBER_ROUTES} lists it, and then until the lab reads it.
 *
 * Integration tier: the dumps are real files in a real directory.
 */
import { readdirSync, readFileSync } from 'node:fs';

import { ValidateDebugFactsSchema } from '@vibe-agent-toolkit/lab';
import type { StoredComputeBy } from '@vibe-agent-toolkit/resources';
import { WORK_COUNTER_NAMES, type WorkCounter, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GATE_DECLINE_CONDITIONS, GATE_MEMBER_ROUTES, type GateDecline } from '../../src/commands/checks-overlap-gate.js';
import { type ChecksPhaseObservation, openDebugFacts, writeDebugFacts } from '../../src/commands/validate-debug-facts.js';
import { cleanupTestTempDir, createTestTempDir } from '../system/test-common.js';

/** One decline per condition, keyed by it: a missing condition is a type error. */
const DECLINES: { readonly [C in GateDecline['condition']]: GateDecline & { readonly condition: C } } = {
  debug: { condition: 'debug' },
  cores: { condition: 'cores' },
  'not-hit': { condition: 'not-hit' },
  disarmed: { condition: 'disarmed' },
  'not-settled': { condition: 'not-settled' },
  rejected: { condition: 'rejected', error: 'the tier read failed' },
  member: { condition: 'member', member: 'docs/a.md', route: 'storedRoute' },
};

/** One `member` decline per route, keyed by it: a missing route is a type error. */
const MEMBER_ROUTES: { readonly [R in StoredComputeBy]: GateDecline } = {
  storedRoute: { condition: 'member', member: 'docs/a.md', route: 'storedRoute' },
  readRoute: { condition: 'member', member: 'docs/b.md', route: 'readRoute' },
};

/** Every counter at `value`: an instant's snapshot. */
function countersAt(value: number): Readonly<Record<WorkCounter, number>> {
  return Object.fromEntries(WORK_COUNTER_NAMES.map((name) => [name, value])) as Record<WorkCounter, number>;
}

/** Every observation the writer can be handed: each decline, and an overlapped run. */
const OBSERVATIONS: ReadonlyArray<readonly [string, ChecksPhaseObservation]> = [
  ...Object.values(DECLINES).map((declinedBy) => [`declined by ${declinedBy.condition}`, { mode: 'sequential', declinedBy }] as const),
  ...Object.entries(MEMBER_ROUTES).map(([route, declinedBy]) => [`declined by a member, ${route}`, { mode: 'sequential', declinedBy }] as const),
  ['overlapped', { mode: 'overlapped', childStderrBytesAtTurn: 12, atSpawn: countersAt(3), atChildExit: countersAt(5) }],
];

let directory: string;

beforeEach(() => {
  directory = createTestTempDir('vat-debug-facts-lab-');
});
afterEach(() => {
  cleanupTestTempDir(directory);
});

describe('the debug-facts dump, read by the lab', () => {
  it('writes every condition and every member route the cli names', () => {
    expect(new Set(Object.keys(DECLINES))).toEqual(new Set(GATE_DECLINE_CONDITIONS));
    expect(new Set(Object.keys(MEMBER_ROUTES))).toEqual(new Set(GATE_MEMBER_ROUTES));
  });

  it.each(OBSERVATIONS)('%s: the written dump parses under the lab\'s strict schema, field for field', (_name, observed) => {
    const dumps = safePath.join(directory, 'dumps');
    const opened = openDebugFacts({ VAT_VALIDATE_DEBUG_FACTS: dumps });

    const written = writeDebugFacts(opened, observed);

    expect(written).not.toBeNull();
    const names = readdirSync(dumps);
    expect(names).toHaveLength(1);
    const dump: unknown = JSON.parse(readFileSync(safePath.join(dumps, names[0] ?? ''), 'utf8'));
    const parsed = ValidateDebugFactsSchema.safeParse(dump);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // Strict both ways: the lab reads back exactly what the cli wrote.
    expect(parsed.data).toEqual(dump);
  });
});
