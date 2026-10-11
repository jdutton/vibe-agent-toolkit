/**
 * The environment one ARM of a measurement runs under.
 *
 * `process.env` is inherited — the io facet's `NODE_OPTIONS` preload depends on
 * it (see `run.ts`) — EXCEPT the variables that decide WHICH vat runs
 * ({@link ARM_OWNED_ENV_KEYS}). Those are never inherited: an arm that wants one
 * sets it. A `VAT_BIN` exported in the lab operator's shell would otherwise
 * reach both arms and turn a two-build comparison into one build measured
 * twice, with nothing in the report to say so.
 *
 * ## Why `set` AND `unset`, and why the field is required everywhere
 *
 * Merging over `process.env` can add and override but never remove, so an arm
 * that must run WITHOUT something the operator's shell carries
 * (`CLAUDE_CONFIG_DIR`, a user-level config override) had no way to say so.
 * `unset` is that way. The field is required on every `RunOptions` and
 * `CaptureRequest` rather than optional: an optional environment is a seam
 * whose omission compiles, and the omission is exactly the inherited-leak
 * failure this module exists to close. {@link EMPTY_ARM_ENVIRONMENT} is the
 * spelling for "this arm sets nothing" — still stripped of the arm-owned keys.
 */

import { compareByCodeUnit } from './fingerprint.js';

/** What one arm sets over, and removes from, the inherited environment. */
export interface ArmEnvironment {
  /** Variables set for every child of the arm; they win over anything inherited. */
  readonly set: Readonly<Record<string, string>>;
  /** Variables removed from the inherited environment. Never also in {@link set}. */
  readonly unset: readonly string[];
}

/** An arm that sets nothing and removes nothing beyond {@link ARM_OWNED_ENV_KEYS}. */
export const EMPTY_ARM_ENVIRONMENT: ArmEnvironment = Object.freeze({
  set: Object.freeze({}),
  unset: Object.freeze([]),
});

/**
 * Variables that select WHICH vat runs; never inherited, only ever set explicitly.
 *
 * Exactly the `VAT_*` variables the CLI wrapper (`packages/cli/src/bin/vat.ts`)
 * reads or sets, minus its diagnostic `VAT_DEBUG` — pinned both ways by
 * `arm-env.test.ts`, which derives the wrapper's set from its source, so a
 * resolution variable the wrapper gains cannot quietly start leaking.
 */
export const ARM_OWNED_ENV_KEYS = Object.freeze([
  'VAT_BIN',
  'VAT_ROOT_DIR',
  'VAT_TEST_ROOT',
  'VAT_CONTEXT',
  'VAT_CONTEXT_PATH',
] as const);

/**
 * The first key an arm both sets and unsets, if any — one of the two is a
 * mistake, and picking a winner would hide which.
 *
 * The one definition of that rule: `buildArmEnv` throws on it, and the CLI
 * refuses on it before anything runs.
 *
 * @param arm - The arm to check
 * @returns The clashing key, or `undefined` when there is none
 */
export function armEnvironmentClash(arm: ArmEnvironment): string | undefined {
  return arm.unset.find((key) => Object.hasOwn(arm.set, key));
}

/**
 * The environment to hand one child of an arm.
 *
 * @param inherited - The environment being inherited, normally `process.env`
 * @param arm - What the arm sets and removes
 * @returns `inherited` minus {@link ARM_OWNED_ENV_KEYS} minus `arm.unset`, plus `arm.set`
 * @throws {Error} when a key is both set and unset — see {@link armEnvironmentClash}
 */
export function buildArmEnv(inherited: NodeJS.ProcessEnv, arm: ArmEnvironment): NodeJS.ProcessEnv {
  const clash = armEnvironmentClash(arm);
  if (clash !== undefined) {
    throw new Error(`arm environment: '${clash}' is both set and unset`);
  }
  const env: NodeJS.ProcessEnv = { ...inherited };
  for (const key of [...ARM_OWNED_ENV_KEYS, ...arm.unset]) delete env[key];
  return { ...env, ...arm.set };
}

/**
 * Layer one arm environment over another.
 *
 * `over` wins a set, and a key `over` sets is no longer unset; a key `over`
 * unsets is no longer set. The result therefore never carries a key on both
 * sides, which is what lets {@link buildArmEnv} treat that as a caller error.
 *
 * @param base - The environment underneath
 * @param over - The environment layered on top
 * @returns The merged environment, `unset` deduplicated and sorted
 */
export function mergeArmEnvironments(base: ArmEnvironment, over: ArmEnvironment): ArmEnvironment {
  const unset = [
    ...new Set([...base.unset.filter((key) => !Object.hasOwn(over.set, key)), ...over.unset]),
  ].sort(compareByCodeUnit);
  const set = Object.fromEntries(
    Object.entries({ ...base.set, ...over.set }).filter(([key]) => !over.unset.includes(key)),
  );
  return { set, unset };
}

/**
 * Do two arms run under the same environment?
 *
 * Order-insensitive on both halves, and an unset key is NOT the same as an
 * absent one: unsetting removes something the operator's shell may carry.
 *
 * @param a - One arm
 * @param b - The other
 * @returns True when both set the same values and unset the same keys
 */
export function sameArmEnvironment(a: ArmEnvironment, b: ArmEnvironment): boolean {
  return canonical(a) === canonical(b);
}

/**
 * One string per distinct arm environment.
 *
 * @param arm - The arm
 * @returns A JSON rendering with both halves sorted
 */
function canonical(arm: ArmEnvironment): string {
  const set = Object.entries(arm.set).sort(([left], [right]) => compareByCodeUnit(left, right));
  const unset = [...new Set(arm.unset)].sort(compareByCodeUnit);
  return JSON.stringify({ set, unset });
}
