/**
 * The environment one ARM of a measurement runs under.
 *
 * Two layers, both here:
 *
 * - {@link clearedEnvironment} — what every child of a timed arm starts from:
 *   the developer's environment minus every INHERITED `VAT_*` name, the names
 *   git exports into a hook ({@link INHERITED_GIT_ENV}, owned by utils), and —
 *   for a VAT step — the temp, XDG, Claude and git-config state in
 *   {@link CLEARED_ENV_NAMES}. What the arm itself sets (a caller's `--env
 *   VAT_RESOURCES_CRAWL=walk` included) wins over the clearing: only the
 *   inherited value is dropped.
 * - {@link buildArmEnv} — the last step before a spawn: the arm's `set` and
 *   `unset` over `process.env`, which never re-admits a variable that decides
 *   WHICH vat runs ({@link ARM_OWNED_ENV_KEYS}) unless the arm set it. A
 *   `VAT_BIN` exported in the operator's shell would otherwise reach both arms
 *   and turn a two-build comparison into one build measured twice.
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

import { INHERITED_GIT_ENV } from '@vibe-agent-toolkit/utils';

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
 * Variables a VAT step of a timed arm never inherits from the developer's shell,
 * beyond every `VAT_*` name.
 *
 * Each one hands the child a piece of the developer's state: `CLAUDE_CONFIG_DIR`
 * their Claude config; `TMPDIR`/`TEMP`/`TMP` their parse cache; `XDG_CACHE_HOME`
 * a cache root; `XDG_CONFIG_HOME` and `GIT_CONFIG_GLOBAL` their global git
 * config and excludes, which decide what both builds' snapshots and listings
 * admit; `GIT_TEMPLATE_DIR` and `GIT_EXEC_PATH` the hooks and git helpers a
 * clone or a git child runs. The arm sets its own `TMPDIR`, `HOME`,
 * `CLAUDE_CONFIG_DIR`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_ATTR_NOSYSTEM=1` (see
 * `arm-dirs.ts`): with the rest removed, git reads no system config or
 * attributes and its global config is the empty arm home. Every other way a
 * shell can hand git a config — {@link GIT_CONFIG_OVERRIDE} — goes with them,
 * and so does every inherited `npm_config_*` but the network ones ({@link NPM_NETWORK}).
 *
 * Kept here, not in utils' `INHERITED_GIT_ENV`: that list is what git exports
 * into a HOOK, pinned equal to the shipped hook scrub; these are the
 * developer's own settings, which only a measured arm must run without.
 */
export const CLEARED_ENV_NAMES = Object.freeze([
  'CLAUDE_CONFIG_DIR',
  'GIT_ATTR_NOSYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_SYSTEM',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
] as const);

/** `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`: the numbered config pairs `GIT_CONFIG_COUNT` enables. */
const GIT_CONFIG_OVERRIDE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u;

/** Every npm setting a shell can hand a child, in whatever case: npm reads the prefix case-insensitively. */
const NPM_CONFIG = /^npm_config_/iu;

/**
 * The only inherited npm settings a VAT step keeps — the network ones, so an
 * npx arm behind a proxy, a private registry or a corporate CA still reaches
 * it: `registry`, a scoped `@scope:registry`, `proxy`, `https-proxy`,
 * `noproxy`/`no-proxy`, `ca`, `cafile` and `strict-ssl`, in either the `-` or
 * the `_` spelling and any case. Every other `npm_config_*` is removed: the
 * developer's identity and config files (`userconfig`, `_auth`, a `//host/:…`
 * token, `cert`/`key`), and everything that changes what npm does
 * (`ignore-scripts`, `offline`, `node-options`, `script-shell`, …). An allow
 * list, so a setting npm adds later is removed until it is named here. The
 * arm's own `npm_config_*` (see `arm-dirs.ts`) are set, not inherited.
 */
const NPM_NETWORK = /^npm_config_(?:registry|@[^:/]+:registry|proxy|https[-_]proxy|no[-_]?proxy|ca|cafile|strict[-_]ssl)$/iu;

/**
 * What git exports into a hook — which repository, index, object store,
 * shallow and graft files and discovery ceiling a child uses — removed from
 * every step, VAT or tool. A lab run from inside a git hook inherits them, and
 * a child would then read or write the outer repository instead of the clone
 * it stands in. The list is utils' {@link INHERITED_GIT_ENV}, never restated.
 */
const HOOK_GIT_NAMES: ReadonlySet<string> = new Set<string>(INHERITED_GIT_ENV);

/**
 * Which environment a step of a sequence runs under.
 *
 * - `vat` — every VAT step, timed or not: the developer's environment minus
 *   every `VAT_*` name and {@link CLEARED_ENV_NAMES}.
 * - `tool` — a non-VAT step (`pnpm install`, a build): minus every `VAT_*` name
 *   only. pnpm needs the real `~/.npmrc`, and pnpm, corepack and turbo write
 *   state under `$HOME`, which must not land in the arm's home.
 */
type StepEnvironmentKind = 'vat' | 'tool';

/** A cleared environment, and what it removed and kept of the inherited one — recorded in the run report. */
export interface ClearedEnvironment {
  readonly env: ArmEnvironment;
  /** Inherited names removed, sorted; a name the arm sets itself is not listed. */
  readonly removed: readonly string[];
  /**
   * The npm network setting names ({@link NPM_NETWORK}) a VAT step's child is
   * handed, inherited or set by the arm, sorted — names only, never values — so
   * two developers' runs can be told apart. Empty for a tool step, which keeps
   * every npm setting.
   */
  readonly npmNetwork: readonly string[];
}

/**
 * The environment for one step of a timed arm: the inherited one, cleared of
 * the developer's VAT, git and claude state, then the arm's own.
 *
 * @param inherited - The environment being inherited, normally `process.env`
 * @param kind - Which steps' rule applies; see {@link StepEnvironmentKind}
 * @param own - What the arm itself sets and removes
 * @param platform - Where the child runs: on `win32` a name matches whatever
 *   its case (`Temp` is `TEMP`), and the inherited spelling is what is removed
 * @returns The arm environment to run under, and what it removed
 */
export function clearedEnvironment(
  inherited: NodeJS.ProcessEnv,
  kind: StepEnvironmentKind,
  own: ArmEnvironment,
  platform: NodeJS.Platform,
): ClearedEnvironment {
  const spell = envNameSpelling(platform);
  const ownSet = new Set(Object.keys(own.set).map(spell));
  const cleared = Object.keys(inherited)
    .filter((name) => isCleared(spell(name), kind) && !Object.hasOwn(own.set, name))
    .sort(compareByCodeUnit);
  // A name the arm sets under another spelling (Windows' `Temp` beside `TEMP`)
  // is still dropped, so the child sees one value — but it was re-pointed, not
  // removed, and the report says only what the child went WITHOUT.
  const removed = cleared.filter((name) => !ownSet.has(spell(name)));
  const env = mergeArmEnvironments({ set: {}, unset: cleared }, own);
  // Read off what the child is handed, so an arm's own unset or set is honoured.
  const npmNetwork = kind === 'vat' ? Object.keys(buildArmEnv(inherited, env)).filter((name) => NPM_NETWORK.test(name)).sort(compareByCodeUnit) : [];
  return { env, removed, npmNetwork };
}

/**
 * @param platform - Where the child runs
 * @returns The spelling two environment names share exactly when they are one
 *   variable there: upper case on `win32`, where names are case-insensitive
 */
export function envNameSpelling(platform: NodeJS.Platform): (name: string) => string {
  return platform === 'win32' ? (name) => name.toUpperCase() : (name) => name;
}

const VAT_CLEARED: ReadonlySet<string> = new Set(CLEARED_ENV_NAMES);

/**
 * @param name - An inherited name, upper-cased where names are case-insensitive
 * @param kind - Which steps' rule applies
 * @returns Whether a step of that kind runs without it
 */
function isCleared(name: string, kind: StepEnvironmentKind): boolean {
  if (name.startsWith('VAT_') || HOOK_GIT_NAMES.has(name)) return true;
  return kind === 'vat' && (VAT_CLEARED.has(name) || GIT_CONFIG_OVERRIDE.test(name) || (NPM_CONFIG.test(name) && !NPM_NETWORK.test(name)));
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
