/**
 * `vat skill test run <skill...>` — execute a packaged skill's eval suite in isolation.
 *
 * Thin orchestration layer: parse flags, resolve precedence (flag > config > default),
 * print the §12 security warning, call runSkillTestHarness, map result/error to exit code.
 * All domain logic lives in run-harness.ts (agent-skills package).
 */

import { basename } from 'node:path';

import { BootstrapNeededError, mapErrorToExitCode, runSkillTestHarness } from '@vibe-agent-toolkit/agent-skills';
import type { SkillSourceDescriptor, TestConfig } from '@vibe-agent-toolkit/resources';
import { findProjectRoot, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { loadConfig } from '../../../utils/config-loader.js';

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
  const src = pair.slice(eq + 1);
  return [name, parseSourceSpec(src, pair)];
}

/** Parse the `kind:value` source half of a --with pair into a SkillSourceSpec. */
function parseSourceSpec(src: string, original: string): SkillSourceSpec {
  if (src === 'vendored') return { vendored: true };
  const colon = src.indexOf(':');
  const kind = colon === -1 ? src : src.slice(0, colon);
  const value = colon === -1 ? '' : src.slice(colon + 1);
  switch (kind) {
    case 'workspace': return requireValue(value, original, () => ({ workspace: value }));
    case 'npm': return requireValue(value, original, () => ({ npm: value }));
    case 'path': return requireValue(value, original, () => ({ path: value }));
    case 'url': return requireValue(value, original, () => ({ url: value }));
    default:
      throw new Error(
        `--with source must start with workspace:|npm:|url:|path:|vendored. Got: ${original}`,
      );
  }
}

function requireValue(value: string, original: string, build: () => SkillSourceSpec): SkillSourceSpec {
  if (!value) {
    throw new Error(`--with source is missing a value: ${original}`);
  }
  return build();
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
  if (config?.build !== undefined) opts.build = config.build;
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
  // cwd for the pre-stage build hook. repoRoot comes from findProjectRoot, whose
  // discovery ladder is config-anchored (vibe-agent-toolkit.config.yaml first, then
  // .git), so the project root IS the directory holding the config — configRoot and
  // repoRoot are the same dir by construction, not coincidence.
  opts.configRoot = repoRoot;
  applyFlagOnlyOptions(opts, options);
  applyScalarMerges(opts, options, config);
  applyKnobMerges(opts, knobs, config);
  applyDepMerges(opts, options, config);
  applyEnvMerges(opts, options, config);
  return opts;
}

// ---------------------------------------------------------------------------
// Testable action
// ---------------------------------------------------------------------------

/**
 * The unit-testable action for `vat skill test run`. Exported so tests can
 * call it directly without parsing CLI args. Calls process.exit on completion.
 *
 * Note: the security ack enforcement lives inside runSkillTestHarness (domain),
 * NOT here — this ensures the mock in tests can bypass it cleanly.
 */
export async function runSkillTestRun(
  skills: string[],
  options: SkillTestRunOptions,
): Promise<void> {
  printSecurityWarning();

  const knobs = coerceKnobs(options);
  const config = loadTestConfig(skills);
  const harnessOpts = buildHarnessOpts(skills, options, knobs, config);

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
    .option('--workdir <dir>', 'Override the harness working directory')
    .option('--out <dir>', 'Override the harness output directory')
    .option('--keep', 'Keep the harness directory after the run')
    .option('--dry-run', 'Assemble the command without spawning Claude')
    .option('--auth <mode>', 'Auth mechanism: inherit | subscription | api-key | auto')
    .option('--require-auth <mech>', 'Require a specific auth mechanism: subscription | api-key')
    .option('--baseline', 'Enable A/B baseline run (with/without skill)')
    .option('--allow-unverified-skill-source', 'Skip the vendored manifest integrity check')
    .option('--i-understand-this-runs-skill-code', 'Acknowledge this command executes skill code (required)')
    .option('--model <id>', 'Pinned model ID override')
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

Exit Codes:
  0 - Harness ran to completion and produced a valid grading.json (check summary/grading.json for pass/fail counts)
  1 - Internal error (grading.json absent/invalid, experimenter crash, stall/timeout)
  2 - Preflight failed (missing binary, auth error, eval inputs absent, unsafe workdir, ack missing)
  3 - Bootstrap needed: evals.json was absent, so VAT wrote a starter template next to the skill source. Fill it in and re-run.

  Note: eval pass/fail is NOT reflected in the exit code. Read the printed summary
  ("PASS N/N" or "FAIL N/N") or grading.json to determine whether expectations passed.

Example:
  $ vat skill test run my-skill --i-understand-this-runs-skill-code
`,
    );

  return command;
}
