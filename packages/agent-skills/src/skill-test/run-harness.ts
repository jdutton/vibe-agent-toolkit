/**
 * run-harness.ts — domain orchestrator for `vat skill test run`.
 *
 * Implements the full harness sequence as a pure async function (no process.exit):
 *   lock → assert safe workdir + harness root → stage → resolve staged-subject
 *   eval path → bootstrap-check (scaffold template + exit 3 if absent)
 *   → preflight (return early exitCode 2 on failure) → ack enforcement
 *   → build effective prompt + assertPromptInvariants → dry-run short-circuit
 *   → spawnHeadlessClaude → parseGradingJson → release lock → return result
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SkillSourceDescriptor } from '@vibe-agent-toolkit/resources';
import {
  getToolVersion,
  mkdirSyncReal,
  normalizedTmpdir,
  probeAuthStatus,
  resolveAssetReference,
  safeExecResult,
  safePath,
  spawnHeadlessClaude,
  toForwardSlash,
  type ResolvedAuth,
} from '@vibe-agent-toolkit/utils';

import { resolveSkillSource } from '../skill-source/resolve-skill-source.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext, SkillSource } from '../skill-source/types.js';

import { assembleChildEnv, computeEnvTokens, resolveInjectEnv } from './declared-env.js';
import { writeEvalsTemplate } from './evals-template.js';
import { BootstrapNeededError, InternalHarnessError, SkillTestExitCode } from './exit-codes.js';
import {
  assertPromptInvariants,
  buildExperimenterPrompt,
} from './experimenter-prompt.js';
import { parseGradingJson } from './grading-adapter.js';
import { assertSafeHarnessRoot, assertSafeWorkdir, prepareHarnessRoot, resolveHarnessRoot } from './harness-location.js';
import { acquireHarnessLock } from './lock.js';
import { detectPluginLayout } from './plugin-layout.js';
import { runPreflight, type PreflightInput } from './preflight.js';
import { descriptorToSource, stageHarness, type StageItem } from './staging.js';
import { verifyVendoredManifest } from './vendor-manifest.js';

/** Default subpath of the subject's eval suite, relative to its source dir. */
const DEFAULT_EVALS_SUBPATH = 'evals/evals.json';

/**
 * Absolute path to the committed, pinned vendored skill-creator copy that ships
 * with this package (`packages/agent-skills/vendor/skill-creator`). Resolved from
 * this module's own location so it is correct in both the `src` (ts) and `dist`
 * (js) layouts — both live two levels under the package root, with `vendor/`
 * shipped alongside `dist/`. Its hash manifest is verified during preflight.
 */
const VENDORED_SKILL_CREATOR_DIR = safePath.resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../vendor/skill-creator',
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Auth modes supported by the harness. */
export type HarnessAuthMode = 'inherit' | 'subscription' | 'api-key' | 'auto';

/** Auth mechanism requirements. */
export type HarnessAuthMechanism = 'subscription' | 'api-key';

export interface RunHarnessOptions {
  /** Primary skill names (subject set, required). */
  skills: string[];

  /**
   * Absolute path to the project/repo root. Used as the resolution anchor for
   * path-relative skill sources (`{path:'../x'}`) and as the persistence anchor
   * for the bootstrap evals.json scaffold. Defaults to the harness root when
   * omitted (degraded — callers should always pass the real project root).
   */
  repoRoot?: string;

  /**
   * Subpath of the subject's eval suite, relative to its source directory.
   * Defaults to `evals/evals.json` (the `evals` config knob overrides it).
   */
  evalsSubpath?: string;

  /**
   * Optional additional skill sources mapped by name. If provided, overrides
   * the default path-based resolution for that skill name.
   */
  withSources?: Record<string, SkillSourceDescriptor>;

  /** Additional optional skills to inject (with-optional). */
  withOptional?: Record<string, SkillSourceDescriptor>;

  /** Override the harness working directory (base for harnessKey derivation). */
  workdir?: string;

  /** Override the harness output directory (explicit full path). */
  out?: string;

  /** Force a full re-stage (ignored in v1; wired for future use). */
  refresh?: boolean;

  /** Keep the harness directory after the run (don't clean up). */
  keep?: boolean;

  /** Auth mode for resolving credentials. */
  auth?: HarnessAuthMode;

  /** Required auth mechanism. */
  requireAuth?: HarnessAuthMechanism;

  /** Override the experimenter prompt. */
  promptOverride?: string;

  /** Enable A/B baseline run (with/without skill). */
  baseline?: boolean;

  /** Allow unverified skill source (skip manifest check). */
  allowUnverifiedSkillSource?: boolean;

  /** Dry-run: assemble the command but don't spawn. */
  dryRun?: boolean;

  /** User has explicitly acknowledged this command runs skill code. */
  acknowledgedRunsSkillCode?: boolean;

  // One-off knob overrides
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Timeout in seconds. */
  timeout?: number;
  /** Stall watchdog in seconds. */
  stall?: number;

  /**
   * Pre-resolved source for the subject (skills[0]); set by run.ts after
   * project-aware resolution + build. A built dist dir for a declared skill, or
   * the resolved as-is source. Absent → legacy { path: skills[0] }.
   */
  subjectSource?: SkillSource;

  /**
   * Authored source dir for the subject, where the eval suite (`evals/`, incl.
   * `fixtures/`) is maintained. Used to (a) overlay that suite onto a built/dist
   * subject that doesn't carry it, and (b) write the bootstrap template when no
   * suite exists yet. For a built declared skill this is the SOURCE skill dir,
   * not the dist. Absent → derived from skills[0] (legacy).
   */
  subjectScaffoldDir?: string;

  /**
   * True when run.ts actually rebuilt the subject (declared skill, no
   * --no-build/--dry-run). Recorded in provenance. Absent/false → staged as-is.
   */
  rebuilt?: boolean;

  /** Feature B: explicit env var injections (interpolated at stage time). */
  env?: Record<string, string>;
  /** Feature A: host env var names to forward to the experimenter if present. */
  passEnv?: readonly string[];
}

export interface RunHarnessResult {
  harnessPath: string;
  exitCode: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_BUDGET_USD = 5;

export function resolveTimeoutMs(opts: RunHarnessOptions): number {
  return opts.timeout === undefined ? DEFAULT_TIMEOUT_MS : opts.timeout * 1000;
}

export function resolveStallMs(opts: RunHarnessOptions): number | undefined {
  return opts.stall === undefined ? undefined : opts.stall * 1000;
}

export function resolveKnobs(opts: RunHarnessOptions): {
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  stallMs?: number;
} {
  const result: { model?: string; maxTurns: number; maxBudgetUsd: number; stallMs?: number } = {
    maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
  };
  if (opts.model !== undefined) result.model = opts.model;
  const stallMs = resolveStallMs(opts);
  if (stallMs !== undefined) result.stallMs = stallMs;
  return result;
}

/**
 * Detect the plugin-root layout for a `{ path }` source. The resolver later COPIES
 * the source into a temp dir (losing its plugin ancestry), so we must detect here
 * — while the true on-disk source dir is still known — by resolving the path spec
 * against repoRoot and walking up for `.claude-plugin/plugin.json`. Non-`{path}`
 * sources (npm/url/vendored/workspace) have no local source tree to walk, so they
 * are always staged flat (returns undefined). undefined → flat staging.
 */
export function detectItemPluginLayout(
  source: SkillSource,
  repoRoot: string,
): StageItem['pluginLayout'] | undefined {
  if (!('path' in source)) return undefined;
  const sourceDir = resolveAssetReference(source.path, repoRoot);
  return detectPluginLayout(sourceDir, existsSync) ?? undefined;
}

export function makeStageItem(
  name: string,
  source: SkillSource,
  repoRoot: string,
  role: 'subject' | undefined,
): StageItem {
  const pluginLayout = detectItemPluginLayout(source, repoRoot);
  return {
    name,
    source,
    ...(role === undefined ? {} : { role }),
    ...(pluginLayout === undefined ? {} : { pluginLayout }),
  };
}

export function buildStageItems(opts: RunHarnessOptions, repoRoot: string): StageItem[] {
  const items: StageItem[] = [];

  // The FIRST positional skill is the subject under test; the rest of the
  // primary set and any `--with`/`--with-optional` deps are supporting context.
  const subjectName = opts.skills[0];
  for (const name of opts.skills) {
    const override = opts.withSources?.[name];
    let source: SkillSource;
    if (name === subjectName && opts.subjectSource !== undefined) {
      source = opts.subjectSource;
    } else if (override) {
      source = descriptorToSource(override);
    } else {
      source = { path: name };
    }
    items.push(makeStageItem(name, source, repoRoot, name === subjectName ? 'subject' : undefined));
  }

  if (opts.withOptional !== undefined) {
    for (const [name, spec] of Object.entries(opts.withOptional)) {
      const source = descriptorToSource(spec);
      items.push(makeStageItem(name, source, repoRoot, undefined));
    }
  }

  return items;
}

export function buildResolveCtx(harnessRoot: string, repoRoot: string): ResolveSkillSourceContext {
  return {
    repoRoot,
    stagingRoot: safePath.joinUnderRoot(harnessRoot, 'staged'),
    fetchCacheDir: safePath.join(normalizedTmpdir(), 'vat-fetch-cache'),
  };
}

/**
 * Map of flags to dummy values used when probing for flag support.
 *
 * Each value is chosen so value-validation (e.g., enum checks) accepts it
 * before `--help` short-circuits the session. The empty string `''` for
 * `--setting-sources` is intentional — an empty comma-separated list is valid.
 */
const FLAG_DUMMY_VALUES: Record<string, string> = {
  '--plugin-dir': '.',
  '--setting-sources': '',
  '--output-format': 'stream-json',
  '--permission-mode': 'bypassPermissions',
  '--max-turns': '1',
  '--max-budget-usd': '1',
};

/**
 * Return a sensible dummy value for a given CLI flag so that value-validation
 * doesn't reject the argument before `--help` can short-circuit the session.
 */
export function flagDummyValueFor(flag: string): string {
  return FLAG_DUMMY_VALUES[flag] ?? '1';
}

/**
 * Build a token-free flag-parse probe.
 *
 * For each flag, runs `claude <flag> <dummyValue> --help` via safeExecResult.
 * Exit 0 means claude's parser accepts the flag; `--help` short-circuits before
 * any session or tokens are consumed.
 *
 * The dummy value is always included in the args, even when it is an empty
 * string — some flags (e.g., `--setting-sources`) require a value argument,
 * so omitting it causes exit 1 before `--help` can be reached.
 *
 * The probe is a closure — it is NOT spawned at module scope, only at call time
 * inside runPreflight.
 */
function buildFlagParseProbe(): (flag: string) => boolean {
  return (flag: string): boolean => {
    const dummy = flagDummyValueFor(flag);
    const result = safeExecResult('claude', [flag, dummy, '--help'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15_000,
    });
    return result.success;
  };
}

export function buildPreflightInput(
  evalsPath: string,
  pluginDirs: string[],
  opts: RunHarnessOptions,
  knobs: { maxBudgetUsd: number },
): PreflightInput {
  const costEstimate: PreflightInput['costEstimate'] = {
    evalCount: 1,
    configurations: 1,
    runsPerQuery: 1,
    maxBudgetUsd: knobs.maxBudgetUsd,
  };

  const preflightOpts: PreflightInput = {
    claudeVersionProbe: () => getToolVersion('claude'),
    flagParseProbe: buildFlagParseProbe(),
    authProbe: probeAuthStatus,
    evalInputPaths: [evalsPath],
    declaredDepDirs: pluginDirs,
    integrityOk: () => {
      if (opts.allowUnverifiedSkillSource === true) return true;
      // Verify the committed, pinned vendored skill-creator copy that ships with
      // this package — the grading rubric / schema source the experimenter is told
      // to reuse. A missing, unparseable, or mutated manifest fails preflight (exit 2).
      return verifyVendoredManifest(VENDORED_SKILL_CREATOR_DIR);
    },
    costEstimate,
    authMode: opts.auth ?? 'auto',
    sourceEnv: process.env,
  };

  if (opts.requireAuth !== undefined) preflightOpts.requireAuth = opts.requireAuth;

  return preflightOpts;
}

export function renderPreflightSummary(checks: { name: string; passed: boolean; message: string }[]): string {
  const failed = checks.filter(c => !c.passed);
  return failed.length > 0
    ? failed.map(c => `  [FAIL] ${c.name}: ${c.message}`).join('\n')
    : '  All preflight checks passed.';
}

export function isAcknowledged(opts: RunHarnessOptions): boolean {
  return opts.dryRun === true || opts.acknowledgedRunsSkillCode === true;
}

/**
 * Translate a non-success spawn outcome into an InternalHarnessError (exit 1).
 * A stall, a timeout, OR a non-zero exit are each authoritative — a non-zero exit
 * is never laundered into a PASS even if a grading.json happens to be on disk.
 */
export function assertExperimenterSucceeded(
  spawnResult: { stalled: boolean; timedOut: boolean; status: number },
  stallMs: number | undefined,
  timeoutMs: number,
): void {
  if (spawnResult.stalled) {
    throw new InternalHarnessError(`Experimenter stalled (no output for ${stallMs ?? 0}ms).`);
  }
  if (spawnResult.timedOut) {
    throw new InternalHarnessError(`Experimenter timed out after ${timeoutMs}ms.`);
  }
  if (spawnResult.status !== 0) {
    throw new InternalHarnessError(`Experimenter exited non-zero (status ${spawnResult.status}).`);
  }
}

/**
 * Resolve the PERSISTENT location where a bootstrap scaffold should be written
 * so "fill it in and re-run" actually works for the user (the staged copy is
 * ephemeral). When the subject is a local `{path}` source we scaffold next to
 * that real source dir; otherwise we anchor under the repo root by skill name.
 */
/** The subject skill's display name (trailing segment of the positional skill arg). */
export function subjectSkillName(opts: RunHarnessOptions): string {
  const subject = opts.skills[0] ?? 'skill';
  return basename(toForwardSlash(subject)) || subject;
}

export function resolveScaffoldEvalsPath(opts: RunHarnessOptions, repoRoot: string, evalsSubpath: string): string {
  // Prefer the explicit authored source dir resolved by run.ts (the staged/built
  // tree is ephemeral; this is where the user can edit the scaffolded template).
  if (opts.subjectScaffoldDir !== undefined) {
    return safePath.join(opts.subjectScaffoldDir, evalsSubpath);
  }
  const subjectName = opts.skills[0] ?? '';
  const override = opts.withSources?.[subjectName];
  const overridePath = override && 'path' in override ? override.path : undefined;
  // Default (no override) resolution treats the positional name as a path.
  const sourcePath = overridePath ?? subjectName;
  // eslint-disable-next-line local/no-unsafe-root-join -- the positional skill source may be an absolute path; resolving it against repoRoot (which returns an absolute sourcePath unchanged) is intentional, documented behavior, not a containment bug.
  const sourceDir = safePath.resolve(repoRoot, sourcePath);
  return safePath.join(sourceDir, evalsSubpath);
}

interface ResolveDeclaredChildEnvInput {
  opts: RunHarnessOptions;
  resolvedAuth: ResolvedAuth | null;
  subjectStagedDir: string;
  harnessRoot: string;
  resultsDir: string;
  evalsSubpath: string;
  subjectPluginRoot: string | null;
}

/**
 * Assemble the experimenter's child env: the scrubbed forwarded env unioned with
 * the declared test env (Features A + B) and CLAUDE_PLUGIN_ROOT, then emit the
 * transparency line and any protected-key collision warnings to stderr.
 *
 * Refuses to assemble without a resolved auth — a null here is an internal
 * invariant violation (preflight passed), never a reason to fall back to
 * process.env, which would hand untrusted skill code every secret it contains.
 */
function resolveDeclaredChildEnv(input: ResolveDeclaredChildEnvInput): ReturnType<typeof assembleChildEnv> {
  if (input.resolvedAuth === null) {
    throw new InternalHarnessError(
      'Internal: preflight passed but resolvedAuth is null — refusing to spawn with an unscrubbed environment.',
    );
  }
  const envTokens = computeEnvTokens({
    subjectStagedDir: input.subjectStagedDir,
    harnessRoot: input.harnessRoot,
    resultsDir: input.resultsDir,
    evalsSubpath: input.evalsSubpath,
  });
  const injectEnv = resolveInjectEnv(input.opts.env, envTokens);
  const assembled = assembleChildEnv({
    base: input.resolvedAuth.forwardedEnv,
    source: process.env,
    ...(input.opts.passEnv ? { passEnv: input.opts.passEnv } : {}),
    ...(injectEnv ? { injectEnv } : {}),
    subjectPluginRoot: input.subjectPluginRoot,
  });
  for (const warning of assembled.warnings) process.stderr.write(`warning: ${warning}\n`);
  process.stderr.write(assembled.line + '\n');
  return assembled;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Domain orchestrator for `vat skill test run`. Pure of process.exit — all
 * exit-code decisions live in the caller (run.ts).
 */
export async function runSkillTestHarness(opts: RunHarnessOptions): Promise<RunHarnessResult> {
  // §7 workdir safety: refuse a --workdir whose ancestry contains CLAUDE.md/.claude
  // BEFORE deriving the harness root from it (defense in depth with --setting-sources "").
  if (opts.workdir !== undefined) {
    assertSafeWorkdir(opts.workdir);
  }

  const harnessRoot = opts.out ?? resolveHarnessRoot(opts.skills, opts.workdir);
  const repoRoot = opts.repoRoot ?? harnessRoot;
  const evalsSubpath = opts.evalsSubpath ?? DEFAULT_EVALS_SUBPATH;
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;

  // Tighten an existing directory to 0700 (if present) BEFORE mkdir — adopter
  // may have created the --out dir with default umask (0755). This is strictly
  // safer: we only remove access, never grant it. Symlink still throws.
  prepareHarnessRoot(harnessRoot);

  // Ensure the harness root directory exists before validating it.
  mkdirSyncReal(harnessRoot, { recursive: true, mode: 0o700 });

  // Step 1: Assert safe harness root (symlink/ownership/mode checks) BEFORE
  // acquiring the lock — never write a lockfile into a directory we have not yet
  // confirmed is non-symlinked, owned by the current uid, and 0700. The trusted
  // boundary is the tmp/workdir base the harness root was derived from; every
  // component beneath it (incl. the recursively-created `vat-skill-test` parent)
  // is validated, closing the shared-/tmp TOCTOU on intermediate components.
  const trustedTmpRoot = opts.workdir ?? normalizedTmpdir();
  assertSafeHarnessRoot(harnessRoot, currentUid, trustedTmpRoot);

  // Step 2: Acquire exclusive harness lock.
  const lock = acquireHarnessLock(harnessRoot);

  try {
    // Step 3: Stage the harness FIRST — the subject's own evals/evals.json lands
    // inside its staged dir, so we must stage before we can locate it. The subject's
    // source is pre-resolved (and, for declared skills, pre-built) by run.ts and
    // arrives via opts.subjectSource; build no longer happens in-domain here.
    const resolveCtx = buildResolveCtx(harnessRoot, repoRoot);
    const items = buildStageItems(opts, repoRoot);

    const stageResult = await stageHarness({
      harnessRoot,
      items,
      resolve: (source: SkillSource, ctx: ResolveSkillSourceContext): Promise<ResolvedSkillSource> =>
        resolveSkillSource(source, ctx),
      ctx: resolveCtx,
      currentUid,
    });

    const { pluginDirs, subjectStagedDir, subjectPluginRoot } = stageResult;

    if (subjectStagedDir === null) {
      throw new InternalHarnessError('Staging did not yield a subject directory (no item tagged role:subject).');
    }

    // Step 4: Resolve the subject's eval path inside its staged dir.
    //
    // The eval suite (`evals/`, incl. `fixtures/`) is authored TEST INPUT, not a
    // shipped artifact — a built/dist subject won't carry it (packageSkill bundles
    // only link-reachable resources + `files:`). Since the harness reads evals and
    // fixtures relative to the staged subject, overlay the authored suite from the
    // scaffold (source) dir when the staged subject lacks it. The bootstrap below
    // then fires — and writes a template to the source scaffold — ONLY when the suite
    // genuinely doesn't exist anywhere, so authored evals are never overwritten.
    const evalsDir = dirname(evalsSubpath);
    const scaffoldEvalsDir =
      opts.subjectScaffoldDir === undefined
        ? undefined
        : safePath.join(opts.subjectScaffoldDir, evalsDir);
    const stagedEvalsDir = safePath.join(subjectStagedDir, evalsDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own staged/scaffold paths
    if (evalsDir !== '.' && scaffoldEvalsDir !== undefined && !existsSync(stagedEvalsDir) && existsSync(scaffoldEvalsDir)) {
      cpSync(scaffoldEvalsDir, stagedEvalsDir, { recursive: true });
    }

    // Bootstrap (exit 3) fires when the suite is absent everywhere — scaffold a
    // persistent template at the source location the user can edit, then throw.
    const evalsPath = safePath.join(subjectStagedDir, evalsSubpath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own staged-subject path
    if (!existsSync(evalsPath)) {
      const scaffoldPath = resolveScaffoldEvalsPath(opts, repoRoot, evalsSubpath);
      const written = writeEvalsTemplate(scaffoldPath, subjectSkillName(opts));
      throw new BootstrapNeededError(written);
    }

    // Step 5: Preflight checks.
    const knobs = resolveKnobs(opts);
    const preflightInput = buildPreflightInput(evalsPath, pluginDirs, opts, knobs);
    const preflightResult = runPreflight(preflightInput);

    if (!preflightResult.passed) {
      const summary = renderPreflightSummary(preflightResult.checks);
      return {
        harnessPath: harnessRoot,
        exitCode: SkillTestExitCode.Preflight,
        summary: `Preflight failed:\n${summary}`,
      };
    }

    // Step 6: Enforce the §12 security ack (must pass --i-understand-this-runs-skill-code).
    // Only enforced when not a dry-run and not already acknowledged.
    if (!isAcknowledged(opts)) {
      return {
        harnessPath: harnessRoot,
        exitCode: SkillTestExitCode.Preflight,
        summary:
          'Security acknowledgment required. Pass --i-understand-this-runs-skill-code to proceed.',
      };
    }

    // Step 7: Build effective experimenter prompt and validate invariants.
    const resultsDir = safePath.joinUnderRoot(harnessRoot, 'results');
    mkdirSyncReal(resultsDir, { recursive: true });

    // Record what was actually staged & tested (the subject identity + the
    // staged manifest fingerprint + per-entry content hashes) so a run is
    // auditable: which source was resolved, and whether it was rebuilt by run.ts.
    const provenance = {
      subject: subjectSkillName(opts),
      fingerprint: stageResult.manifest.fingerprint,
      entries: stageResult.manifest.entries,
      rebuilt: opts.rebuilt === true,
    };
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
    writeFileSync(
      safePath.join(resultsDir, 'provenance.json'),
      JSON.stringify(provenance, null, 2) + '\n',
      'utf-8',
    );
    process.stderr.write(`Provenance: ${provenance.fingerprint}\n`);

    const gradingOut = safePath.join(resultsDir, 'grading.json');
    const frictionOut = safePath.join(resultsDir, 'friction.json');

    const effectivePrompt =
      opts.promptOverride ??
      buildExperimenterPrompt({
        subjectPath: subjectStagedDir,
        evalsPath,
        gradingOut,
        frictionOut,
        baseline: opts.baseline ?? false,
      });

    assertPromptInvariants(effectivePrompt);

    // Step 8: Write the experimenter-prompt.txt.
    const promptFile = safePath.join(resultsDir, 'experimenter-prompt.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived path
    writeFileSync(promptFile, effectivePrompt + '\n', 'utf-8');

    // Step 7.5: Resolve the declared test env (Features A + B). Token resolution
    // can hard-fail (exit 2) on an unknown ${token}; do it before the dry-run
    // short-circuit so a dry run validates interpolation too.
    const assembledEnv = resolveDeclaredChildEnv({
      opts,
      resolvedAuth: preflightResult.resolvedAuth,
      subjectStagedDir,
      harnessRoot,
      resultsDir,
      evalsSubpath,
      subjectPluginRoot,
    });

    // Step 9: Dry-run short-circuit — return assembled info without spawning.
    if (opts.dryRun === true) {
      return {
        harnessPath: harnessRoot,
        exitCode: SkillTestExitCode.Ok,
        summary: `[dry-run] Would spawn: claude -p (prompt via stdin from ${promptFile})`,
      };
    }

    // Step 10: Spawn headless Claude.
    // A reused harness root (--out / --keep) may carry a grading.json OR a
    // friction.json from an earlier run. Remove both so a post-spawn read can
    // only reflect THIS run (a stale friction.json must not leak across runs).
    rmSync(gradingOut, { force: true });
    rmSync(frictionOut, { force: true });

    const timeoutMs = resolveTimeoutMs(opts);
    const spawnOpts = {
      promptFile,
      pluginDirs,
      sandboxDir: harnessRoot,
      cwd: harnessRoot,
      // The scrubbed forwarded env, unioned with the declared test env (Features
      // A + B) and CLAUDE_PLUGIN_ROOT when the subject is plugin-distributed.
      env: assembledEnv.env,
      timeoutMs,
      onStdout: (chunk: string) => { process.stderr.write(chunk); },
      onStderr: (chunk: string) => { process.stderr.write(chunk); },
      maxTurns: knobs.maxTurns,
      maxBudgetUsd: knobs.maxBudgetUsd,
      ...(knobs.model === undefined ? {} : { model: knobs.model }),
      ...(knobs.stallMs === undefined ? {} : { stallMs: knobs.stallMs }),
    };

    const spawnResult = await spawnHeadlessClaude(spawnOpts);
    assertExperimenterSucceeded(spawnResult, knobs.stallMs, timeoutMs);

    // Step 11: Parse grading.json — must be present and valid.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived path
    if (!existsSync(gradingOut)) {
      throw new InternalHarnessError(
        `Experimenter exited (status ${spawnResult.status}) without writing grading.json at ${gradingOut}.`,
      );
    }

    let gradingRaw: unknown;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived path
      gradingRaw = JSON.parse(readFileSync(gradingOut, 'utf-8'));
    } catch (e) {
      throw new InternalHarnessError(`grading.json is not valid JSON: ${String(e)}`);
    }

    const grading = parseGradingJson(gradingRaw);
    const { passed, total } = grading.summary;
    const allPassed = passed === total;
    const summary = `${allPassed ? 'PASS' : 'FAIL'} ${passed}/${total}`;

    // Exit 0 = harness ran to completion and produced a valid grading.json.
    // Pass/fail counts are reported in the summary string and grading.json;
    // callers should not use the exit code to distinguish eval pass from fail.
    return {
      harnessPath: harnessRoot,
      exitCode: SkillTestExitCode.Ok,
      summary,
    };
  } finally {
    lock.release();
  }
}
