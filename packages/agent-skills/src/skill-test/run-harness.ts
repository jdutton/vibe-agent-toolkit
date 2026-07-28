/**
 * run-harness.ts — domain orchestrator for `vat skill test run`.
 *
 * Implements the full harness sequence as a pure async function (no process.exit):
 *   lock → assert safe workdir + harness root → stage → resolve staged-subject
 *   eval path → bootstrap-check (scaffold template + exit 3 if absent)
 *   → preflight (return early exitCode 2 on failure) → ack enforcement
 *   → dry-run short-circuit → build per-eval work items → run the vat-owned
 *   executor→grader pipeline (bounded-parallel) → merge grader fragments →
 *   write grading.json/friction.json (vat is SOLE writer) → reconcile verdict
 *   → release lock → return result
 */

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SkillSourceDescriptor } from '@vibe-agent-toolkit/resources';
import {
  getToolVersion,
  killAllActiveClaudeChildren,
  mkdirSyncReal,
  normalizedTmpdir,
  probeAuthStatus,
  resolveAssetReference,
  safeExecResult,
  safePath,
  type spawnHeadlessClaude,
  toForwardSlash,
  type ResolvedAuth,
} from '@vibe-agent-toolkit/utils';

import { resolveSkillSource } from '../skill-source/resolve-skill-source.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext, SkillSource } from '../skill-source/types.js';

import { assembleChildEnv, computeEnvTokens, resolveInjectEnv } from './declared-env.js';
import { runExecutorForEval } from './eval-executor.js';
import type { EvalFragment } from './eval-fragment.js';
import { runGraderForEval } from './eval-grader.js';
import { EvalInputError, parseEvalSuite, stageEvalWorkspaces, type EvalEntry, type EvalSuite } from './eval-inputs.js';
import { lintEvalExpectations, lintToolExpectationExecutables } from './eval-lint.js';
import { writeEvalsTemplate } from './evals-template.js';
import {
  BootstrapNeededError,
  DuplicateStagedSkillError,
  InternalHarnessError,
  SkillTestExitCode,
  type SkillTestExitCodeValue,
} from './exit-codes.js';
import { mergeFragmentsToFriction, mergeFragmentsToGrading, mergeFragmentsToToolEval } from './fragment-merge.js';
import { FrictionReportSchema, type FrictionItem } from './friction-schema.js';
import { DEFAULT_CONCURRENCY, DEFAULT_GRADER_MODEL } from './grader-model.js';
import { reconcileGrading, type GradingVerdict } from './grading-adapter.js';
import { GradingReportSchema } from './grading-schema.js';
import { assertSafeHarnessRoot, assertSafeWorkdir, prepareHarnessRoot, resolveHarnessRoot } from './harness-location.js';
import { acquireHarnessLock, installSignalCleanup } from './lock.js';
import { runPipeline } from './pipeline.js';
import { detectPluginLayout } from './plugin-layout.js';
import { runPreflight, type PreflightInput } from './preflight.js';
import { descriptorToSource, stageHarness, type StageItem } from './staging.js';
import {
  buildSkippedSummary,
  formatSkippedTiersSummary,
  groupEvalsByTier,
  shouldGateAfterTier,
  type SkippedEvalsSummary,
} from './tier-plan.js';
import { ToolEvalReportSchema, type ToolEvalReport } from './tool-eval-schema.js';
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

/**
 * Absolute path to the vendored skill-creator grader rubric each per-eval grader
 * spawn is told to judge against (issue #145). Lives inside
 * {@link VENDORED_SKILL_CREATOR_DIR}, whose hash manifest is verified during
 * preflight — so the rubric the grader uses is the pinned, integrity-checked copy.
 */
const GRADER_RUBRIC_PATH = safePath.join(VENDORED_SKILL_CREATOR_DIR, 'agents/grader.md');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Auth modes supported by the harness. */
export type HarnessAuthMode = 'inherit' | 'subscription' | 'api-key' | 'auto';

/** Auth mechanism requirements. */
export type HarnessAuthMechanism = 'subscription' | 'api-key';

export interface RunHarnessOptions {
  /** The single skill under test (required). */
  subject: string;

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
   * REQUIRED companion skills to stage alongside the subject (`--with`/config
   * `with:`), keyed by name. Each is staged and made invocable exactly like the
   * subject; unlike {@link withOptional}, a companion here that fails to resolve
   * fails the whole run (see {@link DuplicateStagedSkillError} for the one
   * cross-cutting constraint: every staged name — subject, `with`, and
   * `withOptional` — must be unique).
   */
  withSources?: Record<string, SkillSourceDescriptor>;

  /**
   * OPTIONAL companion skills to stage alongside the subject (`--with-optional`/
   * config `optional:`), keyed by name. Staged and made invocable exactly like a
   * `withSources` entry, EXCEPT a companion here that fails to resolve is
   * skipped-with-warning (recorded in the staging result's `skippedOptional`)
   * instead of failing the run.
   */
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

  /**
   * Pinned grader/judge model for the per-eval grader spawns. Defaults to
   * {@link DEFAULT_GRADER_MODEL}. Deliberately distinct from `model` (which is
   * the model under test in the executor spawns) so the judge stays comparable
   * across runs regardless of the subject model.
   */
  graderModel?: string;

  /** Bounded-parallel executor→grader pipeline width. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;

  /**
   * Injectable spawn seam (tests only). When set, it replaces the real
   * {@link spawnHeadlessClaude} in BOTH the executor and grader per-eval spawns,
   * so a test can drive the full harness with a fake `claude` and no real
   * install. Production callers leave it undefined (the real spawn is used).
   */
  spawn?: typeof spawnHeadlessClaude;

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
   * Pre-resolved source for the subject; set by run.ts after project-aware
   * resolution + build. A built dist dir for a declared skill, or the resolved
   * as-is source. Absent → legacy { path: subject }.
   */
  subjectSource?: SkillSource;

  /**
   * Authored source dir for the subject, where the eval suite (`evals/`, incl.
   * `fixtures/`) is maintained. Used to (a) overlay that suite onto a built/dist
   * subject that doesn't carry it, and (b) write the bootstrap template when no
   * suite exists yet. For a built declared skill this is the SOURCE skill dir,
   * not the dist. Absent → derived from subject (legacy).
   */
  subjectScaffoldDir?: string;

  /**
   * True when run.ts actually rebuilt the subject (declared skill, no
   * --no-build/--dry-run). Recorded in provenance. Absent/false → staged as-is.
   */
  rebuilt?: boolean;

  /**
   * True when the resolved reference is `buildable` — a real run WOULD build +
   * stage it before spawning. False/absent for plain `source` subjects. Set by
   * run.ts after project-aware resolution; used in the dry-run summary.
   */
  wouldBuild?: boolean;

  /**
   * Meaningful only when wouldBuild is true and dryRun is true. True = the
   * dry-run staged the EXISTING on-disk dist without rebuilding (may be stale).
   * False = no dist existed yet so the preview fell back to the source dir.
   * Absent when not a dry-run or when the subject is a plain source.
   */
  dryRunStagedExistingDist?: boolean;

  /** Feature B: explicit env var injections (interpolated at stage time). */
  env?: Record<string, string>;
  /** Feature A: host env var names to forward to the executor spawn if present. */
  passEnv?: readonly string[];

  /**
   * Declared executables the subject skill ships (name + kind + howInvoked),
   * populated by run.ts from the resolved subject's packaging config WHEN cleanly
   * reachable (a `buildable` ref carries `packagingConfig`; a plain path source
   * does not — issue #145 Phase T). Passed to the grader on the WITH arm ONLY as
   * a recognition aid alongside each eval's `toolExpectations`. Absent → the
   * grader still matches tools by the commands it sees in the transcript.
   */
  declaredExecutables?: Array<{ name: string; howInvoked: string; kind: string }>;

  /**
   * Opt-OUT of eval gating (for interactive use). By DEFAULT (false/absent) a
   * failing verdict returns exit EvalFailure (4) — fail-closed, so CI catches a
   * regression without an extra flag. When true, a failing verdict is downgraded
   * to Ok (0) and the pass/fail count lives only in the summary/grading.json.
   * Harness-broke codes (1/2/3) are unaffected either way.
   */
  tolerateEvalFailure?: boolean;
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

/**
 * Built-in cost/runtime safety ceilings applied PER executor/grader spawn. These
 * are the SAME values the harness applies as defaults, but exported as an explicit cap so
 * the CLI precedence layer (run.ts) can enforce a critical asymmetry:
 *
 *   - a CLI flag (explicit operator intent, typed at the terminal for THIS run)
 *     may RAISE a knob above the built-in ceiling;
 *   - a value sourced from a committed `test.*` config (which rides along in an
 *     untrusted subject repo you may only be testing) may only LOWER a ceiling,
 *     never raise it — so cloning + testing a hostile skill can't silently
 *     escalate the $5 / 50-turn / 5-minute budget the run bills against.
 *
 * `timeoutSeconds` is expressed in seconds to match the `--timeout`/`test.timeout`
 * unit (the harness multiplies by 1000 internally; see resolveTimeoutMs).
 */
export const SKILL_TEST_BUILTIN_CAPS = {
  maxTurns: DEFAULT_MAX_TURNS,
  maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
  timeoutSeconds: DEFAULT_TIMEOUT_MS / 1000,
} as const;

/**
 * Resolve the effective PER-EVAL wall-clock timeout (ms). Each executor and
 * grader spawn is an independent, bounded-parallel unit (issue #145), so the
 * budget is a flat per-spawn ceiling — NOT scaled by the suite size the way the
 * old single serial run's budget was. An explicit `--timeout` (seconds)
 * wins; otherwise the flat {@link DEFAULT_TIMEOUT_MS} default applies.
 */
export function resolveTimeoutMs(opts: RunHarnessOptions): number {
  return opts.timeout === undefined ? DEFAULT_TIMEOUT_MS : opts.timeout * 1000;
}

/**
 * Map an eval verdict to a process exit code. Default behavior (fail-closed): a
 * failing verdict escalates to EvalFailure (4) — distinct from the harness-broke
 * codes (1/2/3) so a CI consumer can `case $? in 0);; 4) tolerate;; *) hard fail;; esac`.
 * When `tolerateEvalFailure` is set (interactive opt-out), a failing verdict is
 * downgraded to Ok (0) and the count lives only in the summary/grading.json.
 */
export function verdictExitCode(allPassed: boolean, tolerateEvalFailure: boolean): SkillTestExitCodeValue {
  return !allPassed && !tolerateEvalFailure ? SkillTestExitCode.EvalFailure : SkillTestExitCode.Ok;
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
  optional?: true,
): StageItem {
  const pluginLayout = detectItemPluginLayout(source, repoRoot);
  return {
    name,
    source,
    ...(role === undefined ? {} : { role }),
    ...(pluginLayout === undefined ? {} : { pluginLayout }),
    ...(optional === undefined ? {} : { optional }),
  };
}

/**
 * Build the full set of items `stageHarness` will stage: the subject, every
 * REQUIRED `--with` companion, and every OPTIONAL `--with-optional` companion.
 * Both `with` and `optional` STAGE the named companion and make it invocable —
 * they differ only in required-vs-optional resolution (issue #153; a `--with`
 * name that named no positional skill used to be silently dropped, never staged,
 * no manifest trace). Fail-closed on a DUPLICATE staged name (subject / `with` /
 * `optional` all share one namespace): the first repeat throws
 * {@link DuplicateStagedSkillError} rather than silently letting a later item
 * clobber an earlier one under the same staged slot.
 */
export function buildStageItems(opts: RunHarnessOptions, repoRoot: string): StageItem[] {
  const items: StageItem[] = [];
  const seen = new Set<string>();

  const pushItem = (item: StageItem): void => {
    if (seen.has(item.name)) {
      throw new DuplicateStagedSkillError(item.name);
    }
    seen.add(item.name);
    items.push(item);
  };

  pushItem(makeStageItem(opts.subject, opts.subjectSource ?? { path: opts.subject }, repoRoot, 'subject'));

  if (opts.withSources !== undefined) {
    for (const [name, spec] of Object.entries(opts.withSources)) {
      pushItem(makeStageItem(name, descriptorToSource(spec), repoRoot, undefined));
    }
  }

  if (opts.withOptional !== undefined) {
    for (const [name, spec] of Object.entries(opts.withOptional)) {
      pushItem(makeStageItem(name, descriptorToSource(spec), repoRoot, undefined, true));
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
      // this package — the grader rubric (agents/grader.md) each grader spawn is
      // told to judge against. A missing, unparseable, or mutated manifest fails preflight (exit 2).
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

/**
 * The single source of truth for "is this run acknowledged?": a dry-run never
 * executes skill code (so it is implicitly acknowledged), otherwise the caller
 * must pass --i-understand-this-runs-skill-code. Narrowed to the two fields it
 * reads so run.ts can reuse the SAME predicate to gate the pre-build ack check
 * (the harness Step-6 check and the run.ts pre-build check cannot diverge).
 */
export function isAcknowledged(
  opts: Pick<RunHarnessOptions, 'dryRun' | 'acknowledgedRunsSkillCode'>,
): boolean {
  return opts.dryRun === true || opts.acknowledgedRunsSkillCode === true;
}

/**
 * Format a friction report for human consumption — one line per entry as
 * `[<severity>] <category>: <message>`. Pure; returns the empty string for no
 * entries so the caller can skip emitting anything.
 */
export function formatFrictionReport(items: readonly FrictionItem[]): string {
  return items.map(i => `[${i.severity}] ${i.category}: ${i.message}`).join('\n');
}

/**
 * Read the run's friction.json (if present + valid) and echo a concise report to
 * STDERR so users don't miss packaging-fidelity friction VAT merged from the grader
 * fragments (it is otherwise only written to disk). Best-effort: a missing, unparseable, or
 * empty report emits nothing. Never touches stdout (which stays machine-readable).
 * Accepts `undefined` (a no-op) so the harness `finally` can call it unconditionally
 * even when a throw preempted assignment of the friction path.
 */
function emitFrictionReport(frictionPath: string | undefined): void {
  if (frictionPath === undefined) return;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
  if (!existsSync(frictionPath)) return;
  let raw: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
    raw = JSON.parse(readFileSync(frictionPath, 'utf-8'));
  } catch {
    return;
  }
  const parsed = FrictionReportSchema.safeParse(raw);
  if (!parsed.success || parsed.data.items.length === 0) return;
  process.stderr.write(`\nPackaging friction (${parsed.data.items.length}):\n`);
  process.stderr.write(formatFrictionReport(parsed.data.items) + '\n');
}

/**
 * Name any optional companions (`--with-optional`/config `optional:`) that were
 * skipped because their source could not be resolved — never silently, so the
 * run's staged skill set stays legible. No-op when none were skipped. (Required
 * `--with` companions instead propagate a fatal resolve error from stageHarness.)
 */
function emitSkippedOptionalWarning(skippedOptional: string[]): void {
  if (skippedOptional.length === 0) return;
  process.stderr.write(
    `warning: optional companion skill(s) not staged (source unresolvable): ${skippedOptional.join(', ')}\n`,
  );
}

/**
 * Resolve the PERSISTENT location where a bootstrap scaffold should be written
 * so "fill it in and re-run" actually works for the user (the staged copy is
 * ephemeral). When the subject is a local `{path}` source we scaffold next to
 * that real source dir; otherwise we anchor under the repo root by skill name.
 */
/** The subject skill's display name (trailing segment of the subject arg). */
export function subjectSkillName(opts: RunHarnessOptions): string {
  return basename(toForwardSlash(opts.subject)) || opts.subject;
}

export function resolveScaffoldEvalsPath(opts: RunHarnessOptions, repoRoot: string, evalsSubpath: string): string {
  // Prefer the explicit authored source dir resolved by run.ts (the staged/built
  // tree is ephemeral; this is where the user can edit the scaffolded template).
  if (opts.subjectScaffoldDir !== undefined) {
    return safePath.join(opts.subjectScaffoldDir, evalsSubpath);
  }
  const subjectName = opts.subject;
  const override = opts.withSources?.[subjectName];
  const overridePath = override && 'path' in override ? override.path : undefined;
  // Default (no override) resolution treats the positional name as a path.
  const sourcePath = overridePath ?? subjectName;
  // eslint-disable-next-line local/no-unsafe-root-join -- the positional skill source may be an absolute path; resolving it against repoRoot (which returns an absolute sourcePath unchanged) is intentional, documented behavior, not a containment bug.
  const sourceDir = safePath.resolve(repoRoot, sourcePath);
  return safePath.join(sourceDir, evalsSubpath);
}

/**
 * Bootstrap (exit 3) — called when the eval suite is absent everywhere. A real run
 * writes a persistent template at the source scaffold location and reports it; a dry
 * run must never touch the filesystem, so it reports where a real run *would*
 * scaffold and writes nothing. Both surface the same exit-3 BootstrapNeededError.
 * Always throws.
 */
function bootstrapEvalSuite(opts: RunHarnessOptions, repoRoot: string, evalsSubpath: string): never {
  const scaffoldPath = resolveScaffoldEvalsPath(opts, repoRoot, evalsSubpath);
  if (opts.dryRun === true) {
    throw new BootstrapNeededError(scaffoldPath, { dryRun: true });
  }
  throw new BootstrapNeededError(writeEvalsTemplate(scaffoldPath, subjectSkillName(opts)));
}

/**
 * The vat-only directory a subject's eval suite is relocated to when the resolved
 * artifact is the only place it exists (npm/url/vendored, or a source tree that
 * ships its own evals). Deliberately OUTSIDE the harness root — the harness root is
 * the executor's sandbox, and the suite is the answer key to the task the executor
 * is performing. Created 0700 and removed in the run's cleanup, exactly like
 * {@link resolveGraderOutDir}. Pure (derives a path only).
 */
export function resolveEvalSuiteHoldDir(dirToken: string): string {
  return safePath.join(normalizedTmpdir(), `vat-skill-evals-${dirToken}`);
}

/**
 * Locate the eval suite the run will read, WITHOUT it ever being reachable by the
 * executor. Precedence, and why:
 *
 * 1. **The authored source** (`subjectScaffoldDir`, else the subject path). This is
 *    the copy a developer edits, so a re-run always reflects the edit — even under
 *    `--no-build`, where the built dist's copy could be stale.
 * 2. **The vat-only hold dir**, when staging harvested a suite that exists nowhere
 *    else (a fetched artifact). Its layout mirrors an authored evals dir, so
 *    `fixtures/` resolve relative to it unchanged.
 * 3. Neither → `undefined`, and the caller bootstraps a template (exit 3).
 *
 * Returns the suite's absolute path; its `dirname` is the base for each eval's
 * declared input `files`.
 */
export function resolveEvalSuitePath(input: {
  opts: RunHarnessOptions;
  repoRoot: string;
  evalsSubpath: string;
  holdDir: string;
  subjectEvalSuiteHeld: boolean;
}): string | undefined {
  const authored = resolveScaffoldEvalsPath(input.opts, input.repoRoot, input.evalsSubpath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- authored source path resolved from opts
  if (existsSync(authored)) return authored;
  if (!input.subjectEvalSuiteHeld) return undefined;
  return safePath.join(input.holdDir, basename(input.evalsSubpath));
}

/** Parse the staged eval suite and materialize each eval's input `files` into
 * `<harnessRoot>/workspaces/<id>/`. Returns the workspaces root, the parsed
 * {@link EvalSuite} (so the eval loop has the entries without re-reading), and the
 * declared eval count (derived from the suite). The dir is wiped first so a reused
 * harness root cannot leak a prior run's inputs. Throws {@link EvalInputError}
 * (mapped by the caller to exit 2) on a bad suite or a missing input file. */
export function stageWorkspacesForRun(
  evalsPath: string,
  harnessRoot: string,
): { workspacesRoot: string; declaredEvalCount: number; suite: EvalSuite } {
  const workspacesRoot = safePath.joinUnderRoot(harnessRoot, 'workspaces');
  rmSync(workspacesRoot, { recursive: true, force: true });
  mkdirSyncReal(workspacesRoot, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- evalsPath is our staged-subject path
  const suite = parseEvalSuite(readFileSync(evalsPath, 'utf-8'));
  return {
    workspacesRoot: stageEvalWorkspaces({ suite, evalsDir: dirname(evalsPath), workspacesRoot }),
    declaredEvalCount: suite.evals.length,
    suite,
  };
}

/** Format the model flag string for logging and dry-run summary output. */
function buildModelFlag(model: string | undefined): string {
  return model === undefined ? '(no --model; claude default)' : `--model ${model}`;
}

/**
 * Wrap {@link stageWorkspacesForRun} for the orchestrator: returns the
 * `workspacesRoot` string on success, or a {@link RunHarnessResult} early-return
 * value when the suite is invalid or a declared input file is missing. Any other
 * error is re-thrown so it propagates as an InternalHarnessError upstream.
 * Keeping the try/catch in a private helper avoids inflating the orchestrator's
 * cognitive complexity.
 */
function attemptStageWorkspaces(
  evalsPath: string,
  harnessRoot: string,
): { workspacesRoot: string; declaredEvalCount: number; suite: EvalSuite } | RunHarnessResult {
  try {
    return stageWorkspacesForRun(evalsPath, harnessRoot);
  } catch (e) {
    if (e instanceof EvalInputError) {
      return {
        harnessPath: harnessRoot,
        exitCode: SkillTestExitCode.Preflight,
        summary: `Eval input error:\n  ${e.message}`,
      };
    }
    throw e;
  }
}

/**
 * Advisory (never-fatal) lint pass over the parsed suite: nudges authors away
 * from presence-only expectations ("mentions/includes …") that a hallucinated
 * or wrong-for-the-right-reason answer could still satisfy (issue #145
 * follow-up). Purely additive stderr noise, emitted before any spawn — never
 * affects exitCode. Extracted so the Step 5.5 call site stays a single line
 * (keeps the orchestrator's cognitive complexity budget).
 */
function emitEvalLintWarnings(evals: EvalEntry[], declaredExecutableNames: string[]): void {
  for (const lintWarning of lintEvalExpectations(evals)) {
    process.stderr.write(`warning: ${lintWarning.message}\n`);
  }
  // Undeclared-executable lint (adopter follow-up): a toolExpectation naming a
  // typo of a declared executable would silently never match — flag it before spend.
  for (const lintWarning of lintToolExpectationExecutables(evals, declaredExecutableNames)) {
    process.stderr.write(`warning: ${lintWarning.message}\n`);
  }
}

interface ResolveDeclaredChildEnvInput {
  opts: RunHarnessOptions;
  resolvedAuth: ResolvedAuth;
  subjectStagedDir: string;
  harnessRoot: string;
  resultsDir: string;
  evalsSubpath: string;
  subjectPluginRoot: string | null;
}

/**
 * Assemble the EXECUTOR's child env: the scrubbed forwarded env unioned with the
 * declared test env (Features A + B) and CLAUDE_PLUGIN_ROOT, then emit the
 * transparency line and any protected-key collision warnings to stderr. The
 * caller guards `resolvedAuth` non-null (a null after a passed preflight is an
 * internal invariant violation), never falling back to process.env — which would
 * hand untrusted skill code every secret it contains.
 */
function resolveDeclaredChildEnv(input: ResolveDeclaredChildEnvInput): ReturnType<typeof assembleChildEnv> {
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
// Dry-run summary builder (pure — exported for unit tests)
// ---------------------------------------------------------------------------

/** Inputs for the dry-run summary string. */
export interface DryRunSummaryInput {
  /** True when the resolved subject is buildable (a real run would build + stage it). */
  wouldBuild: boolean;
  /**
   * When wouldBuild is true: true = the dry-run staged the existing dist without
   * rebuilding (may be stale); false = no dist existed, fell back to source dir.
   */
  dryRunStagedExistingDist?: boolean;
  /** Absolute path to the written provenance.json (already on disk). */
  provenancePath: string;
  /** Content fingerprint from the staged manifest. */
  provenanceFingerprint: string;
  /** Number of entries in the staged manifest. */
  provenanceEntryCount: number;
  /** The assembled model flag string for the executor (e.g. `--model claude-opus-4-8`). */
  modelFlag: string;
  /** Number of declared evals a real run would execute. */
  evalCount: number;
  /** Bounded-parallel executor→grader pipeline width a real run would use. */
  concurrency: number;
  /** Pinned grader/judge model a real run would grade with. */
  graderModel: string;
}

/**
 * Build the "stale dist" warning lines for a `--dry-run` preview that staged an
 * EXISTING built dist WITHOUT rebuilding it (source may have moved on since).
 * The ONE construction shared by {@link buildDryRunSummary} (the SUBJECT, no
 * `roleLabel`: "This preview…") and `resolveCompanionSpec` in the CLI's run.ts
 * (a COMPANION, `roleLabel` set to e.g. "companion 'foo' (declared skill
 * 'bar')": "This preview of companion 'foo' (declared skill 'bar')…") — the
 * identical fact (a stale dist previewed) must warn EITHER role, worded so two
 * stale warnings in one run are distinguishable. Keeping it as one construction is
 * the point: when the warning existed only inside the subject's summary, a
 * companion previewed from a stale dist warned nobody while the subject warned
 * loudly for the same fact. Exported so run.ts reuses this construction rather
 * than copying the string.
 */
export function buildStaleDistWarningLines(roleLabel?: string): string[] {
  const subject = roleLabel === undefined ? 'This preview' : `This preview of ${roleLabel}`;
  return [
    `[dry-run] WARNING: ${subject} used the EXISTING built dist WITHOUT rebuilding — it may be STALE.`,
    '[dry-run] Run `vat build` before testing to ensure the preview reflects current source.',
  ];
}

/**
 * Build the dry-run summary string. Pure function so it can be unit-tested
 * without running the full harness.
 *
 * The summary covers three scenarios:
 *   1. Declared (buildable) subject — no dist existed, fell back to source dir.
 *   2. Declared (buildable) subject — existing dist was staged WITHOUT rebuilding
 *      (potentially stale).
 *   3. Plain source subject — staged as-is, no build step.
 *
 * Always includes the assembled spawn command, the staged-manifest entry count +
 * fingerprint, and the provenance.json path so a stale tree is visible at a glance.
 */
export function buildDryRunSummary(input: DryRunSummaryInput): string {
  const lines: string[] = [];

  if (input.wouldBuild) {
    lines.push(
      '[dry-run] A real run would: build + stage the declared skill, then spawn claude.',
    );
    if (input.dryRunStagedExistingDist === true) {
      lines.push(...buildStaleDistWarningLines());
    } else if (input.dryRunStagedExistingDist === false) {
      lines.push(
        '[dry-run] No built dist exists yet; this preview fell back to the source dir.',
      );
    }
  } else {
    lines.push(
      '[dry-run] A real run would: stage the source dir as-is, then spawn claude.',
    );
  }

  const count = input.provenanceEntryCount;
  lines.push(
    `[dry-run] Would run ${input.evalCount} eval${input.evalCount === 1 ? '' : 's'} as executor→grader spawn ` +
      `pair${input.evalCount === 1 ? '' : 's'} at concurrency ${input.concurrency}.`,
    `[dry-run] Executor ${input.modelFlag}; grader model ${input.graderModel} (prompt via stdin).`,
    `[dry-run] Staged manifest: ${count} entr${count === 1 ? 'y' : 'ies'} | fingerprint: ${input.provenanceFingerprint}`,
    `[dry-run] Provenance: ${input.provenancePath}`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Harness cleanup
// ---------------------------------------------------------------------------

export interface CleanupHarnessOptions {
  /** User asked to retain the harness dir (`--keep`) — never remove. */
  keep: boolean;
  /**
   * True only when the harness itself created the dir under the OS tmp dir (no
   * `--out`/`--workdir`). A user-supplied location is theirs to keep, so we only
   * auto-remove the dir we created.
   */
  created: boolean;
}

/**
 * Remove the harness directory after a run so staged untrusted skill bytes and
 * prompts do not accumulate in OS tmp. No-op when the user asked to keep it, when
 * the dir is a user-supplied location (`--out`/`--workdir`), or when it is already
 * gone. Idempotent and never throws — it runs from a `finally`, so it must not
 * mask the run's real outcome.
 *
 * SAFETY: re-asserts the root is not a symlink immediately before removal (via
 * `lstat`, which does NOT follow the link). A root swapped to a symlink between
 * the run and cleanup is left in place rather than followed — `rmSync(recursive)`
 * could otherwise delete the symlink's target outside tmp.
 */
export function cleanupHarness(harnessRoot: string, opts: CleanupHarnessOptions): void {
  if (opts.keep || !opts.created) return;
  // Best-effort: cleanup runs from a `finally`, so a TOCTOU race (the dir is
  // reaped between checks) or a permission error must never throw out and mask
  // the run's real outcome. Worst case is a leftover 0700 tmp dir, not a failure.
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
    if (!existsSync(harnessRoot)) return;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
    if (lstatSync(harnessRoot).isSymbolicLink()) return;
    rmSync(harnessRoot, { recursive: true, force: true });
  } catch {
    // Swallow: a failed cleanup is not a run failure.
  }
}

// ---------------------------------------------------------------------------
// Per-eval pipeline (vat-owned executor → grader)
// ---------------------------------------------------------------------------

/** One unit of executor→grader work: an eval + which arm (with/without skill). */
export interface EvalWorkItem {
  entry: EvalEntry;
  arm: 'with' | 'without';
}

/**
 * Build the per-eval work items for a set of evals (one tier's worth, or a whole
 * suite). Every eval gets a WITH arm (skill present). When `baseline` is set,
 * every eval ALSO gets a WITHOUT arm (skill absent) so vat can record an
 * informational A/B — the WITHOUT arm never contributes to the pass/fail verdict
 * (see {@link partitionFragmentsByArm}) and never drives tier gating. Pure +
 * unit-testable.
 */
export function buildEvalWorkItems(evals: readonly EvalEntry[], baseline: boolean): EvalWorkItem[] {
  const items: EvalWorkItem[] = [];
  for (const entry of evals) {
    items.push({ entry, arm: 'with' });
    if (baseline) items.push({ entry, arm: 'without' });
  }
  return items;
}

/**
 * Partition graded fragments into the WITH arm (the authoritative verdict +
 * grading.json) and the WITHOUT arm (baseline.json, informational only). A
 * fragment with no `arm` (or `arm: 'with'`) is a WITH-arm fragment. Pure +
 * unit-testable.
 */
export function partitionFragmentsByArm(fragments: EvalFragment[]): {
  withArm: EvalFragment[];
  withoutArm: EvalFragment[];
} {
  const withArm: EvalFragment[] = [];
  const withoutArm: EvalFragment[] = [];
  for (const fragment of fragments) {
    if (fragment.arm === 'without') withoutArm.push(fragment);
    else withArm.push(fragment);
  }
  return { withArm, withoutArm };
}

/**
 * The vat-only grader dir for a run: `<tmp>/vat-skill-grade-<dirToken>/`. It is
 * deliberately OUTSIDE the harness root (the skill's `--add-dir` sandbox) and
 * created 0700, so it is invisible to Claude's own permission model and to any
 * OTHER OS user. Pure (derives a path only).
 *
 * SCOPE OF THE GUARANTEE — read honestly. `--add-dir`/`bypassPermissions` is
 * Claude's permission model, NOT an OS sandbox: the executor's skill code runs
 * as the SAME OS uid as vat, so it CAN read a 0700 dir this process owns. The
 * layered defenses here — dir outside the sandbox, named by an unpredictable
 * `dirToken` (distinct from the integrity nonce, which never touches the dir
 * name or any argv and travels only via grader stdin), the nonce echoed back
 * per fragment, and each fragment file unlinked the instant vat reads it — RAISE
 * THE BAR against same-uid forgery (a forger must now win a per-fragment
 * read→overwrite race against a secret it cannot predict, with no persisted copy
 * to harvest at leisure). They do NOT amount to true isolation from same-uid
 * code. The complete fix is running the grader under a SEPARATE OS uid /
 * container; that is tracked as a follow-up (see CHANGELOG "Security" notes) and
 * is the only thing that closes the residual race outright.
 */
export function resolveGraderOutDir(dirToken: string): string {
  return safePath.join(normalizedTmpdir(), `vat-skill-grade-${dirToken}`);
}

/**
 * The executor working directory for one eval: its staged input workspace
 * `<workspacesRoot>/<id>` when the eval declares input `files`, else undefined
 * (the executor then defaults to the staged subject dir). Pure + unit-testable.
 */
export function resolvePerEvalWorkspaceDir(entry: EvalEntry, workspacesRoot: string): string | undefined {
  if (entry.files === undefined || entry.files.length === 0) return undefined;
  return safePath.joinUnderRoot(workspacesRoot, String(entry.id));
}

/**
 * Best-effort removal of a vat-only tmp dir that lives OUTSIDE the harness root —
 * the grader fragment dir and the held eval suite. Never throws (it runs from
 * cleanup, where masking the run's real outcome would be worse than a leftover 0700
 * tmp dir) and refuses to follow a symlinked root.
 */
export function removeVatOnlyDir(dir: string | undefined): void {
  if (dir === undefined) return;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived vat-only tmp dir
    if (!existsSync(dir)) return;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived vat-only tmp dir
    if (lstatSync(dir).isSymbolicLink()) return;
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Swallow: a failed cleanup is not a run failure.
  }
}

/** Everything one executor→grader pipeline worker needs, built once per run. */
interface EvalRunContext {
  subjectStagedDir: string;
  workspacesRoot: string;
  pluginDirs: string[];
  graderOutDir: string;
  runNonce: string;
  graderModel: string;
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  stallMs?: number;
  /** Full assembled env (skill secrets included) for the executor spawn. */
  executorEnv: NodeJS.ProcessEnv;
  /** AUTH-ONLY env for the grader spawn (trusted vat infra loads no skill). */
  graderEnv: NodeJS.ProcessEnv;
  /** Declared executables (WITH-arm grader recognition aid); absent when unreachable. */
  declaredExecutables?: Array<{ name: string; howInvoked: string; kind: string }>;
  spawn?: typeof spawnHeadlessClaude;
  /** Shared spend accumulator — each worker folds in its executor + grader session cost. */
  costAccumulator: RunCostSummary;
}

/**
 * Run ONE work item: the blind executor spawn, then the grader spawn over its
 * captured transcript (issue #145). Returns the grader fragment tagged with the
 * item's arm. The WITHOUT arm runs the executor with `pluginDirs: []` (skill
 * absent). Grader fragments are written under a PER-ARM subdir of the vat-only
 * grader dir so a WITH and WITHOUT run of the same eval id cannot collide.
 *
 * Throws propagate: an executor/grader {@link InternalHarnessError} (timeout,
 * stall, spawn error, grader failure/missing-fragment) fails the whole run
 * (exit 1); a RateLimitSignal is retried by the pipeline. An executor CLEAN
 * failure is NOT thrown — its transcript flows into the grader, whose failing
 * fragment surfaces as an eval failure (exit 4 via the verdict), never exit 1.
 */
async function runEvalWorker(item: EvalWorkItem, ctx: EvalRunContext): Promise<EvalFragment> {
  const evalId = String(item.entry.id);
  const workspaceDir = resolvePerEvalWorkspaceDir(item.entry, ctx.workspacesRoot);
  const onProgress = (chunk: string): void => { process.stderr.write(chunk); };

  const outcome = await runExecutorForEval({
    evalId,
    task: item.entry.prompt,
    subjectStagedDir: ctx.subjectStagedDir,
    ...(workspaceDir === undefined ? {} : { workspaceDir }),
    pluginDirs: item.arm === 'without' ? [] : ctx.pluginDirs,
    env: ctx.executorEnv,
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
    maxTurns: ctx.maxTurns,
    maxBudgetUsd: ctx.maxBudgetUsd,
    timeoutMs: ctx.timeoutMs,
    ...(ctx.stallMs === undefined ? {} : { stallMs: ctx.stallMs }),
    ...(ctx.spawn === undefined ? {} : { spawn: ctx.spawn }),
    onProgress,
  });
  recordSessionCost(ctx.costAccumulator, outcome.parsed.result?.totalCostUsd);

  // Tool expectations are about the SKILL's tools, so they ride the WITH arm ONLY —
  // the WITHOUT (skill-absent) arm has no skill, hence nothing to judge tools against.
  const isWithArm = item.arm === 'with';
  const fragment = await runGraderForEval({
    evalId,
    transcript: outcome.transcript,
    expectations: item.entry.expectations,
    ...(item.entry.expected_output === undefined ? {} : { expectedOutput: item.entry.expected_output }),
    ...(isWithArm && item.entry.toolExpectations !== undefined
      ? { toolExpectations: item.entry.toolExpectations }
      : {}),
    ...(isWithArm && ctx.declaredExecutables !== undefined
      ? { declaredExecutables: ctx.declaredExecutables }
      : {}),
    rubricPath: GRADER_RUBRIC_PATH,
    graderOutDir: safePath.joinUnderRoot(ctx.graderOutDir, item.arm),
    graderModel: ctx.graderModel,
    nonce: ctx.runNonce,
    maxTurns: ctx.maxTurns,
    maxBudgetUsd: ctx.maxBudgetUsd,
    timeoutMs: ctx.timeoutMs,
    ...(ctx.stallMs === undefined ? {} : { stallMs: ctx.stallMs }),
    env: ctx.graderEnv,
    ...(ctx.spawn === undefined ? {} : { spawn: ctx.spawn }),
    onProgress,
    costSink: (usd) => recordSessionCost(ctx.costAccumulator, usd),
  });

  return { ...fragment, arm: item.arm };
}

/** Outcome of a tier-ordered eval run: the fragments that RAN, plus (when the
 *  fail-fast gate fired with higher tiers pending) which tiers were SKIPPED. */
interface TieredEvalRun {
  fragments: EvalFragment[];
  skipped?: SkippedEvalsSummary;
}

interface RunEvalsTieredInput {
  /** All evals in the suite (grouped by tier internally). */
  evals: readonly EvalEntry[];
  /** Whether to also run each eval's WITHOUT (baseline) arm. */
  baseline: boolean;
  /** Run one tier's work items bounded-parallel and return their graded fragments. */
  runTier: (items: EvalWorkItem[]) => Promise<EvalFragment[]>;
}

/**
 * Run evals TIER by TIER (ascending), bounded-parallel WITHIN each tier, with a
 * GATE between tiers (issue #145 Phase G). After a tier completes, apply the
 * default gate policy ({@link shouldGateAfterTier}) over that tier's WITH-arm
 * fragments: if any eval in the tier did not fully pass, do NOT launch the higher
 * (more expensive) tiers — their evals are recorded as SKIPPED (a distinct state,
 * never counted as passed) so the run stops spending once a cheaper tier already
 * failed. In-flight policy: the tier's own running evals finish (awaited by
 * `runTier`) BEFORE the gate is checked, so we never launch the next tier once we
 * decide to stop. The WITHOUT (baseline) arm rides alongside its WITH arm but does
 * not drive the gate — gating is about the WITH-arm skill behavior only.
 */
async function runEvalsTiered(input: RunEvalsTieredInput): Promise<TieredEvalRun> {
  const groups = groupEvalsByTier(input.evals);
  const fragments: EvalFragment[] = [];
  for (const [index, group] of groups.entries()) {
    const tierFragments = await input.runTier(buildEvalWorkItems(group.evals, input.baseline));
    fragments.push(...tierFragments);
    const withArm = tierFragments.filter((f) => f.arm !== 'without');
    if (!shouldGateAfterTier(withArm)) continue;
    const remaining = groups.slice(index + 1);
    if (remaining.length === 0) break;
    const skipped = buildSkippedSummary(group.tier, remaining);
    // Legibility (required): name the skipped tiers on stderr so a fail-fast run is
    // never mistaken for a smaller passing suite. stdout stays machine-readable.
    process.stderr.write(formatSkippedTiersSummary(skipped) + '\n');
    return { fragments, skipped };
  }
  return { fragments };
}

/** The results/ artifacts vat is the SOLE writer of, resolved for one run. */
export interface ArtifactPaths {
  gradingOut: string;
  frictionOut: string;
  baselineOut: string;
  toolEvalOut: string;
}

/** Resolve the run's grading/friction/baseline/tool-eval artifact paths under
 *  `resultsDir`. Single source of truth for the filenames (used by the
 *  pre-pipeline stale wipe AND the post-merge writer). */
export function resolveArtifactPaths(resultsDir: string): ArtifactPaths {
  return {
    gradingOut: safePath.join(resultsDir, 'grading.json'),
    frictionOut: safePath.join(resultsDir, 'friction.json'),
    baselineOut: safePath.join(resultsDir, 'baseline.json'),
    toolEvalOut: safePath.join(resultsDir, 'tool-eval.json'),
  };
}

/**
 * Remove any PRIOR run's artifacts before this run writes its own. The harness
 * root is deterministic per skill-set and reused across runs (`--keep`/`--out`, or
 * after a crash/SIGKILL that preempted cleanup), so a stale grading/friction/
 * baseline/tool-eval.json can otherwise survive into a run that throws BEFORE the merge —
 * where the `finally` would then echo the PRIOR run's friction as if it were this
 * run's. Wiping all three up front closes that cross-run leak. Best-effort
 * (`force: true`) — a missing file is fine.
 */
export function wipeStaleArtifacts(paths: ArtifactPaths): void {
  rmSync(paths.gradingOut, { force: true });
  rmSync(paths.frictionOut, { force: true });
  rmSync(paths.baselineOut, { force: true });
  rmSync(paths.toolEvalOut, { force: true });
}

/**
 * Merge the run's grader fragments and WRITE the run artifacts (vat is the SOLE
 * writer): grading.json from the WITH-arm fragments, friction.json from ALL
 * fragments, tool-eval.json from the WITH-arm fragments' `tool` verdicts (a
 * SEPARATE channel — C2; the WITHOUT arm carries no toolExpectations), and — only
 * when a WITHOUT arm ran (baseline) — baseline.json from the WITHOUT-arm fragments
 * (informational A/B, never part of the verdict). Stale copies from a reused harness
 * were already removed by {@link wipeStaleArtifacts} pre-pipeline. Returns the
 * reconciled prose-expectation verdict AND the merged tool-eval report so the caller
 * can compute the COMPOSITE verdict. Every fragment's per-run nonce is re-verified
 * inside {@link mergeFragmentsToGrading}.
 */
function writeRunArtifactsAndReconcile(
  fragments: EvalFragment[],
  runNonce: string,
  paths: ArtifactPaths,
): { verdict: GradingVerdict; toolEval: ToolEvalReport } {
  const { withArm, withoutArm } = partitionFragmentsByArm(fragments);

  const grading = mergeFragmentsToGrading(withArm, runNonce);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
  writeFileSync(paths.gradingOut, JSON.stringify(grading, null, 2) + '\n', 'utf-8');

  const friction = mergeFragmentsToFriction(fragments);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
  writeFileSync(paths.frictionOut, JSON.stringify(friction, null, 2) + '\n', 'utf-8');

  // Tool verdicts come from the WITH arm ONLY — the WITHOUT/skill-absent arm never
  // carries toolExpectations, so its fragments have no `tool` body to merge.
  const toolEval = mergeFragmentsToToolEval(withArm);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
  writeFileSync(paths.toolEvalOut, JSON.stringify(toolEval, null, 2) + '\n', 'utf-8');

  if (withoutArm.length > 0) {
    const baseline = mergeFragmentsToGrading(withoutArm, runNonce);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
    writeFileSync(paths.baselineOut, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
  }

  return { verdict: reconcileGrading(grading), toolEval };
}

/**
 * The COMPOSITE run verdict (issue #145 Phase T): the run passes only when BOTH
 * the prose-expectation grading passed AND every tool-expectation verdict passed.
 * Tool verdicts live in tool-eval.json (a SEPARATE channel — C2); this combines
 * the two at the exit-code layer WITHOUT mixing the channels' data. When no eval
 * declared `toolExpectations`, `toolEval.evals` is empty and this equals
 * `outputAllPassed`. Pure + unit-testable.
 */
export function computeCompositeVerdict(outputAllPassed: boolean, toolEval: ToolEvalReport): boolean {
  return outputAllPassed && toolEval.evals.every((v) => v.passed);
}

/**
 * The run's final pass/fail after cost-tiered fail-fast: the {@link
 * computeCompositeVerdict} of the tiers that RAN, AND no tiers were skipped. A
 * fail-fast run that gated higher tiers is NEVER a pass (skipped ≠ passed) — this
 * forces `false` so the exit code is EvalFailure (4), never downgraded to 0 by the
 * composite path alone. Pure + unit-testable.
 */
export function resolveCompositeAllPassed(
  outputAllPassed: boolean,
  toolEval: ToolEvalReport,
  skipped: SkippedEvalsSummary | undefined,
): boolean {
  return computeCompositeVerdict(outputAllPassed, toolEval) && skipped === undefined;
}

/**
 * Running total of spend across every executor+grader session in a run (adopter
 * follow-up). `sessions` counts only sessions that REPORTED a `total_cost_usd`, so
 * `≈$${totalUsd} across ${sessions} sessions` is always internally consistent (the
 * sum is over exactly those sessions). Mutated in place by {@link recordSessionCost}
 * — safe under the cooperative (single-threaded) pipeline concurrency.
 */
export interface RunCostSummary {
  totalUsd: number;
  sessions: number;
}

/** Fold one session's `total_cost_usd` into the accumulator; a non-number (mock spawn / missing result) is ignored. */
export function recordSessionCost(acc: RunCostSummary, totalCostUsd: number | undefined): void {
  if (typeof totalCostUsd !== 'number' || !Number.isFinite(totalCostUsd)) return;
  acc.totalUsd += totalCostUsd;
  acc.sessions += 1;
}

/**
 * The ` | ≈$0.42 across 6 sessions` spend suffix for the summary line, or `''`
 * when no session reported a cost (e.g. every spawn was a test mock) so the suffix
 * never adds noise to a run with no cost signal. Pure + unit-testable.
 */
export function formatRunCostSuffix(cost: RunCostSummary | undefined): string {
  if (cost === undefined || cost.sessions === 0) return '';
  return ` | ≈$${cost.totalUsd.toFixed(2)} across ${cost.sessions} session${cost.sessions === 1 ? '' : 's'}`;
}

/**
 * The run's human summary line, computed from the COMPOSITE verdict so an
 * output-pass with a failing tool verdict still reads FAIL. The prose-expectation
 * counts (`passed/total`) come from the grading verdict; when any tool-expectation
 * verdict failed, a `(N tool)` suffix names how many — so a composite FAIL whose
 * OUTPUT counts look all-green (e.g. `FAIL 3/3 (1 tool)`) is self-explaining. Pure.
 */
export function buildRunSummary(
  verdict: GradingVerdict,
  toolEval: ToolEvalReport,
  compositeAllPassed: boolean,
): string {
  const base = `${compositeAllPassed ? 'PASS' : 'FAIL'} ${verdict.passed}/${verdict.total}`;
  const toolFailures = toolEval.evals.filter((v) => !v.passed).length;
  return toolFailures > 0 ? `${base} (${toolFailures} tool)` : base;
}

/**
 * The run summary line, appending the fail-fast SKIPPED note when the tier gate
 * stopped higher tiers. Legibility is required — the skipped tiers are named on
 * their own line, never silently dropped. Pure. Note that a run with skipped
 * tiers ALWAYS reads FAIL (skipped ≠ passed forces `compositeAllPassed` false at
 * the call site), so the base line is already FAIL when the note is present.
 */
export function buildRunSummaryWithSkips(
  verdict: GradingVerdict,
  toolEval: ToolEvalReport,
  compositeAllPassed: boolean,
  skipped: SkippedEvalsSummary | undefined,
  cost?: RunCostSummary,
): string {
  // The spend suffix rides the verdict line (like `(N tool)`); the skipped-tiers
  // note stays on its own following line.
  const base = buildRunSummary(verdict, toolEval, compositeAllPassed) + formatRunCostSuffix(cost);
  return skipped === undefined ? base : `${base}\n${formatSkippedTiersSummary(skipped)}`;
}

/**
 * D2 fail-closed gate: re-read ONE vat-written results artifact and assert it
 * exists, parses as JSON, and validates against its schema. vat is the SOLE writer
 * of everything under results/, so a missing/unparseable/invalid file here is a
 * HARNESS bug ({@link InternalHarnessError} → exit 1), never a skill fault. This is
 * safe precisely because vat always writes these after the merge succeeds.
 */
function assertVatWroteArtifact(path: string, validate: (raw: unknown) => void, label: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
  if (!existsSync(path)) {
    throw new InternalHarnessError(`vat did not write ${label} at ${path} after the merge — harness bug.`);
  }
  let raw: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new InternalHarnessError(
      `vat-written ${label} at ${path} is not valid JSON (harness bug): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    validate(raw);
  } catch (err) {
    throw new InternalHarnessError(
      `vat-written ${label} at ${path} failed its schema (harness bug): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Post-merge D2 gate over the vat-written results artifacts (vat is SOLE writer):
 * grading.json, friction.json, and tool-eval.json must each exist + parse + validate.
 * A separate, explicit check (NOT folded into any prompt-invariant linter) — fail-closed
 * and safe because vat wrote every one of these itself just above.
 */
function assertVatWroteArtifacts(paths: ArtifactPaths): void {
  assertVatWroteArtifact(paths.gradingOut, (raw) => { GradingReportSchema.parse(raw); }, 'grading.json');
  assertVatWroteArtifact(paths.frictionOut, (raw) => { FrictionReportSchema.parse(raw); }, 'friction.json');
  assertVatWroteArtifact(paths.toolEvalOut, (raw) => { ToolEvalReportSchema.parse(raw); }, 'tool-eval.json');
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

  const harnessRoot = opts.out ?? resolveHarnessRoot([opts.subject], opts.workdir);
  // Only auto-remove the dir the harness itself created under OS tmp. An explicit
  // --out (exact dir) or --workdir (user-chosen base) is a location the user owns;
  // treat it like --keep and never delete it.
  const harnessCreated = opts.out === undefined && opts.workdir === undefined;
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

  // Release the lock and remove the harness dir if the run is interrupted by
  // SIGINT/SIGTERM — a try/finally alone does not run on a signal, so without
  // this the lockfile (and staged bytes) would leak and break the next run.
  //
  // The vat-only grader dir lives OUTSIDE harnessRoot (forgery-proofing, see
  // resolveGraderOutDir) so cleanupHarness does not reach it — cleanup removes it
  // separately. Referenced via the mutable `graderOutDir` below so a signal that
  // fires mid-pipeline reaps it too, not just the normal finally.
  let graderOutDir: string | undefined;

  // The vat-only dir a harvested eval suite is held in. Like the grader dir it lives
  // OUTSIDE harnessRoot (the executor's sandbox) and is named by an unpredictable
  // token, so a suite that exists only inside a fetched artifact can still be READ by
  // the harness without the executor being able to read it. Created eagerly (empty
  // when the subject carried no suite, which is the common case) so the staging call
  // stays branch-free; removed by the same cleanup as the grader dir.
  const evalSuiteHoldDir = resolveEvalSuiteHoldDir(randomBytes(16).toString('hex'));

  const cleanup = (): void => {
    // Reap any still-in-flight executor/grader children FIRST. On the concurrent
    // error path `Promise.all` rejects without cancelling its siblings, and a
    // `process.exit` tears down their in-process watchdog timers — so without
    // this, up to `concurrency-1` detached `claude` sessions would be orphaned
    // and keep billing tokens. Kill them before removing the dirs they write to.
    // NOTE: the registry is a module-level singleton, so this assumes one run per
    // process (true for the CLI). A library embedding two concurrent runs in one
    // process would need per-run child scoping instead.
    killAllActiveClaudeChildren();
    lock.release();
    cleanupHarness(harnessRoot, { keep: opts.keep === true, created: harnessCreated });
    removeVatOnlyDir(graderOutDir);
    // The held eval suite is the answer key: reap it on EVERY exit path (including
    // --keep, which retains the harness dir for inspection but has no business
    // retaining the key), and never conditionally.
    removeVatOnlyDir(evalSuiteHoldDir);
  };
  const removeSignalCleanup = installSignalCleanup({ onSignal: cleanup });

  // Hoisted so the finally can surface packaging friction even when a throw
  // (a grader/executor failure, the per-fragment nonce guard, a spawn timeout)
  // preempts the normal verdict path. friction.json is written by VAT AFTER the
  // executor→grader pipeline merges the grader fragments — so it is present only
  // once merging succeeded; on a pre-merge throw the finally simply finds no
  // friction.json and emits nothing (a no-op).
  let frictionOut: string | undefined;

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
      evalsSubpath,
      evalSuiteHoldDir,
    });

    const { pluginDirs, subjectStagedDir, subjectPluginRoot, skippedOptional } = stageResult;
    emitSkippedOptionalWarning(skippedOptional);

    if (subjectStagedDir === null) {
      throw new InternalHarnessError('Staging did not yield a subject directory (no item tagged role:subject).');
    }

    // Step 4: Locate the eval suite. Staging has already stripped it out of every
    // staged tree — the answer key must never be reachable by the executor — so this
    // resolves to the AUTHORED source copy, or to the vat-only hold dir when the
    // suite existed nowhere but inside a fetched artifact. Absent from both →
    // bootstrap a template at the source scaffold and exit 3, so an authored suite
    // is never overwritten.
    const evalsPath =
      resolveEvalSuitePath({
        opts,
        repoRoot,
        evalsSubpath,
        holdDir: evalSuiteHoldDir,
        subjectEvalSuiteHeld: stageResult.subjectEvalSuiteHeld,
      }) ?? bootstrapEvalSuite(opts, repoRoot, evalsSubpath);

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

    // Step 5.5: Parse the eval suite and stage per-eval input workspaces. The
    // parsed suite is threaded on so the eval loop has the entries without
    // re-reading; declaredEvalCount is derived from it (suite.evals.length).
    const workspaceStageResult = attemptStageWorkspaces(evalsPath, harnessRoot);
    if ('exitCode' in workspaceStageResult) return workspaceStageResult;
    const { workspacesRoot, declaredEvalCount, suite } = workspaceStageResult;

    emitEvalLintWarnings(suite.evals, (opts.declaredExecutables ?? []).map((e) => e.name));

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

    // Step 7: Results dir + provenance. vat is the SOLE writer of everything under
    // results/ — grading.json/friction.json/baseline.json come from the merged
    // grader fragments below, never from the (untrusted) model.
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
    const provenancePath = safePath.join(resultsDir, 'provenance.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
    writeFileSync(
      provenancePath,
      JSON.stringify(provenance, null, 2) + '\n',
      'utf-8',
    );
    process.stderr.write(`Provenance: ${provenance.fingerprint}\n`);

    // Resolve the results/ artifact paths and WIPE any prior run's artifacts up
    // front: harnessRoot is deterministic and may be reused (--keep/--out, or after
    // a crash before cleanup), so a stale grading/friction/baseline.json must never
    // leak into — or be echoed by the finally on — this run. `frictionOut` is
    // hoisted so the finally can echo THIS run's friction (and only after the wipe).
    const artifacts = resolveArtifactPaths(resultsDir);
    wipeStaleArtifacts(artifacts);
    frictionOut = artifacts.frictionOut;

    // Step 7.5: Resolve the executor's declared test env (Features A + B). Token
    // resolution can hard-fail (exit 2) on an unknown ${token}; do it before the
    // dry-run short-circuit so a dry run validates interpolation too. resolvedAuth
    // must be non-null once preflight passed — a null would mean spawning with an
    // unscrubbed env, which we refuse (it would hand skill code every secret).
    const { resolvedAuth } = preflightResult;
    if (resolvedAuth === null) {
      throw new InternalHarnessError(
        'Internal: preflight passed but resolvedAuth is null — refusing to spawn with an unscrubbed environment.',
      );
    }
    const assembledEnv = resolveDeclaredChildEnv({
      opts,
      resolvedAuth,
      subjectStagedDir,
      harnessRoot,
      resultsDir,
      evalsSubpath,
      subjectPluginRoot,
    });

    // Resolve the run knobs: executor (subject) model, pinned grader model, and
    // pipeline width. graderModel is deliberately distinct from the subject model
    // so the judge stays comparable across runs.
    const graderModel = opts.graderModel ?? DEFAULT_GRADER_MODEL;
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    const modelFlag = buildModelFlag(knobs.model);
    process.stderr.write(`Model: ${knobs.model ?? '(claude default)'} | grader: ${graderModel}\n`);

    // Step 8: Dry-run short-circuit — return assembled info without spawning.
    if (opts.dryRun === true) {
      return {
        harnessPath: harnessRoot,
        exitCode: SkillTestExitCode.Ok,
        summary: buildDryRunSummary({
          wouldBuild: opts.wouldBuild === true,
          ...(opts.dryRunStagedExistingDist === undefined
            ? {}
            : { dryRunStagedExistingDist: opts.dryRunStagedExistingDist }),
          provenancePath,
          provenanceFingerprint: provenance.fingerprint,
          provenanceEntryCount: provenance.entries.length,
          modelFlag,
          evalCount: declaredEvalCount,
          concurrency,
          graderModel,
        }),
      };
    }

    // Step 9: Run the vat-owned executor→grader pipeline. ONE secret per-run nonce
    // is stamped into every grader prompt (via stdin) and re-verified per fragment
    // on merge — this is what distinguishes a fragment produced by a grader WE
    // prompted from one forged/left behind by untrusted skill code in the executor's
    // sandbox. The grader dir is created OUTSIDE harnessRoot (forgery-proof; see
    // resolveGraderOutDir) at 0700, and removed in the finally / on signal.
    //
    // The dir is named by an INDEPENDENT random token (graderDirToken), NOT the
    // nonce: the dir name and the grader's --add-dir argv are world-listable in the
    // shared OS temp dir, so encoding the secret nonce there would let same-user
    // skill code read it off `ls <tmp>` and forge a valid-nonce fragment. The nonce
    // is kept off disk / off argv — delivered to the grader only via its stdin prompt.
    const runNonce = randomBytes(16).toString('hex');
    const graderDirToken = randomBytes(16).toString('hex');
    graderOutDir = resolveGraderOutDir(graderDirToken);
    mkdirSyncReal(graderOutDir, { recursive: true, mode: 0o700 });

    // Run-wide spend accumulator: each worker folds in its executor + grader
    // session cost, surfaced as a `≈$X across N sessions` suffix on the summary.
    const costAccumulator: RunCostSummary = { totalUsd: 0, sessions: 0 };

    const evalCtx: EvalRunContext = {
      subjectStagedDir,
      workspacesRoot,
      pluginDirs,
      graderOutDir,
      runNonce,
      graderModel,
      costAccumulator,
      ...(knobs.model === undefined ? {} : { model: knobs.model }),
      maxTurns: knobs.maxTurns,
      maxBudgetUsd: knobs.maxBudgetUsd,
      timeoutMs: resolveTimeoutMs(opts),
      ...(knobs.stallMs === undefined ? {} : { stallMs: knobs.stallMs }),
      // Executor gets the full assembled env (the skill needs its injected
      // secrets); the grader is trusted vat infra loading no skill, so it gets
      // AUTH-ONLY env — never the skill's injected secrets.
      executorEnv: assembledEnv.env,
      graderEnv: resolvedAuth.forwardedEnv,
      ...(opts.declaredExecutables === undefined ? {} : { declaredExecutables: opts.declaredExecutables }),
      ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
    };

    // Tier-ordered, cost-tiered fail-fast (issue #145 Phase G): run evals tier by
    // tier (ascending / cheapest first), bounded-parallel WITHIN each tier, and
    // gate BETWEEN tiers — once a cheaper tier fails a gating expectation, the
    // higher (more expensive) tiers are SKIPPED (never graded, never passed), so a
    // broken foundational expectation stops the run from spending on hard tiers.
    // Each tier is one runPipeline: bounded-parallel, retrying a RateLimitSignal
    // per item. An InternalHarnessError thrown by any executor/grader (timeout/
    // stall/spawn-error, grader failure, missing fragment, nonce mismatch)
    // propagates OUT unhandled → mapErrorToExitCode → exit 1; a spawn or grader
    // break is never laundered into a pass/fail verdict (R1 no-laundering).
    const { fragments, skipped } = await runEvalsTiered({
      evals: suite.evals,
      baseline: opts.baseline === true,
      runTier: (items) =>
        runPipeline<EvalWorkItem, EvalFragment>({
          items,
          concurrency,
          worker: (item) => runEvalWorker(item, evalCtx),
        }),
    });

    // Step 10: vat merges the grader fragments and writes grading.json/friction.json/
    // tool-eval.json (and baseline.json for a baseline run), then reconciles the
    // authoritative prose-expectation verdict from the WITH-arm per-expectation
    // `passed` flags — NOT any self-reported summary. An executor CLEAN failure
    // reaches here as a FAILing fragment → composite verdict → exit 4.
    const { verdict, toolEval } = writeRunArtifactsAndReconcile(fragments, runNonce, artifacts);

    // D2 fail-closed gate: vat is the SOLE writer of results/, so a missing/unparseable/
    // invalid grading.json, friction.json, or tool-eval.json after the merge is a HARNESS
    // bug (exit 1), never a skill fault. A SEPARATE explicit check, not a prompt invariant.
    assertVatWroteArtifacts(artifacts);

    // Composite verdict: the run passes only when BOTH output expectations AND every
    // tool-expectation verdict passed — so an output all-pass where a `mustRun` never
    // ran yields FAIL → exit 4. Tool verdicts stay in tool-eval.json (C2); the composite
    // combines the two channels only here, at the exit-code layer. A fail-fast run
    // that SKIPPED higher tiers is never a pass: skipped ≠ passed forces allPassed
    // false → exit 4 (never downgraded to 0 by the composite path).
    const allPassed = resolveCompositeAllPassed(verdict.allPassed, toolEval, skipped);
    const summary = buildRunSummaryWithSkips(verdict, toolEval, allPassed, skipped, costAccumulator);

    return {
      harnessPath: harnessRoot,
      exitCode: verdictExitCode(allPassed, opts.tolerateEvalFailure === true),
      summary,
    };
  } finally {
    // Surface any packaging-fidelity friction VAT merged into friction.json to
    // STDERR BEFORE cleanup removes the harness dir. Best-effort + stderr-only
    // (stdout stays machine-readable); a no-op when the path is unassigned (a
    // pre-merge throw) or friction.json is absent or empty.
    emitFrictionReport(frictionOut);
    // Remove the signal handlers first (no listener leak across runs), then run
    // the same cleanup: release the lock, remove the harness dir, and remove the
    // vat-only grader dir (which lives outside harnessRoot).
    removeSignalCleanup();
    cleanup();
  }
}
