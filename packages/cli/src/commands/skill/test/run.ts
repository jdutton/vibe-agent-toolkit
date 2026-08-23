/**
 * `vat skill test run <skill>` — execute a packaged skill's eval suite in isolation.
 *
 * Thin orchestration layer: parse flags, resolve precedence (flag > config > default),
 * print the §12 security warning, call runSkillTestHarness, map result/error to exit code.
 * All domain logic lives in run-harness.ts (agent-skills package).
 */

import { existsSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';

import {
  BootstrapNeededError,
  buildStaleDistWarningLines,
  DuplicateStagedSkillError,
  isAcknowledged,
  mapErrorToExitCode,
  packageSkill,
  packagingConfigToPackageOptions,
  runPreStageBuild,
  runSkillTestHarness,
  SecurityAckError,
  SKILL_TEST_BUILTIN_CAPS,
  SkillBuildError,
  SkillTestExitCode,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig, SkillSourceDescriptor, TestConfig } from '@vibe-agent-toolkit/resources';
import { findProjectRoot, resolveAssetReference, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { parseSourceSpec } from '../../../skill-resolution/classify.js';
import {
  findDeclaredSkillForPath,
  findDeclaredSkillForSourceDir,
  resolveProjectDeclaredEvalSuites,
  resolveSkillReference,
  type BuildableReference,
  type DeclaredSkillLink,
} from '../../../skill-resolution/index.js';
import { ConfigLoadError, loadConfig, loadConfigCached } from '../../../utils/config-loader.js';
import { runClaudePluginBuild } from '../../claude/plugin/build.js';

import { assertValidAuth, assertValidRequireAuth } from './auth-flags.js';

/** Extract the trailing path segment (cross-platform) from a path-like string. */
function lastPathSegment(p: string): string {
  return basename(toForwardSlash(p));
}

// ---------------------------------------------------------------------------
// Security warning (§12)
// ---------------------------------------------------------------------------

const SECURITY_WARNING = `
WARNING: 'vat skill test run' EXECUTES the skill's code on your machine.

It spawns headless Claude sessions with --permission-mode bypassPermissions,
so the staged skill files run with YOUR user account's
full privileges: they can read and write your files (including credentials under
~/.claude, SSH keys, cloud configs), run shell commands, and make network
requests. The auth credential used to bill the run is reachable by that code.

This harness provides CONTEXT isolation only (a fresh temp working directory, a
scrubbed env allowlist, and no user/project settings) -- it is NOT an OS-level
security sandbox. Only run skills whose code you trust and have reviewed.

Pass --i-understand-this-runs-skill-code to acknowledge this and proceed.
`.trim();

function printSecurityWarning(): void {
  process.stderr.write(SECURITY_WARNING + '\n\n');
}

// ---------------------------------------------------------------------------
// Flag/option types
// ---------------------------------------------------------------------------

export interface SkillTestRunOptions {
  with?: string[];
  withOptional?: string[];
  refresh?: boolean;
  workdir?: string;
  out?: string;
  keep?: boolean;
  dryRun?: boolean;
  auth?: string;
  requireAuth?: string;
  /**
   * Tri-state, and it must stay tri-state: `true` from `--baseline`, `false` from
   * `--no-baseline`, `undefined` when neither was typed (config decides). Commander
   * gives this shape because `--baseline` is declared BEFORE `--no-baseline`; a
   * lone `--no-baseline` would default the value to `true` instead. See
   * {@link resolveBaseline}.
   */
  baseline?: boolean;
  allowUnverifiedSkillSource?: boolean;
  iUnderstandThisRunsSkillCode?: boolean;
  model?: string;
  /** Model for the fixed grader/judge (GLOBAL, independent of `model` — the model UNDER TEST). */
  graderModel?: string;
  maxTurns?: string;
  maxBudgetUsd?: string;
  timeout?: string;
  stall?: string;
  /** Max evals graded in parallel (GLOBAL — the executor→grader pipeline width). */
  concurrency?: string;
  debug?: boolean;
  env?: string[];
  passEnv?: string[];
  /**
   * Path (or npm bare specifier) to the evals.json this run grades against.
   * Resolved against the process cwd, unlike `test.evals`, which is resolved
   * against the skill source.
   */
  evals?: string;
  /** Skip building a declared subject and stage its existing dist instead. */
  noBuild?: boolean;
  /** Opt out of the fail-closed default: exit Ok (0) even when an eval fails. */
  allowEvalFailure?: boolean;
}

// ---------------------------------------------------------------------------
// Knob coercion helpers
// ---------------------------------------------------------------------------

function coercePositiveInt(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flagName} must be a positive integer. Got: ${value}`);
  }
  return n;
}

function coercePositiveFloat(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flagName} must be a positive number. Got: ${value}`);
  }
  return n;
}

function coerceKnobs(options: SkillTestRunOptions): {
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeout?: number;
  stall?: number;
  concurrency?: number;
} {
  const result: {
    maxTurns?: number;
    maxBudgetUsd?: number;
    timeout?: number;
    stall?: number;
    concurrency?: number;
  } = {};

  const maxTurns = coercePositiveInt(options.maxTurns, '--max-turns');
  if (maxTurns !== undefined) result.maxTurns = maxTurns;

  const maxBudgetUsd = coercePositiveFloat(options.maxBudgetUsd, '--max-budget-usd');
  if (maxBudgetUsd !== undefined) result.maxBudgetUsd = maxBudgetUsd;

  const timeout = coercePositiveInt(options.timeout, '--timeout');
  if (timeout !== undefined) result.timeout = timeout;

  const stall = coercePositiveInt(options.stall, '--stall');
  if (stall !== undefined) result.stall = stall;

  const concurrency = coercePositiveInt(options.concurrency, '--concurrency');
  if (concurrency !== undefined) result.concurrency = concurrency;

  return result;
}

// ---------------------------------------------------------------------------
// --with / --with-optional parsing (I2)
// ---------------------------------------------------------------------------

type HarnessOpts = Parameters<typeof runSkillTestHarness>[0];
type SkillSourceSpec = NonNullable<HarnessOpts['withSources']>[string];

/** The declared-executable recognition aid the harness forwards to the WITH-arm grader. */
type DeclaredExecutable = NonNullable<HarnessOpts['declaredExecutables']>[number];

/**
 * Map a resolved skill's packaging-config `executables` (SkillExecutableEntry[]) to
 * the grader's recognition-aid shape (issue #145 Phase T): each entry's stable NAME
 * is its `path` basename with the extension stripped (`scripts/csvsum.py` → `csvsum`),
 * carried alongside its `howInvoked` + `kind`. Returns undefined for absent/empty
 * input so the harness omits the aid entirely (the grader still matches tools by the
 * commands in the transcript). Pure + unit-testable.
 */
export function deriveDeclaredExecutableNames(
  executables: SkillPackagingConfig['executables'],
): DeclaredExecutable[] | undefined {
  if (executables === undefined || executables.length === 0) return undefined;
  return executables.map((e) => {
    const base = basename(toForwardSlash(e.path));
    const ext = extname(base);
    const name = ext === '' ? base : base.slice(0, -ext.length);
    return { name, howInvoked: e.howInvoked, kind: e.kind };
  });
}

/**
 * Parse a single `name=src` pair into a [name, SkillSourceSpec] tuple. The
 * source half uses a `kind:value` prefix:
 *   workspace:foo · npm:@scope/s@1.2.3 · url:https://… · path:../baz · vendored
 * A bare value without `name=` is rejected — every companion needs a name so
 * the domain can key it (and so the skill resolves under that name in staging).
 */
function parseWithPair(pair: string): [string, SkillSourceSpec] {
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    throw new Error(
      `--with entries must be "name=<src>" (e.g. mydep=workspace:foo, bar=npm:@scope/s@1.2.3, baz=path:../baz). Got: ${pair}`,
    );
  }
  const name = pair.slice(0, eq);
  try {
    return [name, parseSourceSpec(pair.slice(eq + 1))];
  } catch (e) {
    throw new Error(`--with: ${e instanceof Error ? e.message : String(e)} (in ${pair})`);
  }
}

/** Parse an array of `name=src` flag values into a name→spec record. */
export function parseWithFlags(pairs: string[] | undefined): Record<string, SkillSourceSpec> | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined;
  const record: Record<string, SkillSourceSpec> = {};
  for (const pair of pairs) {
    const [name, spec] = parseWithPair(pair);
    // Fail closed on a repeated companion name rather than silently overwriting
    // (last-wins would drop a companion the user asked for — the #153 no-op class).
    if (Object.hasOwn(record, name)) throw new DuplicateStagedSkillError(name);
    record[name] = spec;
  }
  return record;
}

/** Derive a stable name for a config-supplied (nameless) skill source descriptor. */
function descriptorName(d: SkillSourceDescriptor): string {
  if ('workspace' in d) return d.workspace;
  if ('npm' in d) return d.npm.replace(/@[^@/]+$/, '');
  if ('path' in d) return lastPathSegment(d.path) || d.path;
  if ('url' in d) return 'url-dep';
  return 'skill-creator';
}

/** Map a config descriptor array (with/optional) into a name→spec record. */
export function descriptorsToRecord(
  list: SkillSourceDescriptor[] | undefined,
): Record<string, SkillSourceSpec> | undefined {
  if (list === undefined || list.length === 0) return undefined;
  const record: Record<string, SkillSourceSpec> = {};
  for (const d of list) {
    const name = descriptorName(d);
    // Two config descriptors deriving the same name (e.g. two `path:` entries with
    // the same basename) would silently overwrite — the exact silent-drop #153
    // targets, one layer above buildStageItems. Fail closed here instead.
    if (Object.hasOwn(record, name)) throw new DuplicateStagedSkillError(name);
    record[name] = d;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Precedence resolution: flag > config > default
// ---------------------------------------------------------------------------

/**
 * Read a DECLARED skill's own `skills.config.<name>.test` block from the config that
 * governs IT — keyed by the declared name against that skill's `configRoot`, never by
 * cwd. The one lookup used wherever "what did THIS skill declare?" is the question:
 * {@link loadTestConfig}'s path-target arm and companion `test.build` resolution
 * ({@link resolveCompanionSpec}), so a companion in a nested config never inherits the
 * subject's block.
 */
function declaredSkillTestConfig(link: { configRoot: string; name: string }): TestConfig | undefined {
  return loadConfigCached(link.configRoot)?.skills?.config?.[link.name]?.test;
}

/**
 * Load the persisted `skills.config.<skill>.test` block for the subject skill,
 * PROJECT-AWARE (mirrors the resolver's ladder ORDER — not a parallel cwd+basename
 * resolver).
 *
 * A PATH target is mapped back to its declared skill through the SAME two lookups
 * {@link resolveDefinitePath} (in resolve-skill-reference.ts) uses, tried in the SAME
 * order: first {@link findDeclaredSkillForSourceDir} (a path AT a declared skill's
 * SOURCE dir — rung 2a, `buildable`), then {@link findDeclaredSkillForPath} (a path AT
 * its already-built DIST dir — the `source` + `declaredSkill` back-link rung). Either
 * hit is keyed by the DECLARED name against ITS OWN governing config via
 * {@link declaredSkillTestConfig} — cwd-independent, so a path target honors the same
 * model/evals/timeout/`test.build` as its name.
 *
 * The basename fallback below is a LAST RESORT, reached only when `subject` carries
 * NEITHER link — a bare name (matched by literal string), or a path outside every
 * declared skill's source/dist dir. It must never be the path a LINKED subject's
 * config resolves through: a directory basename that happens to differ from its
 * declared skill's name would otherwise silently miss that skill's `test:` block
 * (including a required `test.build` hook) with no error — the exact failure mode
 * this ordering exists to prevent. Missing config / missing file → undefined
 * (defaults apply).
 *
 * A broken config throws {@link ConfigLoadError}; we let it propagate to the preflight
 * guard in runSkillTestRun, which surfaces it as a clean exit-2 error rather than
 * silently applying defaults against a config the author clearly intended.
 */
async function loadTestConfig(subject: string, cwd: string): Promise<TestConfig | undefined> {
  // Rung 2a: a path AT a declared skill's SOURCE dir — tried FIRST, matching
  // resolveDefinitePath's own precedence.
  const sourceLink = await findDeclaredSkillForSourceDir(subject, cwd);
  if (sourceLink !== undefined) return declaredSkillTestConfig(sourceLink);
  // Reverse rung: a path AT a declared skill's already-built DIST dir.
  const link = await findDeclaredSkillForPath(subject, cwd);
  if (link !== undefined) return declaredSkillTestConfig(link);
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot === null) return undefined;
  const perSkill = loadConfig(projectRoot)?.skills?.config;
  if (perSkill === undefined) return undefined;
  // Last-resort basename fallback (see doc comment above): only reached when neither
  // lookup above found a declared-skill link for `subject`.
  const base = lastPathSegment(subject) || subject;
  return perSkill[subject]?.test ?? perSkill[base]?.test;
}

/** Resolve the project root used as the harness repoRoot anchor. */
function resolveRepoRoot(): string {
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

/** The top-level `test:` config node (graderModel, concurrency) — GLOBAL settings. */
type SkillTestGlobalConfig = ProjectConfig['test'];

/**
 * Load the persisted TOP-LEVEL `test:` config node (`graderModel`, `concurrency`)
 * from the GOVERNING project config. Deliberately distinct from
 * {@link loadTestConfig}, which reads the PER-SKILL `skills.config.<skill>.test`
 * block: graderModel/concurrency are global judge/pipeline settings that apply
 * across every skill's test run, not something a single skill's config should
 * override (issue #145).
 *
 * Undefined when there's no project root or no `test:` node. A broken config
 * throws {@link ConfigLoadError}, propagated the same way as loadTestConfig's
 * errors (surfaced by the caller's preflight guard as a clean exit-2).
 */
function loadGlobalTestConfig(cwd: string): SkillTestGlobalConfig {
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot === null) return undefined;
  return loadConfig(projectRoot)?.test;
}

/** Copy flag-only passthrough options (no config counterpart) onto opts. */
function applyFlagOnlyOptions(opts: HarnessOpts, options: SkillTestRunOptions): void {
  if (options.refresh !== undefined) opts.refresh = options.refresh;
  if (options.workdir !== undefined) opts.workdir = options.workdir;
  if (options.out !== undefined) opts.out = options.out;
  if (options.keep !== undefined) opts.keep = options.keep;
  if (options.dryRun !== undefined) opts.dryRun = options.dryRun;
  if (options.allowUnverifiedSkillSource !== undefined) opts.allowUnverifiedSkillSource = options.allowUnverifiedSkillSource;
  if (options.iUnderstandThisRunsSkillCode !== undefined) opts.acknowledgedRunsSkillCode = options.iUnderstandThisRunsSkillCode;
  if (options.allowEvalFailure !== undefined) opts.tolerateEvalFailure = options.allowEvalFailure;
}

/** Apply flag>config merges for scalar knobs (auth, model, baseline, eval/prompt). */
function applyScalarMerges(opts: HarnessOpts, options: SkillTestRunOptions, config: TestConfig | undefined): void {
  const authMode = options.auth ?? config?.auth;
  if (authMode !== undefined) opts.auth = authMode as 'inherit' | 'subscription' | 'api-key' | 'auto';
  const authRequirement = options.requireAuth ?? config?.requireAuth;
  if (authRequirement !== undefined) opts.requireAuth = authRequirement as 'subscription' | 'api-key';
  const baseline = resolveBaseline(options.baseline, config?.baseline);
  if (baseline !== undefined) opts.baseline = baseline;
  const model = options.model ?? config?.model;
  if (model !== undefined) opts.model = model;
  // `--evals` is resolved HERE, against the process cwd, so the operator's own
  // shell path means what they typed; `test.evals` is left alone and resolves
  // against the skill source, because config travels with the skill. Both then
  // reach the harness as one field, and both accept a path or an npm bare
  // specifier (a suite published as a shared corpus).
  const evalsRef =
    options.evals === undefined ? config?.evals : resolveAssetReference(options.evals, process.cwd());
  if (evalsRef !== undefined) opts.evalsSubpath = evalsRef;
}

/**
 * Resolve `--baseline` with flag > config precedence, ANNOUNCING a config-sourced
 * enable on stderr.
 *
 * Same threat model as {@link resolveCappedKnob} next door — a value from a
 * COMMITTED config rides along in an untrusted subject repo — applied to the one
 * cost knob that has no cap to clamp. `baseline` is the LARGEST cost multiplier in
 * this command: it runs every eval TWICE (skill declared vs withheld), and each arm
 * is an executor spawn AND a grader spawn, so `skills.config.<skill>.test.baseline:
 * true` roughly doubles the spend of every `vat skill test run` an operator types.
 * `--max-budget-usd` is a PER-SPAWN cap, so the worst-case ceiling doubles with it.
 *
 * A boolean cannot be clamped to a ceiling, so it is announced instead, and
 * `--no-baseline` exists so the operator can turn it back off for THIS run without
 * hand-editing someone else's YAML. Precedence runs both directions: an explicit
 * flag wins whether it says true or false (hence the `undefined` check rather than
 * `??`-style falsiness, which would let a config `true` override `--no-baseline`).
 *
 * Only an ENABLE is announced. A config `false` costs nothing and needs no note.
 */
export function resolveBaseline(
  flagValue: boolean | undefined,
  configValue: boolean | undefined,
): boolean | undefined {
  if (flagValue !== undefined) return flagValue;
  if (configValue !== true) return configValue;
  process.stderr.write(
    "Note: baseline is ON from this project's committed config ('skills.config.<skill>.test.baseline'), " +
      'not from a flag; it runs every eval TWICE (an executor AND a grader spawn per arm), roughly doubling ' +
      'the spawns and the spend. Pass --no-baseline to turn it off for this run.\n',
  );
  return true;
}

/**
 * Resolve one cost/runtime knob with flag > config > default precedence AND a
 * built-in safety cap, enforcing an asymmetry between the two sources:
 *
 *   - a CLI FLAG (explicit operator intent for THIS run) wins and may exceed the
 *     built-in cap;
 *   - a value from a COMMITTED config (which rides along in an untrusted subject
 *     repo) may only LOWER the cap — a config trying to RAISE it above the ceiling
 *     is clamped to the ceiling, with a one-line stderr note so the clamp isn't
 *     silent.
 *
 * Returns undefined only when neither source set the knob (the domain then applies
 * its own built-in default). `flagName` is the CLI flag shown in the clamp note.
 */
export function resolveCappedKnob(
  flagValue: number | undefined,
  configValue: number | undefined,
  cap: number,
  flagName: string,
): number | undefined {
  if (flagValue !== undefined) return flagValue;
  if (configValue === undefined) return undefined;
  if (configValue > cap) {
    process.stderr.write(
      `Note: config value ${configValue} for '${flagName}' exceeds the built-in safety cap ${cap}; using ${cap}. ` +
        `A committed config may only lower this cap, not raise it — pass ${flagName} to override for this run.\n`,
    );
    return cap;
  }
  return configValue;
}

/** Apply flag>config merges for numeric knobs (turns/budget/timeout/stall). */
function applyKnobMerges(
  opts: HarnessOpts,
  knobs: ReturnType<typeof coerceKnobs>,
  config: TestConfig | undefined,
): void {
  const maxTurns = resolveCappedKnob(knobs.maxTurns, config?.maxTurns, SKILL_TEST_BUILTIN_CAPS.maxTurns, '--max-turns');
  if (maxTurns !== undefined) opts.maxTurns = maxTurns;
  const maxBudgetUsd = resolveCappedKnob(
    knobs.maxBudgetUsd,
    config?.maxBudgetUsd,
    SKILL_TEST_BUILTIN_CAPS.maxBudgetUsd,
    '--max-budget-usd',
  );
  if (maxBudgetUsd !== undefined) opts.maxBudgetUsd = maxBudgetUsd;
  const timeout = resolveCappedKnob(knobs.timeout, config?.timeout, SKILL_TEST_BUILTIN_CAPS.timeoutSeconds, '--timeout');
  if (timeout !== undefined) opts.timeout = timeout;
  // `stall` is a liveness watchdog, not a cost ceiling — no built-in cap to clamp.
  const stall = knobs.stall ?? config?.stall;
  if (stall !== undefined) opts.stall = stall;
}

/**
 * Parse a single `KEY=VALUE` pair (split on the FIRST `=`, so values may contain
 * `=`). The key must be non-empty; the value may be empty.
 */
function parseEnvPair(pair: string): [string, string] {
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    throw new Error(
      `--env entries must be "KEY=VALUE" (e.g. CUSTOMER_SNAPSHOT_PATH=\${fixturesDir}/snapshot.json). Got: ${pair}`,
    );
  }
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

/** Parse repeated `--env KEY=VALUE` flags into a record (undefined when none). */
function parseEnvFlags(pairs: string[] | undefined): Record<string, string> | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined;
  const record: Record<string, string> = {};
  for (const pair of pairs) {
    const [key, value] = parseEnvPair(pair);
    record[key] = value;
  }
  return record;
}

/** Merge config + CLI `env` maps; CLI wins per-key. undefined when both absent. */
function mergeEnv(
  configEnv: Record<string, string> | undefined,
  cliEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (configEnv === undefined && cliEnv === undefined) return undefined;
  return { ...configEnv, ...cliEnv };
}

/** Union config + CLI `passEnv` lists (config first), de-duplicated. */
function mergePassEnv(
  configPass: string[] | undefined,
  cliPass: string[] | undefined,
): string[] | undefined {
  if (configPass === undefined && cliPass === undefined) return undefined;
  return [...new Set([...(configPass ?? []), ...(cliPass ?? [])])];
}

/** Apply flag>config merges for the declared test env (Features A + B). */
function applyEnvMerges(opts: HarnessOpts, options: SkillTestRunOptions, config: TestConfig | undefined): void {
  const env = mergeEnv(config?.env, parseEnvFlags(options.env));
  if (env !== undefined) opts.env = env;
  const passEnv = mergePassEnv(config?.passEnv, options.passEnv);
  if (passEnv !== undefined) opts.passEnv = passEnv;
}

/** Apply flag>config merges for the companion-skill records (with/optional). */
function applyDepMerges(opts: HarnessOpts, options: SkillTestRunOptions, config: TestConfig | undefined): void {
  const withSources = parseWithFlags(options.with) ?? descriptorsToRecord(config?.with);
  if (withSources !== undefined) opts.withSources = withSources;
  const withOptional = parseWithFlags(options.withOptional) ?? descriptorsToRecord(config?.optional);
  if (withOptional !== undefined) opts.withOptional = withOptional;
}

/**
 * Apply flag>config merges for the GLOBAL grader/concurrency knobs — the
 * top-level `test:` config node (see {@link loadGlobalTestConfig}), NOT the
 * per-skill `skills.config.<skill>.test` block. Precedence: flag > top-level
 * config > default(undefined) — left undefined here so the domain applies
 * DEFAULT_GRADER_MODEL / DEFAULT_CONCURRENCY.
 */
function applyGraderMerges(
  opts: HarnessOpts,
  options: SkillTestRunOptions,
  knobs: ReturnType<typeof coerceKnobs>,
  globalTest: SkillTestGlobalConfig,
): void {
  const graderModel = options.graderModel ?? globalTest?.graderModel;
  if (graderModel !== undefined) opts.graderModel = graderModel;
  const concurrency = knobs.concurrency ?? globalTest?.concurrency;
  if (concurrency !== undefined) opts.concurrency = concurrency;
}

/**
 * Resolve CLI flags → RunHarnessOptions, applying flag > config > default
 * precedence. CLI flags win; config (`skills.config.<skill>.test`) fills gaps;
 * built-in defaults (inside the domain) are the final fallback.
 */
function buildHarnessOpts(
  subject: string,
  options: SkillTestRunOptions,
  knobs: ReturnType<typeof coerceKnobs>,
  config: TestConfig | undefined,
  globalTest: SkillTestGlobalConfig,
): HarnessOpts {
  const repoRoot = resolveRepoRoot();
  const opts: HarnessOpts = { subject, repoRoot };
  applyFlagOnlyOptions(opts, options);
  applyScalarMerges(opts, options, config);
  applyKnobMerges(opts, knobs, config);
  applyDepMerges(opts, options, config);
  applyEnvMerges(opts, options, config);
  applyGraderMerges(opts, options, knobs, globalTest);
  return opts;
}

// ---------------------------------------------------------------------------
// Subject resolution (project-aware): resolve -> build -> stage
// ---------------------------------------------------------------------------

export interface ResolvedSubject {
  /** The source staged + tested ({ path: <distDir> } for a built declared skill). */
  subjectSource: SkillSourceSpec;
  /** Authored source dir (bootstrap eval scaffolding); absent for nameless sources. */
  subjectScaffoldDir?: string;
  /** True only when this resolution actually built the subject (declared skill, no --no-build/--dry-run). */
  rebuilt: boolean;
  /**
   * True when the resolved reference is `buildable` — a real run would build + stage
   * it before spawning. False for plain `source` subjects (path/npm/url/vendored).
   */
  wouldBuild: boolean;
  /**
   * Set only for a `buildable` subject under --dry-run: true = the dry-run staged
   * the existing on-disk dist WITHOUT rebuilding (may be stale); false = no dist
   * existed yet so the preview fell back to the source dir. Absent when not a dry-run
   * or when the subject is a plain source.
   */
  dryRunStagedExistingDist?: boolean;
  /**
   * True when a PATH target mapped back to a declared skill (its `test:` config is
   * honored and its scaffold dir points at the authored source). Gates the
   * config-bypass warning: only a path with NO declared linkage is config-blind.
   */
  linkedToDeclaredSkill?: boolean;
  /**
   * Declared executables (name + kind + howInvoked) derived from the subject's
   * packaging config, forwarded to the WITH-arm grader as a tool recognition aid
   * (issue #145 Phase T). Populated ONLY for a `buildable` subject (which carries
   * `packagingConfig`); a plain path/source subject leaves it undefined.
   */
  declaredExecutables?: DeclaredExecutable[];
}

/**
 * Scaffold-dir fields for a `source` subject. A path that maps back to a declared
 * skill anchors at the AUTHORED source (dirname of its SKILL.md) so `config.evals`
 * resolves + overlays from there — the built dist it points at does not carry the
 * eval suite. An UNLINKED path anchors at the resolved path itself (legacy behavior;
 * the path IS the skill dir). A nameless source (npm/url/vendored) has no scaffold dir.
 */
function sourceScaffoldFields(
  source: SkillSourceSpec,
  declaredSkill: DeclaredSkillLink | undefined,
  cwd: string,
): { subjectScaffoldDir?: string; linkedToDeclaredSkill?: boolean } {
  if (declaredSkill !== undefined) {
    return { subjectScaffoldDir: dirname(declaredSkill.sourcePath), linkedToDeclaredSkill: true };
  }
  if ('path' in source) {
    return { subjectScaffoldDir: safePath.resolve(cwd, source.path) };
  }
  return {};
}

/**
 * Build GATING for a declared skill: the flags that decide IF a build happens.
 * Assembled once per run in {@link runSkillTestRun} and threaded, unchanged, through
 * SUBJECT and COMPANION resolution so both arms share one gate.
 *
 * Deliberately carries NO `test.build` command. That hook is per-SKILL, not per-run:
 * it is declared by one skill in one config and runs with THAT config's root as cwd,
 * so it travels beside the ref being built (see {@link buildDeclaredSkill}'s
 * `buildCommand`), never inside this shared gate. A subject's command riding in here
 * would execute against every companion's config root.
 */
export interface BuildFlags {
  /** Skip the build entirely and stage the existing dist (errors if absent). */
  noBuild: boolean;
  /** Assemble a preview only — never spawn. Builds ONLY when {@link explicitAck}. */
  dryRun: boolean;
  /**
   * The §12 security acknowledgment as the harness computes it — a dry run counts
   * as acknowledged, because a preview that never builds and never spawns executes
   * nothing. Gates SecurityAckError.
   */
  acknowledged: boolean;
  /**
   * Whether `--i-understand-this-runs-skill-code` was ACTUALLY passed, distinct from
   * {@link acknowledged}, which a dry run satisfies for free.
   *
   * A dry run now BUILDS, and building runs the repo's committed `test.build` hook —
   * an arbitrary shell command. Gating that on {@link acknowledged} would be no gate
   * at all, since dry runs synthesize it. So the build decision uses this raw flag,
   * keeping an unacknowledged dry run safe to point at an untrusted clone.
   */
  explicitAck: boolean;
}

/**
 * Project-aware subject resolution for `vat skill test run`. Resolves the subject
 * reference; for a declared skill, builds it (real entry points) and returns the
 * dist dir to stage; everything else is staged as-is. Throws SkillBuildError
 * (exit 2) for name-miss / not-found / --no-build-without-dist / build failure.
 *
 * `memo` is the per-run build memo (see {@link BuildMemo}) — pass the SAME map used
 * for companion resolution so a skill that is both subject and companion builds once.
 *
 * `buildCommand` is the SUBJECT's own `test.build` hook, resolved by
 * {@link loadTestConfig} (which carries a bare-name/basename fallback a raw config
 * lookup lacks). It applies to the subject's build ONLY — companions resolve theirs
 * from their own governing config.
 */
export async function resolveSubjectForTest(
  ref: string,
  cwd: string,
  flags: BuildFlags,
  memo: BuildMemo,
  buildCommand: string | undefined,
): Promise<ResolvedSubject> {
  const resolved = await resolveSkillReference(ref, cwd);
  switch (resolved.kind) {
    case 'source':
      return {
        subjectSource: resolved.source,
        rebuilt: false,
        wouldBuild: false,
        ...sourceScaffoldFields(resolved.source, resolved.declaredSkill, cwd),
      };
    case 'name-miss':
      throw new SkillBuildError(
        `no skill named '${resolved.name}' in ${resolved.configRoot}; known skills: ${resolved.knownSkills.join(', ') || '(none)'}. (For a directory, use './${resolved.name}'.)`,
      );
    case 'not-found':
      throw new SkillBuildError(
        `no path '${resolved.ref}' and no governing config to resolve a name; pass a path or run inside a VAT project.`,
      );
    case 'buildable': {
      // A buildable ref carries `packagingConfig` — the ONE cleanly-reachable place
      // the subject's declared executables live — so attach the grader recognition
      // aid here (a plain source has no packaging config and leaves it undefined).
      const subject = await resolveBuildableSubject(resolved, flags, memo, buildCommand);
      const declaredExecutables = deriveDeclaredExecutableNames(resolved.packagingConfig.executables);
      return declaredExecutables === undefined ? subject : { ...subject, declaredExecutables };
    }
  }
}

/** Result of {@link buildDeclaredSkill}: where the built (or reused) dist landed. */
export interface BuildDeclaredSkillResult {
  distDir: string;
  rebuilt: boolean;
  /**
   * Set only under --dry-run: true = an existing dist was staged WITHOUT
   * rebuilding (may be stale); false = no dist existed yet so the preview fell
   * back to the source dir. Absent for a real (non-dry-run) build.
   */
  dryRunStagedExistingDist?: boolean;
}

/**
 * --no-build / --dry-run branch of {@link buildDeclaredSkill}: never builds. Stage
 * the existing dist if present; for a dry-run with no dist yet, fall back to the
 * source dir so the preview still assembles without triggering a build. Throws
 * when --no-build is set but no dist exists.
 */
function resolveExistingDistOrThrow(
  ref: BuildableReference,
  flags: { noBuild: boolean; dryRun: boolean },
): BuildDeclaredSkillResult {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- expectedDistDir derived from project config
  if (existsSync(ref.expectedDistDir)) {
    if (flags.noBuild) {
      process.stderr.write(`Using existing dist (NOT rebuilt): ${ref.expectedDistDir}\n`);
    }
    return {
      distDir: ref.expectedDistDir,
      rebuilt: false,
      // For a dry-run that staged an existing (unbuilt) dist, flag it as
      // potentially stale so the summary can warn the user.
      ...(flags.dryRun ? { dryRunStagedExistingDist: true } : {}),
    };
  }
  if (flags.dryRun) {
    return { distDir: dirname(ref.sourcePath), rebuilt: false, dryRunStagedExistingDist: false };
  }
  throw new SkillBuildError(
    `--no-build: no built dist at ${ref.expectedDistDir} for '${ref.name}'. Run \`vat build\` first, or point at a built path.`,
  );
}

/**
 * Per-run memo of BUILD OPERATIONS, so one build operation never runs twice in a
 * run. Two disjoint key namespaces share the set: the declared-skill build itself
 * (`pool:` / `plugin:`, see {@link buildMemoKey}) and the `test.build` pre-stage
 * shell hook (`hook:`, see {@link preStageHookMemoKey}) — the hook needs its own
 * because two DIFFERENT skills in one config may declare the SAME command, which
 * is one hook invocation but two distinct builds.
 *
 * A `Set` of operation keys, NOT a `Map` caching results: the key identifies an
 * OPERATION, not a skill, and a
 * `plugin-local` operation rebuilds the WHOLE marketplace, so two different skills
 * in that marketplace deliberately share one key while having DIFFERENT
 * `expectedDistDir`s. A result cached under that shared key would be valid only for
 * the ref that recorded it — handing it to the other ref would stage the WRONG
 * skill's dist. {@link verifyBuiltDist} is what a memo hit re-derives (always keyed
 * off THIS ref, never a cached value) to avoid exactly that bug.
 */
export type BuildMemo = Set<string>;

/**
 * Identity of the BUILD OPERATION a {@link BuildableReference} triggers — the memo key.
 *
 * A `pool` skill is built by `packageSkill` into its own `expectedDistDir`, so that
 * dir IS the operation's identity. A `plugin-local` skill is built by
 * `runClaudePluginBuild`, which `rm -rf`s and rebuilds EVERY plugin in the whole
 * marketplace — so the operation's identity is the (configRoot, marketplace) pair,
 * NOT the skill. Keying plugin-local per skill would make a second companion in the
 * same marketplace trigger a full marketplace wipe-and-rebuild that reproduces work
 * the first call already did.
 */
export function buildMemoKey(ref: BuildableReference): string {
  return ref.distribution.kind === 'pool'
    ? `pool:${ref.expectedDistDir}`
    : `plugin:${ref.configRoot}:${ref.distribution.marketplaceName}`;
}

/**
 * Assert a completed build actually MATERIALIZED `ref.expectedDistDir` with a real
 * skill in it, and return the result to stage. A build that reports success but
 * writes nothing (or writes an empty shell with no `SKILL.md`) would otherwise hand
 * back a path a required companion then fails opaquely at staging, or an OPTIONAL
 * one silently skips — the exact non-functional-companion-with-no-diagnostic
 * symptom of issue #158. Two distinct checks, two distinct messages, so the error
 * tells the author which failure mode they hit:
 *   1. `expectedDistDir` itself is missing — "no output at all".
 *   2. `expectedDistDir` exists but has no `SKILL.md` — an empty/incomplete shell.
 *
 * Also runs on a memo HIT, because a plugin-local hit may have been recorded by a
 * DIFFERENT skill in the same marketplace: the dist dir always comes from THIS ref
 * and is always checked.
 */
function verifyBuiltDist(ref: BuildableReference): BuildDeclaredSkillResult {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- expectedDistDir derived from project config
  if (!existsSync(ref.expectedDistDir)) {
    throw new SkillBuildError(
      `Skill build for '${ref.name}' reported success but produced no output at ${ref.expectedDistDir}. ` +
        `Check the skill's packaging config (\`vat build\` should create this directory).`,
    );
  }
  const skillMdPath = safePath.join(ref.expectedDistDir, 'SKILL.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillMdPath derived from project config
  if (!existsSync(skillMdPath)) {
    throw new SkillBuildError(
      `Skill build for '${ref.name}' reported success but produced no SKILL.md at ${ref.expectedDistDir}. ` +
        `Check the skill's packaging config (\`vat build\` should create this file).`,
    );
  }
  return { distDir: ref.expectedDistDir, rebuilt: true };
}

/**
 * Identity of a `test.build` PRE-STAGE HOOK invocation — the (cwd, command) pair, which
 * is everything that distinguishes one shell invocation from another. Namespaced `hook:`
 * so it can never collide with a {@link buildMemoKey} entry in the shared {@link BuildMemo}.
 */
function preStageHookMemoKey(configRoot: string, buildCommand: string): string {
  return `hook:${configRoot}:${buildCommand}`;
}

/**
 * Run a skill's `test.build` pre-stage hook, at most ONCE per (configRoot, command)
 * within a run — the "runs that shell command ONCE before staging" contract documented
 * on {@link runPreStageBuild}, preserved now that a run may build several skills.
 *
 * The command ALWAYS runs with the config root of the skill that DECLARED it as cwd
 * (both values come from the same ref), so a subject's hook can never execute against
 * a companion's package root. Memoized only on SUCCESS: a hook that failed and was
 * tolerated (optional companion) is retried rather than treated as done.
 *
 * KNOWN LIMITATION: for `plugin-local` skills, the memo key this call is gated behind
 * ({@link buildMemoKey} in {@link buildDeclaredSkill}) is the shared `plugin:<configRoot>:
 * <marketplace>` key, not a per-skill one — because one marketplace build serves every
 * participant. When two declared skills share a marketplace, only the FIRST participant's
 * `test.build` hook runs; the second skill's own hook is silently skipped, since by the
 * time its build call is reached the memo already reports the marketplace as built and
 * this function is never invoked for it. Fixing that requires gathering the hook set for
 * every marketplace participant BEFORE the one marketplace build — out of scope here.
 */
function runPreStageBuildOnce(
  buildCommand: string | undefined,
  configRoot: string,
  memo: BuildMemo,
): void {
  if (buildCommand === undefined) return;
  const key = preStageHookMemoKey(configRoot, buildCommand);
  if (memo.has(key)) return;
  runPreStageBuild({ buildCommand, configRoot });
  memo.add(key);
}

/** Dispatch the real build for a declared skill, by how it ships. Throws the raw build error. */
async function runDeclaredSkillBuild(ref: BuildableReference): Promise<void> {
  if (ref.distribution.kind === 'pool') {
    // The WHOLE project's declared eval suites, not just this ref's: the dist a test
    // stages must be byte-for-byte what `vat skills build` produces, and that bundle
    // excludes every skill's test input. Getting this wrong would hand the executor
    // under test another skill's answer key — the exact signal the harness exists to
    // protect. Memoized per config root, so a multi-skill run discovers once.
    await packageSkill(
      ref.sourcePath,
      packagingConfigToPackageOptions(
        ref.packagingConfig,
        { skillPath: ref.sourcePath, outputPath: ref.expectedDistDir },
        await resolveProjectDeclaredEvalSuites(ref.sourcePath),
      ),
    );
    return;
  }
  await runClaudePluginBuild(ref.configRoot, { marketplace: ref.distribution.marketplaceName });
}

/**
 * Build a declared skill (BuildableReference) into its `expectedDistDir`, or reuse
 * the existing dist under --no-build/--dry-run. Shared by SUBJECT resolution
 * ({@link resolveBuildableSubject}) and `--with`/`--with-optional` COMPANION
 * resolution ({@link resolveCompanionSpec}) so a companion that maps to a declared
 * skill gets the exact same build treatment as the subject (issue #158) — its
 * `files:` injection runs before staging, instead of a raw, possibly
 * build-artifact-incomplete, source-tree copy.
 *
 * `buildCommand` is the `test.build` pre-stage hook DECLARED BY THIS REF's skill —
 * never a shared per-run flag. It runs with `ref.configRoot` as cwd, so command and
 * cwd always come from the same skill's config (see {@link runPreStageBuildOnce}).
 * GUARANTEED to run (once, on the first call for this ref) for a `pool`-distributed
 * skill, whose memo key is per-skill. KNOWN LIMITATION for `plugin-local` skills: the
 * memo key is the shared marketplace build, so when two declared skills share a
 * marketplace, only the FIRST participant reaching this function gets its hook run —
 * the second skill's build is served by the memo hit at the check below, and its own
 * `test.build` hook is silently skipped (see {@link runPreStageBuildOnce}).
 *
 * `memo` collapses repeat work within ONE run (see {@link buildMemoKey}). It is
 * consulted only AFTER the no-build/dry-run short-circuit and AFTER the security-ack
 * gate: a cached build result must never be handed to a caller that has not passed
 * the ack, and the no-build branch performs no build to memoize.
 */
async function buildDeclaredSkill(
  ref: BuildableReference,
  flags: BuildFlags,
  memo: BuildMemo,
  buildCommand: string | undefined,
): Promise<BuildDeclaredSkillResult> {
  // --dry-run DOES build once acknowledged: the "dry" part is the skill TESTING (no
  // Claude session, no tokens), and a preview assembled from a stale dist previews
  // something a real run would not test — which is the one job a preview has.
  //
  // Without the acknowledgement it still does NOT build. Building runs the repo's
  // committed `test.build` hook, an arbitrary shell command, so an unacknowledged
  // dry run stays the one mode that is safe to point at an untrusted clone. That
  // preview falls back to an existing dist and says so (stale warning) — the honest
  // trade, since accuracy requires consent to execute the repo's own build.
  if (flags.noBuild || (flags.dryRun && !flags.explicitAck)) {
    return resolveExistingDistOrThrow(ref, flags);
  }

  // SECURITY (§12): reaching here means a real build WOULD run — runPreStageBuild
  // executes an ARBITRARY shell command from the repo's committed `test.build`, and
  // packageSkill/runClaudePluginBuild run the repo's build. Enforce the ack BEFORE
  // any of that, so an untrusted clone never executes its build without the user's
  // explicit acknowledgment. (Defense-in-depth: the harness Step-6 check remains.)
  if (!flags.acknowledged) {
    throw new SecurityAckError();
  }

  const key = buildMemoKey(ref);
  // Memo HIT: this operation already ran in THIS process — skip the rebuild, but
  // still verify this ref's own dist (the hit may be a marketplace sibling's).
  if (memo.has(key)) return verifyBuiltDist(ref);

  // test.build hook (upstream artifacts) BEFORE the skill build -- ordering matters.
  runPreStageBuildOnce(buildCommand, ref.configRoot, memo);

  // ANY error thrown here is wrapped as `SkillBuildError` below, not just a narrowly-
  // scoped build-tool failure — see {@link isSurvivableCompanionFailure} for why that
  // matters to companion degradation. `err.stack` is also captured at construction,
  // so it keeps reflecting THIS un-prefixed message even after a caller mutates
  // `.message` in place (see {@link rethrowNamingCompanion}).
  try {
    await runDeclaredSkillBuild(ref);
  } catch (e) {
    throw new SkillBuildError(
      `Skill build failed for '${ref.name}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Record the operation as soon as the build COMMAND succeeded — before verifying
  // this ref's output. The build did run; a marketplace sibling must not re-run it
  // just because this skill's own dist turned out to be missing. Verification is
  // deliberately OUTSIDE the try/catch so its SkillBuildError is not re-wrapped into
  // a doubled "Skill build failed for 'x': Skill build for 'x' reported success…".
  memo.add(key);
  return verifyBuiltDist(ref);
}

/** Build a declared skill (or stage its existing dist under --no-build/--dry-run), then return the dist to stage. */
async function resolveBuildableSubject(
  ref: BuildableReference,
  flags: BuildFlags,
  memo: BuildMemo,
  buildCommand: string | undefined,
): Promise<ResolvedSubject> {
  const scaffoldDir = dirname(ref.sourcePath);
  const build = await buildDeclaredSkill(ref, flags, memo, buildCommand);
  return {
    subjectSource: { path: build.distDir },
    subjectScaffoldDir: scaffoldDir,
    rebuilt: build.rebuilt,
    wouldBuild: true,
    ...(build.dryRunStagedExistingDist === undefined
      ? {}
      : { dryRunStagedExistingDist: build.dryRunStagedExistingDist }),
  };
}

/**
 * May an OPTIONAL companion's failure be DEGRADED to "stage its raw source instead"
 * rather than failing the run? True for a genuine build failure ({@link SkillBuildError})
 * that could not have been DESTRUCTIVE. Both narrowings matter:
 *
 *   - **Error class.** Everything else reaching the catch is a user-fixable PREFLIGHT
 *     problem, not a degraded companion: a {@link SecurityAckError} (the fix is
 *     `--i-understand-this-runs-skill-code`, not "your companion didn't build"), a
 *     `ConfigLoadError` (a broken config reported as a build failure), or a
 *     `BuildHookError` (a genuinely misconfigured `test.build`). Swallowing those
 *     replaces the actionable message with a misleading one. Note that
 *     {@link buildDeclaredSkill} wraps ANY error `runDeclaredSkillBuild` throws —
 *     including a malformed packaging config or a stray `TypeError` deep inside
 *     `packageSkill` — into `SkillBuildError`, so "genuine build failure" here really
 *     means "anything the build call raised", not just a narrowly-scoped build error.
 *   - **Destructiveness.** A `plugin-local` build is DESTRUCTIVE once it reaches
 *     `runClaudePluginBuild`: that function `rm -rf`s the whole marketplace output
 *     tree BEFORE building, so a failure THERE may leave the user's
 *     `dist/.claude/plugins/marketplaces/<mp>/` already gone. Continuing would stage
 *     from an inconsistent dist and finish SUCCESS with the build output deleted — a
 *     test command must never destroy build output and report only a "Note:". A
 *     `pool` build writes only its own `expectedDistDir` and destroys nothing, so
 *     falling back to the raw source tree is always safe there. And under
 *     `--no-build`/`--dry-run`, `resolveExistingDistOrThrow` throws BEFORE
 *     `buildDeclaredSkill` reaches any build path at all — no build was attempted,
 *     plugin-local or not, so nothing was wiped either way and degrading is safe.
 *
 * A real (non `--no-build`/`--dry-run`) `plugin-local` failure stays fail-closed
 * because it MAY have failed mid-wipe; `runClaudePluginBuild` can also throw BEFORE
 * the `rm` (broken config, colliding plugin names), but those are indistinguishable
 * from outside once wrapped in `SkillBuildError`, so fail-closed is deliberate there.
 */
function isSurvivableCompanionFailure(
  err: unknown,
  declared: BuildableReference,
  optional: boolean,
  flags: BuildFlags,
): boolean {
  if (!optional || !(err instanceof SkillBuildError)) return false;
  return declared.distribution.kind === 'pool' || flags.noBuild;
}

/**
 * Rethrow a companion failure with the `--with`/`--with-optional` ALIAS the user
 * TYPED prefixed onto its message. Build errors name only the DECLARED skill, which
 * with several companions leaves the user unable to tell which flag to fix.
 *
 * The message is prefixed IN PLACE so the error's CLASS (and therefore its
 * `exitCode` / {@link mapErrorToExitCode} mapping) is unchanged — no new error class,
 * no re-wrapping. Prefixing is skipped when the message is ALREADY prefixed (starts
 * with `companion '`) — this makes the function idempotent against repeat rethrows of
 * the SAME error object, structurally, rather than relying on a hand-maintained
 * argument that no caught error class is ever cached/reused across companions.
 * {@link ConfigLoadError} instances ARE cached and re-thrown per config root by
 * `loadConfigCached`, so mutating one in place would otherwise corrupt the cache; the
 * already-prefixed check covers this case too (in practice `ConfigLoadError` is
 * thrown by the lookup ABOVE this try and never reaches here — belt-and-braces).
 *
 * NOTE: `err.stack` was captured at construction time and therefore still reflects
 * the UN-PREFIXED message — mutating `.message` afterward does not update `.stack`.
 * Debug output that prints `.stack` can disagree with the prefixed text on stderr.
 */
function rethrowNamingCompanion(err: unknown, alias: string, declaredName: string): never {
  if (err instanceof Error && !err.message.startsWith("companion '")) {
    err.message = `companion '${alias}' (declared skill '${declaredName}'): ${err.message}`;
  }
  throw err;
}

/**
 * Companion analog of {@link resolveBuildableSubject} (issue #158): resolve every
 * `--with`/`--with-optional` companion whose spec is a `{ path }` pointing at a
 * declared skill's SOURCE directory to that skill's BUILT dist, via the exact same
 * {@link buildDeclaredSkill} the subject uses. Anything else — workspace:/npm:/
 * url:/vendored specs, or a path outside this project's config — is "a different
 * story" (per the issue's own framing): left untouched, staged as today.
 *
 * The `test.build` hook used is the COMPANION's own — read from the config that
 * governs IT ({@link declaredSkillTestConfig}), not the subject's. The subject's hook
 * is a different skill's command in a (possibly) different package, and running it
 * here would execute it with the companion's config root as cwd.
 *
 * FAILURE HANDLING. A REQUIRED companion's failure ALWAYS propagates (the existing
 * "--with fails if a source cannot be resolved" contract, extended to "cannot be
 * built"), re-messaged to name the alias the user typed. An OPTIONAL companion
 * degrades to the ORIGINAL (unbuilt) path spec — with a mandatory stderr note — only
 * for the narrow, non-destructive case {@link isSurvivableCompanionFailure} allows;
 * every other failure propagates for it too. Staging's existing skip-with-warning
 * fallback still applies if the raw copy also fails to stage.
 *
 * DRY-RUN STALENESS: a `--dry-run` preview that staged an EXISTING
 * companion dist WITHOUT rebuilding it warns on stderr, naming the companion +
 * its declared skill, using {@link buildStaleDistWarningLines} — the SAME
 * warning-construction the subject's own dry-run summary uses (never a copied
 * string), so the identical fact ("this preview may be stale") warns for either
 * role instead of only the subject.
 */
export async function resolveCompanionSpec(
  name: string,
  spec: SkillSourceSpec,
  repoRoot: string,
  flags: BuildFlags,
  optional: boolean,
  memo: BuildMemo,
): Promise<SkillSourceSpec> {
  if (!('path' in spec)) return spec;
  const declared = await findDeclaredSkillForSourceDir(spec.path, repoRoot);
  if (declared === undefined) return spec;
  try {
    const build = await buildDeclaredSkill(declared, flags, memo, declaredSkillTestConfig(declared)?.build);
    if (build.dryRunStagedExistingDist === true) {
      process.stderr.write(
        buildStaleDistWarningLines(`companion '${name}' (declared skill '${declared.name}')`).join('\n') + '\n',
      );
    }
    return { path: build.distDir };
  } catch (e) {
    if (!isSurvivableCompanionFailure(e, declared, optional, flags))
      rethrowNamingCompanion(e, name, declared.name);
    process.stderr.write(
      `Note: companion '${name}' (declared skill '${declared.name}') failed to build; staging its raw source instead: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return spec;
  }
}

/** Resolve every entry of a `--with`/`--with-optional` companion record (see {@link resolveCompanionSpec}). */
export async function resolveCompanionSources(
  sources: Record<string, SkillSourceSpec> | undefined,
  repoRoot: string,
  flags: BuildFlags,
  optional: boolean,
  memo: BuildMemo,
): Promise<Record<string, SkillSourceSpec> | undefined> {
  if (sources === undefined) return undefined;
  const resolved: Record<string, SkillSourceSpec> = {};
  for (const [name, spec] of Object.entries(sources)) {
    resolved[name] = await resolveCompanionSpec(name, spec, repoRoot, flags, optional, memo);
  }
  return resolved;
}

/**
 * True when the resolved subject is a CONFIG-BLIND path target: a `{ path }` source
 * staged AS-IS (not built) that does NOT map back to a declared skill, so the project's
 * `test:` config cannot be applied to it. A path that DOES map to a declared skill
 * (`linkedToDeclaredSkill`) honors config and is NOT blind. A config-declared NAME
 * target (`wouldBuild`) is never blind. Gates the #7 warning. Pure + exported for tests.
 */
export function isPathSourceTarget(subject: {
  wouldBuild: boolean;
  subjectSource: SkillSourceSpec;
  linkedToDeclaredSkill?: boolean;
}): boolean {
  return !subject.wouldBuild && 'path' in subject.subjectSource && subject.linkedToDeclaredSkill !== true;
}

/**
 * Warn (stderr) when the subject is a CONFIG-BLIND path target: its `test:` config
 * (model / evals / timeout) cannot be resolved because the path maps to no declared
 * skill. A path pointing at a declared skill's built dist DOES honor config (mapped
 * back by {@link findDeclaredSkillForPath}) and is silent — only a truly unmapped
 * path is warned, pointing the user at the NAME form.
 */
function warnIfPathTargetBypassesConfig(subject: ResolvedSubject): void {
  if (!isPathSourceTarget(subject)) return;
  process.stderr.write(
    'Note: this path maps to no declared skill, so the project\'s test: config ' +
      '(model/evals/timeout) is not applied. Pass the skill NAME (or point at the skill\'s ' +
      'built dist directory) to honor it.\n',
  );
}

// ---------------------------------------------------------------------------
// Testable action
// ---------------------------------------------------------------------------

/**
 * Validate usage-level flags (auth values, numeric knobs) and load the subject's
 * persisted test config. Runs before the async harness work, so a bad flag exits
 * with a clean message + preflight code (2) instead of surfacing as an unhandled
 * promise rejection (raw stack trace, exit 1).
 */
async function preflightKnobsAndConfig(
  subject: string,
  options: SkillTestRunOptions,
  cwd: string,
): Promise<{
  knobs: ReturnType<typeof coerceKnobs>;
  config: TestConfig | undefined;
  globalTest: SkillTestGlobalConfig;
}> {
  try {
    assertValidAuth(options.auth);
    assertValidRequireAuth(options.requireAuth);
    return {
      knobs: coerceKnobs(options),
      config: await loadTestConfig(subject, cwd),
      globalTest: loadGlobalTestConfig(cwd),
    };
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(SkillTestExitCode.Preflight);
  }
}

/**
 * Exit code for an error escaping EITHER phase of {@link runSkillTestRun}.
 *
 * A broken governing config ({@link ConfigLoadError}) is a user-fixable PREFLIGHT
 * problem (exit 2), not an internal harness failure — {@link mapErrorToExitCode} has
 * no case for it and falls through to Internal (1). ONE helper shared by BOTH catch
 * blocks so the SUBJECT arm and the COMPANION arm can never drift: a companion's
 * governing config root can differ from the subject's, so a broken config is
 * reachable from either arm and must report the same code from both.
 */
function exitCodeForRunError(err: unknown): number {
  return err instanceof ConfigLoadError ? SkillTestExitCode.Preflight : mapErrorToExitCode(err);
}

/**
 * Copy the resolved-subject fields onto the harness options. Optional fields are
 * only assigned when present (exactOptionalPropertyTypes). Extracted so
 * {@link runSkillTestRun} stays within its cognitive-complexity budget.
 */
function applyResolvedSubject(harnessOpts: HarnessOpts, subject: ResolvedSubject): void {
  harnessOpts.subjectSource = subject.subjectSource;
  harnessOpts.rebuilt = subject.rebuilt;
  harnessOpts.wouldBuild = subject.wouldBuild;
  if (subject.subjectScaffoldDir !== undefined) {
    harnessOpts.subjectScaffoldDir = subject.subjectScaffoldDir;
  }
  if (subject.dryRunStagedExistingDist !== undefined) {
    harnessOpts.dryRunStagedExistingDist = subject.dryRunStagedExistingDist;
  }
  if (subject.declaredExecutables !== undefined) {
    harnessOpts.declaredExecutables = subject.declaredExecutables;
  }
}

/**
 * The unit-testable action for `vat skill test run`. Exported so tests can
 * call it directly without parsing CLI args. Calls process.exit on completion.
 *
 * Security ack enforcement happens in TWO places that share the isAcknowledged
 * predicate: (1) here, BEFORE resolveSubjectForTest builds a declared subject —
 * so an untrusted clone never runs its `test.build`/packageSkill without the ack;
 * (2) inside runSkillTestHarness (Step 6) as defense-in-depth before spawning.
 */
export async function runSkillTestRun(
  subject: string,
  options: SkillTestRunOptions,
): Promise<void> {
  printSecurityWarning();

  const { knobs, config, globalTest } = await preflightKnobsAndConfig(subject, options, process.cwd());

  // Commander stores the `--no-build` negatable flag under `build` (=== false when set);
  // honor an explicit programmatic `noBuild` too.
  const noBuild = options.noBuild === true || (options as { build?: boolean }).build === false;
  // Reuse the harness's ack predicate so the pre-build gate and the harness
  // Step-6 gate share one definition of "acknowledged" (a dry-run counts).
  const acknowledged = isAcknowledged({
    dryRun: options.dryRun === true,
    acknowledgedRunsSkillCode: options.iUnderstandThisRunsSkillCode === true,
  });
  // Shared by subject AND companion resolution (issue #158) so a --with/--with-optional
  // companion that maps to a declared skill gets the exact same build GATING (no-build/
  // dry-run/security-ack) as the subject. The `test.build` hook is deliberately NOT in
  // here: it is per-skill (see BuildFlags), so the subject's own command is passed only
  // to subject resolution and each companion resolves its own.
  const buildFlags: BuildFlags = {
    noBuild,
    dryRun: options.dryRun === true,
    acknowledged,
    explicitAck: options.iUnderstandThisRunsSkillCode === true,
  };
  // ONE memo for the whole run, shared by subject AND companion resolution: a skill
  // that is both the subject and a companion builds exactly once, and N companions
  // in one marketplace trigger ONE marketplace build, not N.
  const buildMemo: BuildMemo = new Set();
  let resolvedSubject: ResolvedSubject;
  try {
    resolvedSubject = await resolveSubjectForTest(subject, process.cwd(), buildFlags, buildMemo, config?.build);
  } catch (err) {
    // A broken governing config surfacing during subject resolution is a preflight
    // problem the user must fix (exit 2), not an internal harness failure (exit 1).
    const exitCode = exitCodeForRunError(err);
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(exitCode);
    return;
  }

  warnIfPathTargetBypassesConfig(resolvedSubject);

  try {
    // buildHarnessOpts assembles the companion records (--with/--with-optional and
    // config with:/optional:) and can throw DuplicateStagedSkillError on a repeated
    // name — inside the try so it maps to exit 2 like every other preflight error.
    const harnessOpts = buildHarnessOpts(subject, options, knobs, config, globalTest);
    applyResolvedSubject(harnessOpts, resolvedSubject);
    // Companion build resolution (issue #158): a --with/--with-optional companion
    // whose source is a path into a declared skill gets built (its `files:`
    // injection runs) exactly like the subject, instead of a raw source-tree copy.
    const repoRoot = resolveRepoRoot();
    const withSources = await resolveCompanionSources(harnessOpts.withSources, repoRoot, buildFlags, false, buildMemo);
    if (withSources !== undefined) harnessOpts.withSources = withSources;
    const withOptional = await resolveCompanionSources(harnessOpts.withOptional, repoRoot, buildFlags, true, buildMemo);
    if (withOptional !== undefined) harnessOpts.withOptional = withOptional;
    const result = await runSkillTestHarness(harnessOpts);

    process.stderr.write(`Harness: ${result.harnessPath}\n`);
    // The artifacts this command's help text tells the operator to read
    // (grading.json / friction.json / baseline.json). Reported separately from the
    // harness path because on a default run — no --out, no --workdir, no --keep —
    // results/ is the ONLY thing left under it: everything else is staged untrusted
    // bytes that cleanup evicts. Pointing at the harness root alone made the
    // operator guess which of its children still existed.
    if (result.resultsPath !== undefined) {
      process.stderr.write(`Results: ${result.resultsPath}\n`);
    }
    // The executor's working directories live OUTSIDE the harness root under an
    // unguessable token, so the harness path no longer leads an operator to them.
    // Under --keep they survive holding everything the evals produced; unreported,
    // they would be an orphan the operator cannot find to inspect or reap. On every
    // other run cleanup deletes them, and the harness answers with no
    // `workspacesPath` at all — the retention rule has ONE author, over there, so
    // this stays a plain presence check and never a second copy of it.
    if (result.workspacesPath !== undefined) {
      process.stderr.write(`Workspaces: ${result.workspacesPath}\n`);
    }
    process.stdout.write(`Summary: ${result.summary}\n`);
    process.exit(result.exitCode);
    return;
  } catch (err) {
    // Same rule as the subject arm above (see {@link exitCodeForRunError}): companion
    // resolution can surface a ConfigLoadError from a DIFFERENT config root than the
    // subject's, and that must exit 2 (preflight), not 1 (internal).
    const exitCode = exitCodeForRunError(err);
    // BootstrapNeededError (exit 3) is the happy "wrote a template, fill it in
    // and re-run" path — surface its message plainly, not as a hard `Error:`.
    if (err instanceof BootstrapNeededError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exit(exitCode);
    return;
  }
}

// ---------------------------------------------------------------------------
// Commander command builder
// ---------------------------------------------------------------------------

export function createSkillTestRunCommand(): Command {
  const command = new Command('run');

  command
    .description('Execute a packaged skill\'s eval suite in a headless, context-isolated Claude session (runs the skill\'s code; not an OS sandbox)')
    .argument('<skill>', 'The skill to test')
    .option(
      '--with <pair...>',
      'Stage a REQUIRED companion skill the subject can invoke, as name=<src> (repeatable). <src> is workspace:<pkg> | npm:<spec> | url:<u> | path:<dir> | vendored (e.g. helper=npm:@scope/s@1.2.3). A path:<dir> that maps to a declared skill is BUILT like the subject (files: build artifacts included), not tree-copied as raw source. The run fails if a source cannot be resolved or its build fails.',
    )
    .option(
      '--with-optional <pair...>',
      'Stage an OPTIONAL companion skill, as name=<src> (same syntax, repeatable). Staged from its raw (unbuilt) source with a warning if its source cannot be resolved, or if a non-destructive build fails; the run continues.',
    )
    .option(
      '--env <pair...>',
      'Inject an env var into the executor spawn as KEY=VALUE (repeatable). Values support ${fixturesDir}, ${stagedSkillDir}, ${harnessRoot}, ${resultsDir}. ${fixturesDir} is per-eval and requires that eval to declare input `files`. CLI overrides config for the same key.',
    )
    .option(
      '--pass-env <key...>',
      'Forward a host env var by NAME to the executor spawn if present (repeatable). Protected names (PATH, auth, model) are ignored.',
    )
    .option('--refresh', 'Force a full re-stage (ignore existing staged content)')
    .option('--no-build', 'Skip building declared skills (subject and any --with/--with-optional companion); stage existing dist instead. Errors if absent for the subject or a REQUIRED companion; an OPTIONAL companion falls back to raw source with a warning.')
    .option('--workdir <dir>', 'Override the harness working directory')
    .option('--out <dir>', 'Override the harness output directory')
    .option('--keep', 'Keep the harness directory after the run')
    .option('--dry-run', 'Build and stage exactly as a real run would, then stop without spawning Claude (no tokens spent). Combine with --no-build to skip the build too.')
    .option('--auth <mode>', 'Auth mechanism: inherit | subscription | api-key | auto')
    .option('--require-auth <mech>', 'Require a specific auth mechanism: subscription | api-key')
    // `--baseline` MUST be declared before `--no-baseline`: Commander only leaves the
    // value undefined-when-untyped if a positive option already exists, and that
    // tri-state is what lets a flag beat config in BOTH directions (see resolveBaseline).
    .option(
      '--baseline',
      "A/B the skill's INSTRUCTIONS (declared vs withheld) and report the lift on stderr. Runs every eval TWICE, so it roughly DOUBLES the spawns and the spend (--max-budget-usd is per-spawn). Both arms share a filesystem — not a capability control; see baselineDelta and baselineIntegrity in baseline.json",
    )
    .option(
      '--no-baseline',
      'Force the baseline A/B OFF for this run, overriding a committed `test.baseline: true` in the project config (which is announced on stderr when it applies).',
    )
    .option(
      '--allow-eval-failure',
      'Opt out of the fail-closed default: exit 0 even when an eval fails (for interactive use). By DEFAULT a failing eval exits 4, distinct from the harness-broke codes (1/2/3) so CI can gate on it.',
    )
    .option('--allow-unverified-skill-source', 'Skip the vendored manifest integrity check')
    .option('--i-understand-this-runs-skill-code', 'Acknowledge this command executes skill code (required)')
    .option(
      '--model <id>',
      "Model ID passed VERBATIM to `claude --model <id>` for the model UNDER TEST (the executor). VAT does no mapping/validation (e.g. opus, sonnet, claude-opus-4-8). Omit to use claude's own default model. Independent of --grader-model.",
    )
    .option(
      '--grader-model <id>',
      'Model for the fixed grader/judge, passed VERBATIM to `claude --model` (default claude-sonnet-5). GLOBAL (top-level `test:` config), independent of --model (the model UNDER TEST).',
    )
    .option(
      '--evals <path>',
      "Eval suite to grade against: a path to an evals.json (resolved against the CURRENT DIRECTORY, so it may point outside the skill's tree) or an npm bare specifier honoring that package's exports map. Overrides `test.evals`, which is resolved against the skill source instead. Use this to test a skill you did not author — a correctly packaged skill ships no evals, because the suite is the answer key.",
    )
    .option('--max-turns <n>', 'Per-spawn cap on executor/grader turns (positive integer)')
    .option('--max-budget-usd <n>', 'Hard USD budget cap (positive number)')
    .option('--timeout <s>', 'Wall-clock timeout in seconds (positive integer)')
    .option('--stall <s>', 'Stall-watchdog in seconds (positive integer)')
    .option('--concurrency <n>', 'Max evals graded in parallel (positive integer; default 4)')
    .option('--debug', 'Enable debug logging')
    .action(runSkillTestRun)
    .addHelpText(
      'after',
      `
Description:
  Stages the named subject skill (plus any --with/--with-optional companion
  skills) into a fresh temp harness (context isolation: a scrubbed env
  allowlist and no user/project settings -- NOT an OS security sandbox), runs
  preflight checks (claude binary, auth, eval inputs, budget),
  then runs a vat-owned executor->grader pipeline: per eval, a blind executor
  Claude session performs the task and a separate grader session judges its
  transcript against the skill's expectations. VAT merges the grader results and
  writes grading.json.

  IMPORTANT: This command EXECUTES the skill's code with your user account's
  full privileges (filesystem, network, shell) and a reachable auth credential.
  Only run skills you trust. You MUST pass --i-understand-this-runs-skill-code
  to acknowledge this and proceed.

Artifacts:
  grading.json (the verdict), friction.json, tool-eval.json, and -- with
  --baseline -- baseline.json are written to a results/ directory whose path is
  echoed to stderr ("Results: <path>"). On a DEFAULT run (no --out, --workdir or
  --keep) that directory SURVIVES and the staged skill bytes around it are
  removed. Cleanup only ever touches a harness dir vat created, so with --out or
  --workdir NOTHING is removed and the staged (untrusted) skill bytes stay until
  you delete them yourself -- --keep or not.

  A --baseline run also echoes its lift to stderr ("Baseline delta: +2 (with
  skill: 3/3, without skill: 1/3)."), and stamps the same numbers into
  baseline.json as baselineDelta, run-level and per eval. A delta of 0 means the
  skill lifted nothing; a delta of null means the two arms were graded against a
  different number of expectations and cannot be subtracted at all -- see
  baselineIntegrity.skew for which evals, and prefer null over a number that
  would read as "100% without the skill".

Model:
  --model <id> selects the model UNDER TEST (the executor spawn): passed
  straight through as \`claude --model <id>\` (verbatim -- VAT does not map or
  validate it). With no --model, no flag is passed and claude picks its own
  default. The selected model is echoed to stderr ("Model: <id>") on every run,
  and the --dry-run output shows the model flag that would be passed (not the
  full argv — budget, turns, and permission flags are added at spawn time).

  --grader-model <id> is INDEPENDENT of --model: it selects the fixed judge
  that grades every eval's transcript (default claude-sonnet-5), so grading
  stays comparable across runs even as the model under test changes. This is a
  GLOBAL setting (top-level \`test:\` config node), not per-skill. Precedence:
  --grader-model flag > top-level config \`test.graderModel\` > built-in default.
  --concurrency follows the same GLOBAL precedence for the executor->grader
  pipeline width (default 4).

Exit Codes:
  0 - Harness ran to completion and every eval passed (or --allow-eval-failure suppressed a failing verdict)
  1 - Internal error (grader fragment absent/invalid, summary/expectations skew, executor/grader crash, stall/timeout)
  2 - Preflight failed (missing binary, auth error, eval inputs absent, unsafe workdir, ack missing, broken project config, a required skill -- subject or --with companion -- failed to build, --no-build with no existing dist for one of them, or an OPTIONAL --with-optional companion hitting a non-survivable failure: a destructive plugin-local build failure, missing security ack, or broken config)
  3 - Bootstrap needed: evals.json was absent, so VAT wrote a starter template next to the skill source. Fill it in and re-run.
  4 - An eval FAILED (the harness completed and produced a valid grading.json; expectations did not all pass). This is the fail-closed DEFAULT -- suppress with --allow-eval-failure.

  The taxonomy is designed so a CI consumer can tolerate eval failures while
  failing closed on every other (harness-broke) outcome:

    vat skill test run my-skill --i-understand-this-runs-skill-code
    case $? in
      0) ;;              # all evals passed
      4) ;;              # evals failed but the harness is healthy -- tolerate/warn
      *) exit 1 ;;       # 1/2/3/unknown -- harness broke, fail the build
    esac

  Which specific evals failed lives in grading.json, never in the exit code.
  For interactive iteration, --allow-eval-failure downgrades 4 to 0.

Example:
  $ vat skill test run my-skill --i-understand-this-runs-skill-code
`,
    );

  return command;
}
