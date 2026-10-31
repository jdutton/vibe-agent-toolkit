/**
 * What one step of a timed sequence says about where its projection came from,
 * and whether that is what the arm's cache state requires.
 *
 * A warm arm whose baseline never actually warms (a store that misses on every
 * run) would otherwise compare a cold baseline against a warm candidate and
 * report the difference as a win. So every measured warm repetition's resources
 * step must REPORT `population: 'store'` wherever its build publishes the
 * field — and the candidate's `validate` must report it for its checks phase
 * too (S1 bar 4) — and a field that is absent fails the measurement: absent is
 * never a pass.
 *
 * Which field carries it depends on the document, and the step names its reader:
 *
 * - `resources-check` — `vat resources check`'s `data.population` (rc.11 and the
 *   candidate alike); `data.lensPopulation` is recorded when published.
 * - `validate` — the orchestrator document: `data.phases[name='resources'].data.population`
 *   and the `checks` phase's `population`, both judged, plus its `lensPopulation`, recorded.
 * - `none` — a verb that publishes no population (rc.11's `resources validate`
 *   and `skills validate`): nothing is read and nothing asserted.
 */

import { parseDocument } from './document-shape.js';
import type { CacheMode } from './types.js';

/** Which document reader a step's output goes through. */
export type ProvenanceReader = 'none' | 'resources-check' | 'validate';

/** One step's provenance; `null` for a field the document did not carry. */
export interface StepProvenance {
  /** Where the resources population came from. */
  readonly resources: string | null;
  /** Where the checks phase's population came from (the candidate's `validate`). */
  readonly checks: string | null;
  /** The checks' lens population, when published. */
  readonly lens: string | null;
}

/** The population that proves a warm run was served from the store. */
const STORE_POPULATION = 'store';

/**
 * Read a step's provenance from its stdout.
 *
 * @param reader - Which document the step produces
 * @param stdout - The step's stdout
 * @returns The fields read, or `null` for a step with no reader
 */
export function readProvenance(reader: ProvenanceReader, stdout: string): StepProvenance | null {
  if (reader === 'none') return null;
  const parsed = parseDocument(stdout);
  const payload = parsed.shape === 'unparsed' ? undefined : parsed.payload;
  if (reader === 'resources-check') {
    return { resources: stringField(payload, 'population'), checks: null, lens: stringField(payload, 'lensPopulation') };
  }
  const checks = phaseData(payload, 'checks');
  return {
    resources: stringField(phaseData(payload, 'resources'), 'population'),
    checks: stringField(checks, 'population'),
    lens: stringField(checks, 'lensPopulation'),
  };
}

/**
 * Judge one step's provenance against its arm's cache state.
 *
 * Only a warm sequence reads a document field; a cold sequence's rule is about
 * its directories, and is checked by the runner.
 *
 * @param step - The step's name, for the message
 * @param reader - The step's reader
 * @param provenance - What {@link readProvenance} found
 * @param state - The arm's cache state
 * @param storeOn - Whether the arm's environment selects a projection store
 *   (`populationExpectation`): off, a warm reader must NOT report the store
 * @returns `null`, or the violation that fails the measurement
 */
export function provenanceViolation(
  step: string,
  reader: ProvenanceReader,
  provenance: StepProvenance | null,
  state: CacheMode,
  storeOn: boolean,
): string | null {
  if (state !== 'warm' || reader === 'none') return null;
  const judged = [
    { who: `step '${step}'`, absent: 'published no resources population', population: provenance?.resources ?? null },
    ...(reader === 'validate'
      ? [{ who: `step '${step}' checks phase`, absent: 'published no population', population: provenance?.checks ?? null }]
      : []),
  ];
  for (const { who, absent, population } of judged) {
    const violation = populationViolation(who, absent, population, storeOn);
    if (violation !== null) return violation;
  }
  return null;
}

/**
 * @param who - The step (or its phase), for the message
 * @param absent - What an absent field is, for the message
 * @param population - The population it reported, or `null`
 * @param storeOn - Whether the arm selects a projection store
 * @returns The violation, or `null`
 */
function populationViolation(who: string, absent: string, population: string | null, storeOn: boolean): string | null {
  if (population === null) return `warm rule: ${who} ${absent} (absent is never a pass)`;
  if (!storeOn) {
    return population === STORE_POPULATION
      ? `warm rule: ${who} reports population '${STORE_POPULATION}' though the arm turned the store off`
      : null;
  }
  return population === STORE_POPULATION
    ? null
    : `warm rule: ${who} reports population '${population}', not '${STORE_POPULATION}' — the arm is not warm`;
}

/**
 * @param payload - An orchestrator document's `data`
 * @param name - A phase name
 * @returns That phase's own `data`, or `undefined`
 */
function phaseData(payload: unknown, name: string): unknown {
  const phases = isRecord(payload) ? payload['phases'] : undefined;
  if (!Array.isArray(phases)) return undefined;
  const phase: unknown = phases.find((entry: unknown) => isRecord(entry) && entry['name'] === name);
  return isRecord(phase) ? phase['data'] : undefined;
}

/**
 * @param value - Any value
 * @param key - A field name
 * @returns The field when it is a string, else `null`
 */
function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

/**
 * @param value - Any value
 * @returns True for a plain object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
