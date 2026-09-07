/**
 * Instances built by VAT, judged by the vendored upstream authority.
 *
 * ⛔ This file deliberately does NOT diff VAT's Zod schema against upstream's
 * JSON Schema. Subsumption between two JSON Schemas is not decidable in
 * general, and generated output differs from a hand-written document in `$defs`
 * layout and `allOf` nesting in ways that mean nothing — such a check alarms on
 * style and stays silent on substance. Instances are compared against the
 * authority instead.
 *
 * Three disciplines are exercised here, and the second one is why the first is
 * worth anything:
 *
 * 1. Emit, then validate the emitted JSON against `docs/external/ard/`.
 * 2. A **negative control** — known-invalid entries MUST fail. Without it the
 *    whole suite passes vacuously the day the validator is silently unwired.
 * 3. An **exhaustive generated matrix** over every combination of the builder's
 *    optional inputs, so coverage is not limited to cases anyone thought of.
 *    (The repo carries no property-testing dependency and this change does not
 *    add one, so the generation is a hand-written full cartesian product rather
 *    than fast-check.)
 */

import { describe, expect, it } from 'vitest';

import {
  ArdEntrySchema,
  buildArdEntry,
  type ArdEntry,
  type ArdSurface,
} from '../../src/ard/index.js';
import type { ArdConfig } from '../../src/schemas/project-config.js';

import { MINIMAL_ARD_CONFIG, MINIMAL_SKILL_SURFACE, createArdOracle } from './ard-test-helpers.js';

const oracle = createArdOracle();

/** Assert an entry passes the vendored authority, reporting Ajv's own message. */
function expectConformant(entry: unknown, label: string): void {
  const ok = oracle.validateEntry(entry);
  expect(ok, `${label}: ${oracle.errorsOf(oracle.validateEntry)}`).toBe(true);
}

describe('the oracle itself', () => {
  it('compiles the vendored schema and exposes both definitions', () => {
    expect(typeof oracle.validateEntry).toBe('function');
    expect(typeof oracle.validateManifest).toBe('function');
  });
});

describe('emitted entries validate against the vendored schema', () => {
  it('validates a minimal skill entry', () => {
    expectConformant(buildArdEntry(MINIMAL_SKILL_SURFACE, MINIMAL_ARD_CONFIG), 'minimal skill');
  });

  it('validates an entry with no representativeQueries — absence is a warning, not an error', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, MINIMAL_ARD_CONFIG);
    expect(entry).not.toHaveProperty('representativeQueries');
    expectConformant(entry, 'no representativeQueries');
  });
});

// ---------------------------------------------------------------------------
// 2. Negative control
// ---------------------------------------------------------------------------

/**
 * Known-invalid entries. Each is constructed as raw JSON, bypassing the Zod
 * builder on purpose: the builder would refuse them, and refusing them is not
 * what is under test here — the *oracle's* ability to refuse is.
 */
const VALID_ID = 'urn:air:example.com:skills:a';
const VALID_URL = 'https://example.com/a';
/** A conformant entry, so each negative control differs in exactly one way. */
const VALID_RAW = {
  identifier: VALID_ID,
  displayName: 'X',
  type: 'application/ai-skill+md',
  url: VALID_URL,
} as const;

/** One negative control: a description, and the entry with that single defect. */
function invalid(label: string, defect: Record<string, unknown>): readonly [string, unknown] {
  const entry: Record<string, unknown> = { ...VALID_RAW, ...defect };
  for (const [key, value] of Object.entries(defect)) {
    if (value === undefined) delete entry[key];
  }
  return [label, entry];
}

const INVALID_ENTRIES: ReadonlyArray<readonly [string, unknown]> = [
  invalid('identifier missing the namespace segment', { identifier: 'urn:air:example.com' }),
  invalid('identifier not a urn:air URN', { identifier: 'example.com:skills:a' }),
  invalid('displayName absent', { displayName: undefined }),
  invalid('type absent', { type: undefined }),
  invalid('url and data both present', { data: {} }),
  invalid('neither url nor data present', { url: undefined }),
  invalid('metadata value is an object', { metadata: { k: { nested: true } } }),
  invalid('tags is a string, not an array', { tags: 'skills' }),
];

describe('negative control — the oracle refuses what it must', () => {
  it.each(INVALID_ENTRIES)('rejects: %s', (_label, entry) => {
    expect(oracle.validateEntry(entry)).toBe(false);
  });
});

describe('the trust-manifest casing divergence, stated as a test', () => {
  const base = VALID_RAW;

  it('applies TrustManifest constraints to the PascalCase member upstream declares', () => {
    // `identity` is required by `$defs/TrustManifest`.
    expect(oracle.validateEntry({ ...base, TrustManifest: {} })).toBe(false);
  });

  it('applies NO constraints to the camelCase member the prose defines', () => {
    // 🚨 A malformed trust manifest passes, because `trustManifest` reaches the
    // schema only through `EntryFields.additionalProperties: true`. A passing
    // validation is therefore NOT evidence that VAT's trust manifest is
    // well-formed — it is evidence that upstream never looked at it.
    expect(oracle.validateEntry({ ...base, trustManifest: {} })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Exhaustive generated matrix
// ---------------------------------------------------------------------------

/** One toggleable optional input, and what it contributes when switched on. */
interface Toggle {
  readonly name: string;
  readonly onSurface?: Partial<ArdSurface>;
  readonly onConfig?: Partial<ArdConfig>;
  readonly onOverrides?: Record<string, unknown>;
}

const TOGGLES: readonly Toggle[] = [
  { name: 'description', onSurface: { description: 'A described resource' } },
  { name: 'tags', onSurface: { tags: ['alpha', 'beta'] } },
  { name: 'version', onSurface: { version: '1.2.3' } },
  { name: 'updatedAt', onSurface: { updatedAt: '2026-09-06T12:00:00Z' } },
  { name: 'capabilities', onOverrides: { capabilities: ['DoesAThing'] } },
  { name: 'representativeQueries', onOverrides: { representativeQueries: ['q one', 'q two'] } },
  {
    name: 'trustManifest',
    onConfig: { trustManifest: { identity: 'https://example.com/workload' } },
  },
  { name: 'url', onConfig: { baseUrl: 'https://example.com/catalog' }, onSurface: { urlPath: 'a.md' } },
];

/** Every subset of {@link TOGGLES}, as a bitmask over its indices. */
function combinationAt(mask: number): { label: string; surface: ArdSurface; config: ArdConfig } {
  let surface: ArdSurface = { ...MINIMAL_SKILL_SURFACE };
  let config: ArdConfig = { ...MINIMAL_ARD_CONFIG };
  let overrides: Record<string, unknown> = {};
  const on: string[] = [];
  for (const [index, toggle] of TOGGLES.entries()) {
    if (Math.trunc(mask / 2 ** index) % 2 === 0) continue;
    on.push(toggle.name);
    surface = { ...surface, ...toggle.onSurface };
    config = { ...config, ...toggle.onConfig };
    overrides = { ...overrides, ...toggle.onOverrides };
  }
  if (Object.keys(overrides).length > 0) {
    config = { ...config, entries: { [surface.name]: overrides } };
  }
  return { label: on.length > 0 ? on.join('+') : '(none)', surface, config };
}

const COMBINATION_COUNT = 2 ** TOGGLES.length;

describe(`exhaustive matrix — all ${COMBINATION_COUNT} combinations of optional inputs`, () => {
  it('every combination builds, parses under the strict Zod schema, and passes the oracle', () => {
    const failures: string[] = [];
    for (let mask = 0; mask < COMBINATION_COUNT; mask += 1) {
      const { label, surface, config } = combinationAt(mask);
      let entry: ArdEntry;
      try {
        entry = buildArdEntry(surface, config);
      } catch (error) {
        failures.push(`${label}: builder threw ${String(error)}`);
        continue;
      }
      const parsed = ArdEntrySchema.safeParse(entry);
      if (!parsed.success) {
        const first = parsed.error.issues[0]?.message ?? '(no issue reported)';
        failures.push(`${label}: Zod refused its own output — ${first}`);
        continue;
      }
      if (!oracle.validateEntry(entry)) {
        failures.push(`${label}: ${oracle.errorsOf(oracle.validateEntry)}`);
      }
      if (Object.hasOwn(entry, 'url') && Object.hasOwn(entry, 'data')) {
        failures.push(`${label}: emitted BOTH url and data`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('covers both the url arm and the data arm', () => {
    const arms = new Set<string>();
    for (let mask = 0; mask < COMBINATION_COUNT; mask += 1) {
      const { surface, config } = combinationAt(mask);
      const entry = buildArdEntry(surface, config);
      arms.add(Object.hasOwn(entry, 'url') ? 'url' : 'data');
    }
    expect([...arms].sort((a, b) => a.localeCompare(b))).toEqual(['data', 'url']);
  });
});
