/**
 * What a populating run of an arm must leave behind, decided from the arm's
 * own VAT environment — the one place the cold and warm rules learn whether the
 * arm has a projection store and a parse cache at all.
 *
 * A command populating a projection is not enough: `VAT_PROJECTION_STORE=off`
 * keeps the parse cache and drops the store, and `VAT_CACHE=0` vetoes both.
 * Every inherited `VAT_*` name is cleared from a VAT step, so the arm's own
 * `set` is the whole of what the child sees. The reading mirrors vat's
 * `projectionStoreSelected()` (packages/cli/src/utils/projection-store.ts) and
 * `ParseCache`'s `VAT_CACHE` switch through the same `parseEnvBoolean`; the
 * integration tier pins both halves against the built cli and resources.
 */

import { parseEnvBoolean } from '@vibe-agent-toolkit/utils';

import { type ArmEnvironment, envNameSpelling } from './arm-env.js';

/** vat's switch for every disk cache; only an explicit false vetoes. */
const CACHE_ENV = 'VAT_CACHE';

/** vat's projection-store selector; unset is on, empty is off. */
const PROJECTION_STORE_ENV = 'VAT_PROJECTION_STORE';

/** What a populating run must write — and, when false, must NOT write. */
export interface PopulationExpectation {
  /** The arm's store is written, and a warm reader reports the `store` population. */
  readonly store: boolean;
  /** A shard lands in the build's parse directory. */
  readonly parseShard: boolean;
}

/**
 * @param env - The arm's VAT-step environment
 * @param platform - Where the child runs (names are case-insensitive on win32)
 * @returns What a populating run of that arm writes
 */
export function populationExpectation(env: ArmEnvironment, platform: NodeJS.Platform): PopulationExpectation {
  const spell = envNameSpelling(platform);
  const valueOf = (name: string): string | undefined =>
    Object.entries(env.set).find(([key]) => spell(key) === spell(name))?.[1];
  const caching = parseEnvBoolean(valueOf(CACHE_ENV)) !== false;
  const selector = valueOf(PROJECTION_STORE_ENV);
  const selected = selector === undefined || (selector.trim() !== '' && parseEnvBoolean(selector) !== false);
  return { store: caching && selected, parseShard: caching };
}
