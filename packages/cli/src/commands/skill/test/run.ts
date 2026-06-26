/**
 * `vat skill test run <skill...>` — execute a packaged skill's eval suite in isolation.
 *
 * Thin orchestration layer: parse flags, resolve precedence (flag > config > default),
 * print the §12 security warning, call runSkillTestHarness, map result/error to exit code.
 * All domain logic lives in run-harness.ts (agent-skills package).
 */

import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import {
  BootstrapNeededError,
  isAcknowledged,
  mapErrorToExitCode,
  packageSkill,
  packagingConfigToPackageOptions,
  runPreStageBuild,
  runSkillTestHarness,
  SecurityAckError,
  SkillBuildError,
} from '@vibe-agent-toolkit/agent-skills';
import type { SkillSourceDescriptor, TestConfig } from '@vibe-agent-toolkit/resources';
import { findProjectRoot, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { parseSourceSpec } from '../../../skill-resolution/classify.js';
import { resolveSkillReference, type BuildableReference } from '../../../skill-resolution/index.js';
import { loadConfig } from '../../../utils/config-loader.js';
import { runClaudePluginBuild } from '../../claude/plugin/build.js';

/** Extract the trailing path segment (cross-platform) from a path-like string. */
function lastPathSegment(p: string): string {
  return basename(toForwardSlash(p));
}

// ---------------------------------------------------------------------------
// Security warning (§12)
// ---------------------------------------------------------------------------

const SECURITY_WARNING = `
WARNING: 'vat skill test run' EXECUTES the skill's code on your machine.

It spawns a headless Claude session with --permission-mode bypassPermissions,
so the staged skill files and experimenter prompt run with YOUR user account's
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
  baseline?: boolean;
  allowUnverifiedSkillSource?: boolean;
  iUnderstandThisRunsSkillCode?: boolean;
  model?: string;
  maxTurns?: string;
  maxBudgetUsd?: string;
  timeout?: string;
  stall?: string;
  debug?: boolean;
  env?: string[];
  passEnv?: string[];
  /** Skip building a declared subject and stage its existing dist instead. */
  noBuild?: boolean;
  /** Exit non-zero (EvalFailure) when any eval fails, instead of the default Ok. */
  failOnEvalFailure?: boolean;
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
} {
  const result: {
    maxTurns?: number;
    maxBudgetUsd?: number;
    timeout?: number;
    stall?: number;
  } = {};

  const maxTurns = coercePositiveInt(options.maxTurns, '--max-turns');
  if (maxTurns !== undefined) result.maxTurns = maxTurns;

  const maxBudgetUsd = coercePositiveFloat(options.maxBudgetUsd, '--max-budget-usd');
  if (maxBudgetUsd !== undefined) result.maxBudgetUsd = maxBudgetUsd;

  const timeout = coercePositiveInt(options.timeout, '--timeout');
  if (timeout !== undefined) result.timeout = timeout;

  const stall = coercePositiveInt(options.stall, '--stall');
  if (stall !== undefined) result.stall = stall;

  return result;
}

// ---------------------------------------------------------------------------
// --with / --with-optional parsing (I2)
// ---------------------------------------------------------------------------

type HarnessOpts = Parameters<typeof runSkillTestHarness>[0];
type SkillSourceSpec = NonNullable<HarnessOpts['withSources']>[string];

/**
 * Parse a single `name=src` pair into a [name, SkillSourceSpec] tuple. The
 * source half uses a `kind:value` prefix:
 *   workspace:foo · npm:@scope/s@1.2.3 · url:https://… · path:../baz · vendored
 * A bare value without `name=` is rejected — every injected dep needs a name so
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
function parseWithFlags(pairs: string[] | undefined): Record<string, SkillSourceSpec> | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined;
  const record: Record<string, SkillSourceSpec> = {};
  for (const pair of pairs) {
    const [name, spec] = parseWithPair(pair);
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
function descriptorsToRecord(
  list: SkillSourceDescriptor[] | undefined,
): Record<string, SkillSourceSpec> | undefined {
  if (list === undefined || list.length === 0) return undefined;
  const record: Record<string, SkillSourceSpec> = {};
  for (const d of list) record[descriptorName(d)] = d;
  return record;
}

// ---------------------------------------------------------------------------
// Precedence resolution: flag > config > default
// ---------------------------------------------------------------------------

/**
 * Load the persisted `skills.config.<skill>.test` block for the subject skill.
 * The subject is the first positional skill name (a path or skill key). We key
 * the config by its basename so `./dist/skills/my-skill/` matches `my-skill`.
 * Missing config / missing file → undefined (defaults apply).
 */
function loadTestConfig(skills: string[]): TestConfig | undefined {
  const projectRoot = findProjectRoot(process.cwd());
  if (projectRoot === null) return undefined;
  let config;
  try {
    config = loadConfig(projectRoot);
  } catch {
    return undefined; // tolerate a broken/absent config → defaults
  }
  const perSkill = config?.skills?.config;
  if (perSkill === undefined) return undefined;
  const subject = skills[0] ?? '';
  const base = lastPathSegment(subject) || subject;
  return perSkill[subject]?.test ?? perSkill[base]?.test;
}

/** Resolve the project root used as the harness repoRoot anchor. */
function resolveRepoRoot(): string {
  return findProjectRoot(process.cwd()) ?? process.cwd();
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
  if (options.failOnEvalFailure !== undefined) opts.failOnEvalFailure = options.failOnEvalFailure;
}

/** Apply flag>config merges for scalar knobs (auth, model, baseline, eval/prompt). */
function applyScalarMerges(opts: HarnessOpts, options: SkillTestRunOptions, config: TestConfig | undefined): void {
  const authMode = options.auth ?? config?.auth;
  if (authMode !== undefined) opts.auth = authMode as 'inherit' | 'subscription' | 'api-key' | 'auto';
  const authRequirement = options.requireAuth ?? config?.requireAuth;
  if (authRequirement !== undefined) opts.requireAuth = authRequirement as 'subscription' | 'api-key';
  const baseline = options.baseline ?? config?.baseline;
  if (baseline !== undefined) opts.baseline = baseline;
  const model = options.model ?? config?.model;
  if (model !== undefined) opts.model = model;
  if (config?.evals !== undefined) opts.evalsSubpath = config.evals;
  if (config?.experimenterPrompt !== undefined) opts.promptOverride = config.experimenterPrompt;
}

/** Apply flag>config merges for numeric knobs (turns/budget/timeout/stall). */
function applyKnobMerges(
  opts: HarnessOpts,
  knobs: ReturnType<typeof coerceKnobs>,
  config: TestConfig | undefined,
): void {
  const maxTurns = knobs.maxTurns ?? config?.maxTurns;
  if (maxTurns !== undefined) opts.maxTurns = maxTurns;
  const maxBudgetUsd = knobs.maxBudgetUsd ?? config?.maxBudgetUsd;
  if (maxBudgetUsd !== undefined) opts.maxBudgetUsd = maxBudgetUsd;
  const timeout = knobs.timeout ?? config?.timeout;
  if (timeout !== undefined) opts.timeout = timeout;
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

/** Apply flag>config merges for injected-dependency records. */
function applyDepMerges(opts: HarnessOpts, options: SkillTestRunOptions, config: TestConfig | undefined): void {
  const withSources = parseWithFlags(options.with) ?? descriptorsToRecord(config?.with);
  if (withSources !== undefined) opts.withSources = withSources;
  const withOptional = parseWithFlags(options.withOptional) ?? descriptorsToRecord(config?.optional);
  if (withOptional !== undefined) opts.withOptional = withOptional;
}

/**
 * Resolve CLI flags → RunHarnessOptions, applying flag > config > default
 * precedence. CLI flags win; config (`skills.config.<skill>.test`) fills gaps;
 * built-in defaults (inside the domain) are the final fallback.
 */
function buildHarnessOpts(
  skills: string[],
  options: SkillTestRunOptions,
  knobs: ReturnType<typeof coerceKnobs>,
  config: TestConfig | undefined,
): HarnessOpts {
  const repoRoot = resolveRepoRoot();
  const opts: HarnessOpts = { skills, repoRoot };
  applyFlagOnlyOptions(opts, options);
  applyScalarMerges(opts, options, config);
  applyKnobMerges(opts, knobs, config);
  applyDepMerges(opts, options, config);
  applyEnvMerges(opts, options, config);
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
}

/**
 * Project-aware subject resolution for `vat skill test run`. Resolves the subject
 * reference; for a declared skill, builds it (real entry points) and returns the
 * dist dir to stage; everything else is staged as-is. Throws SkillBuildError
 * (exit 2) for name-miss / not-found / --no-build-without-dist / build failure.
 */
export async function resolveSubjectForTest(
  ref: string,
  cwd: string,
  flags: { noBuild: boolean; dryRun: boolean; acknowledged: boolean; build?: string },
): Promise<ResolvedSubject> {
  const resolved = await resolveSkillReference(ref, cwd);
  switch (resolved.kind) {
    case 'source':
      return {
        subjectSource: resolved.source,
        rebuilt: false,
        wouldBuild: false,
        // A path subject points at the skill DIR itself (not its SKILL.md), so the
        // authored scaffold dir is the resolved path — not its parent. Mirrors the
        // legacy positional-path behavior in resolveScaffoldEvalsPath.
        ...('path' in resolved.source
          ? { subjectScaffoldDir: safePath.resolve(cwd, resolved.source.path) }
          : {}),
      };
    case 'name-miss':
      throw new SkillBuildError(
        `no skill named '${resolved.name}' in ${resolved.configRoot}; known skills: ${resolved.knownSkills.join(', ') || '(none)'}. (For a directory, use './${resolved.name}'.)`,
      );
    case 'not-found':
      throw new SkillBuildError(
        `no path '${resolved.ref}' and no governing config to resolve a name; pass a path or run inside a VAT project.`,
      );
    case 'buildable':
      return resolveBuildableSubject(resolved, flags);
  }
}

/**
 * Resolve a buildable subject under --no-build or --dry-run (no build step). Stage
 * the existing dist if present; for a dry-run with no dist yet, fall back to the
 * source dir so the preview still assembles without triggering a build. Throws when
 * --no-build is set but no dist exists.
 */
function resolveNoBuildDryRunBranch(
  ref: BuildableReference,
  scaffoldDir: string,
  flags: { noBuild: boolean; dryRun: boolean },
): ResolvedSubject {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- expectedDistDir derived from project config
  if (existsSync(ref.expectedDistDir)) {
    if (flags.noBuild) {
      process.stderr.write(`Using existing dist (NOT rebuilt): ${ref.expectedDistDir}\n`);
    }
    return {
      subjectSource: { path: ref.expectedDistDir },
      subjectScaffoldDir: scaffoldDir,
      rebuilt: false,
      wouldBuild: true,
      // For a dry-run that staged an existing (unbuilt) dist, flag it as
      // potentially stale so the summary can warn the user.
      ...(flags.dryRun ? { dryRunStagedExistingDist: true } : {}),
    };
  }
  if (flags.dryRun) {
    return {
      subjectSource: { path: scaffoldDir },
      subjectScaffoldDir: scaffoldDir,
      rebuilt: false,
      wouldBuild: true,
      dryRunStagedExistingDist: false,
    };
  }
  throw new SkillBuildError(
    `--no-build: no built dist at ${ref.expectedDistDir}. Run \`vat build\` first, or point at a built path.`,
  );
}

/** Build a declared skill (or stage its existing dist under --no-build/--dry-run), then return the dist to stage. */
async function resolveBuildableSubject(
  ref: BuildableReference,
  flags: { noBuild: boolean; dryRun: boolean; acknowledged: boolean; build?: string },
): Promise<ResolvedSubject> {
  const scaffoldDir = dirname(ref.sourcePath);

  // --no-build and --dry-run never build — delegate to the dedicated branch helper.
  if (flags.noBuild || flags.dryRun) {
    return resolveNoBuildDryRunBranch(ref, scaffoldDir, flags);
  }

  // SECURITY (§12): reaching here means a real build WOULD run — runPreStageBuild
  // executes an ARBITRARY shell command from the repo's committed `test.build`, and
  // packageSkill/runClaudePluginBuild run the repo's build. Enforce the ack BEFORE
  // any of that, so an untrusted clone never executes its build without the user's
  // explicit acknowledgment. (Defense-in-depth: the harness Step-6 check remains.)
  if (!flags.acknowledged) {
    throw new SecurityAckError();
  }

  // test.build hook (upstream artifacts) BEFORE the skill build -- ordering matters.
  if (flags.build !== undefined) {
    runPreStageBuild({ buildCommand: flags.build, configRoot: ref.configRoot });
  }

  try {
    if (ref.distribution.kind === 'pool') {
      await packageSkill(
        ref.sourcePath,
        packagingConfigToPackageOptions(ref.packagingConfig, {
          skillPath: ref.sourcePath,
          outputPath: ref.expectedDistDir,
        }),
      );
    } else {
      await runClaudePluginBuild(ref.configRoot, { marketplace: ref.distribution.marketplaceName });
    }
  } catch (e) {
    throw new SkillBuildError(
      `Skill build failed for '${ref.name}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { subjectSource: { path: ref.expectedDistDir }, subjectScaffoldDir: scaffoldDir, rebuilt: true, wouldBuild: true };
}

// ---------------------------------------------------------------------------
// Testable action
// ---------------------------------------------------------------------------

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
  skills: string[],
  options: SkillTestRunOptions,
): Promise<void> {
  printSecurityWarning();

  const knobs = coerceKnobs(options);
  const config = loadTestConfig(skills);

  // Commander stores the `--no-build` negatable flag under `build` (=== false when set);
  // honor an explicit programmatic `noBuild` too.
  const noBuild = options.noBuild === true || (options as { build?: boolean }).build === false;
  // Reuse the harness's ack predicate so the pre-build gate and the harness
  // Step-6 gate share one definition of "acknowledged" (a dry-run counts).
  const acknowledged = isAcknowledged({
    dryRun: options.dryRun === true,
    acknowledgedRunsSkillCode: options.iUnderstandThisRunsSkillCode === true,
  });
  let subject: ResolvedSubject;
  try {
    subject = await resolveSubjectForTest(skills[0] ?? '', process.cwd(), {
      noBuild,
      dryRun: options.dryRun === true,
      acknowledged,
      ...(config?.build === undefined ? {} : { build: config.build }),
    });
  } catch (err) {
    const exitCode = mapErrorToExitCode(err);
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(exitCode);
    return;
  }

  const harnessOpts = buildHarnessOpts(skills, options, knobs, config);
  harnessOpts.subjectSource = subject.subjectSource;
  harnessOpts.rebuilt = subject.rebuilt;
  harnessOpts.wouldBuild = subject.wouldBuild;
  if (subject.subjectScaffoldDir !== undefined) {
    harnessOpts.subjectScaffoldDir = subject.subjectScaffoldDir;
  }
  if (subject.dryRunStagedExistingDist !== undefined) {
    harnessOpts.dryRunStagedExistingDist = subject.dryRunStagedExistingDist;
  }

  try {
    const result = await runSkillTestHarness(harnessOpts);

    process.stderr.write(`Harness: ${result.harnessPath}\n`);
    process.stdout.write(`Summary: ${result.summary}\n`);
    process.exit(result.exitCode);
    return;
  } catch (err) {
    const exitCode = mapErrorToExitCode(err);
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
    .argument('<skill...>', 'Skill name(s) to test (primary subject set)')
    .option(
      '--with <pair...>',
      'Inject a declared-dependency skill as name=<src>, where <src> is workspace:<pkg> | npm:<spec> | url:<u> | path:<dir> | vendored (e.g. mydep=npm:@scope/s@1.2.3)',
    )
    .option(
      '--with-optional <pair...>',
      'Inject an optional skill as name=<src> (same syntax as --with)',
    )
    .option(
      '--env <pair...>',
      'Inject an env var into the experimenter spawn as KEY=VALUE (repeatable). Values support ${fixturesDir}, ${stagedSkillDir}, ${harnessRoot}, ${resultsDir}. CLI overrides config for the same key.',
    )
    .option(
      '--pass-env <key...>',
      'Forward a host env var by NAME to the experimenter spawn if present (repeatable). Protected names (PATH, auth, model) are ignored.',
    )
    .option('--refresh', 'Force a full re-stage (ignore existing staged content)')
    .option('--no-build', 'Skip building a declared skill; stage its existing dist instead (errors if absent)')
    .option('--workdir <dir>', 'Override the harness working directory')
    .option('--out <dir>', 'Override the harness output directory')
    .option('--keep', 'Keep the harness directory after the run')
    .option('--dry-run', 'Assemble the command without spawning Claude')
    .option('--auth <mode>', 'Auth mechanism: inherit | subscription | api-key | auto')
    .option('--require-auth <mech>', 'Require a specific auth mechanism: subscription | api-key')
    .option('--baseline', 'Enable A/B baseline run (with/without skill)')
    .option(
      '--fail-on-eval-failure',
      'Exit non-zero when any eval fails (default: the run exits 0 if the harness completed and produced grading.json; eval pass/fail is in the summary).',
    )
    .option('--allow-unverified-skill-source', 'Skip the vendored manifest integrity check')
    .option('--i-understand-this-runs-skill-code', 'Acknowledge this command executes skill code (required)')
    .option(
      '--model <id>',
      "Model ID passed VERBATIM to `claude --model <id>` (VAT does no mapping/validation; e.g. opus, sonnet, claude-opus-4-8). Omit to use claude's own default model.",
    )
    .option('--max-turns <n>', 'Cap on experimenter turns (positive integer)')
    .option('--max-budget-usd <n>', 'Hard USD budget cap (positive number)')
    .option('--timeout <s>', 'Wall-clock timeout in seconds (positive integer)')
    .option('--stall <s>', 'Stall-watchdog in seconds (positive integer)')
    .option('--debug', 'Enable debug logging')
    .action(runSkillTestRun)
    .addHelpText(
      'after',
      `
Description:
  Stages the named skill(s) into a fresh temp harness (context isolation: a
  scrubbed env allowlist and no user/project settings -- NOT an OS security
  sandbox), runs preflight checks (claude binary, auth, eval inputs, budget),
  then spawns a headless Claude session with a non-interactive experimenter
  prompt. The experimenter grades each eval against the skill's expectations
  and writes grading.json.

  IMPORTANT: This command EXECUTES the skill's code with your user account's
  full privileges (filesystem, network, shell) and a reachable auth credential.
  Only run skills you trust. You MUST pass --i-understand-this-runs-skill-code
  to acknowledge this and proceed.

Model:
  --model <id> is passed straight through to the experimenter spawn as
  \`claude --model <id>\` (verbatim -- VAT does not map or validate it). With no
  --model, no flag is passed and claude picks its own default. The selected
  model is echoed to stderr ("Model: <id>") on every run, and the --dry-run
  output shows the exact assembled command including the --model flag.

Exit Codes:
  0 - Harness ran to completion and produced a valid grading.json (check summary/grading.json for pass/fail counts)
  1 - Internal error (grading.json absent/invalid, summary/expectations skew, experimenter crash, stall/timeout)
  2 - Preflight failed (missing binary, auth error, eval inputs absent, unsafe workdir, ack missing, skill build failed, or --no-build with no existing dist)
  3 - Bootstrap needed: evals.json was absent, so VAT wrote a starter template next to the skill source. Fill it in and re-run.
  4 - An eval FAILED and --fail-on-eval-failure was passed (the harness completed; expectations did not all pass). Without the flag this is exit 0.

  Note: by DEFAULT, eval pass/fail is NOT reflected in the exit code -- read the
  printed summary ("PASS N/N" or "FAIL N/N") or grading.json. Pass
  --fail-on-eval-failure to make a failing eval exit 4 (e.g. to gate CI).

Example:
  $ vat skill test run my-skill --i-understand-this-runs-skill-code
`,
    );

  return command;
}
