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

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getToolVersion,
  mkdirSyncReal,
  normalizedTmpdir,
  probeAuthStatus,
  safeExecResult,
  safePath,
  spawnHeadlessClaude,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

import { resolveSkillSource } from '../skill-source/resolve-skill-source.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext, SkillSource } from '../skill-source/types.js';

import { writeEvalsTemplate } from './evals-template.js';
import { BootstrapNeededError, InternalHarnessError, SkillTestExitCode } from './exit-codes.js';
import {
  assertPromptInvariants,
  buildExperimenterPrompt,
} from './experimenter-prompt.js';
import { parseGradingJson } from './grading-adapter.js';
import { assertSafeHarnessRoot, assertSafeWorkdir, resolveHarnessRoot } from './harness-location.js';
import { acquireHarnessLock } from './lock.js';
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

/** A skill source descriptor (mirrors SkillSource union). */
export interface SkillSourceSpec {
  path?: string;
  npm?: string;
  url?: string;
  sha256?: string;
  workspace?: string;
  vendored?: true;
}

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
  withSources?: Record<string, SkillSourceSpec>;

  /** Additional optional skills to inject (with-optional). */
  withOptional?: Record<string, SkillSourceSpec>;

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

function resolveTimeoutMs(opts: RunHarnessOptions): number {
  return opts.timeout === undefined ? DEFAULT_TIMEOUT_MS : opts.timeout * 1000;
}

function resolveStallMs(opts: RunHarnessOptions): number | undefined {
  return opts.stall === undefined ? undefined : opts.stall * 1000;
}

function resolveKnobs(opts: RunHarnessOptions): {
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

function buildStageItems(opts: RunHarnessOptions): StageItem[] {
  const items: StageItem[] = [];

  // The FIRST positional skill is the subject under test; the rest of the
  // primary set and any `--with`/`--with-optional` deps are supporting context.
  const subjectName = opts.skills[0];
  for (const name of opts.skills) {
    const override = opts.withSources?.[name];
    const source: SkillSource = override
      ? descriptorToSource(override as Parameters<typeof descriptorToSource>[0])
      : { path: name };
    items.push(name === subjectName ? { name, source, role: 'subject' } : { name, source });
  }

  if (opts.withOptional !== undefined) {
    for (const [name, spec] of Object.entries(opts.withOptional)) {
      items.push({
        name,
        source: descriptorToSource(spec as Parameters<typeof descriptorToSource>[0]),
      });
    }
  }

  return items;
}

function buildResolveCtx(harnessRoot: string, repoRoot: string): ResolveSkillSourceContext {
  return {
    repoRoot,
    stagingRoot: safePath.join(harnessRoot, 'staged'),
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
function flagDummyValueFor(flag: string): string {
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

function buildPreflightInput(
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

function renderPreflightSummary(checks: { name: string; passed: boolean; message: string }[]): string {
  const failed = checks.filter(c => !c.passed);
  return failed.length > 0
    ? failed.map(c => `  [FAIL] ${c.name}: ${c.message}`).join('\n')
    : '  All preflight checks passed.';
}

function isAcknowledged(opts: RunHarnessOptions): boolean {
  return opts.dryRun === true || opts.acknowledgedRunsSkillCode === true;
}

/**
 * Translate a non-success spawn outcome into an InternalHarnessError (exit 1).
 * A stall, a timeout, OR a non-zero exit are each authoritative — a non-zero exit
 * is never laundered into a PASS even if a grading.json happens to be on disk.
 */
function assertExperimenterSucceeded(
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
function subjectSkillName(opts: RunHarnessOptions): string {
  const subject = opts.skills[0] ?? 'skill';
  return basename(toForwardSlash(subject)) || subject;
}

function resolveScaffoldEvalsPath(opts: RunHarnessOptions, repoRoot: string, evalsSubpath: string): string {
  const subjectName = opts.skills[0] ?? '';
  const override = opts.withSources?.[subjectName];
  const overridePath = override && typeof override.path === 'string' ? override.path : undefined;
  // Default (no override) resolution treats the positional name as a path.
  const sourcePath = overridePath ?? subjectName;
  const sourceDir = safePath.resolve(repoRoot, sourcePath);
  return safePath.join(sourceDir, evalsSubpath);
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

  // Ensure the harness root directory exists before validating it.
  mkdirSyncReal(harnessRoot, { recursive: true, mode: 0o700 });

  // Step 1: Assert safe harness root (symlink/ownership/mode checks) BEFORE
  // acquiring the lock — never write a lockfile into a directory we have not yet
  // confirmed is non-symlinked, owned by the current uid, and 0700.
  assertSafeHarnessRoot(harnessRoot, currentUid);

  // Step 2: Acquire exclusive harness lock.
  const lock = acquireHarnessLock(harnessRoot);

  try {
    // Step 3: Stage the harness FIRST — the subject's own evals/evals.json lands
    // inside its staged dir, so we must stage before we can locate it.
    const resolveCtx = buildResolveCtx(harnessRoot, repoRoot);
    const items = buildStageItems(opts);

    const { pluginDirs, subjectStagedDir } = await stageHarness({
      harnessRoot,
      items,
      resolve: (source: SkillSource, ctx: ResolveSkillSourceContext): Promise<ResolvedSkillSource> =>
        resolveSkillSource(source, ctx),
      ctx: resolveCtx,
      currentUid,
    });

    if (subjectStagedDir === null) {
      throw new InternalHarnessError('Staging did not yield a subject directory (no item tagged role:subject).');
    }

    // Step 4: Resolve the subject's eval path inside its staged dir. Bootstrap
    // (exit 3) fires when it is absent — scaffold a persistent template the user
    // can edit, then throw pointing at that real location.
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
    const resultsDir = safePath.join(harnessRoot, 'results');
    mkdirSyncReal(resultsDir, { recursive: true });

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

    // Step 9: Dry-run short-circuit — return assembled info without spawning.
    if (opts.dryRun === true) {
      return {
        harnessPath: harnessRoot,
        exitCode: SkillTestExitCode.Ok,
        summary: `[dry-run] Would spawn: claude -p (prompt via stdin from ${promptFile})`,
      };
    }

    // Step 10: Spawn headless Claude.
    // Refuse to spawn with an unscrubbed environment. When preflight passes,
    // resolvedAuth is always non-null; a null here is an internal invariant
    // violation — NOT a reason to fall back to the full parent `process.env`,
    // which would hand the untrusted skill code every secret it contains.
    if (preflightResult.resolvedAuth === null) {
      throw new InternalHarnessError(
        'Internal: preflight passed but resolvedAuth is null — refusing to spawn with an unscrubbed environment.',
      );
    }

    // A reused harness root (--out / --keep) may carry a grading.json from an
    // earlier run. Remove it so a post-spawn read can only reflect THIS run.
    rmSync(gradingOut, { force: true });

    const timeoutMs = resolveTimeoutMs(opts);
    const spawnOpts = {
      promptFile,
      pluginDirs,
      sandboxDir: harnessRoot,
      cwd: harnessRoot,
      env: preflightResult.resolvedAuth.forwardedEnv,
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
