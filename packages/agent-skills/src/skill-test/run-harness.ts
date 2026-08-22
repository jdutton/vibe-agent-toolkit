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
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

import {
  detectBaselineContamination,
  scrubControlArmEnv,
  summarizeBaselineIntegrity,
  type BaselineContamination,
} from './baseline-integrity.js';
import { assembleChildEnv, assertKnownEnvTokens, computeEnvTokens, resolveInjectEnv } from './declared-env.js';
import { runExecutorForEval } from './eval-executor.js';
import type { EvalFragment } from './eval-fragment.js';
import { runGraderForEval } from './eval-grader.js';
import {
  armDirSegment,
  EvalInputError,
  parseEvalSuite,
  stageEvalWorkspaces,
  type ArmWorkspaceDirs,
  type EvalArm,
  type EvalEntry,
  type EvalSuite,
} from './eval-inputs.js';
import { lintEvalExpectations, lintToolExpectationExecutables } from './eval-lint.js';
import { DEFAULT_EVALS_SUBPATH } from './eval-suite-isolation.js';
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
import {
  assertSafeHarnessRoot,
  assertSafeWorkdir,
  HarnessLocationError,
  prepareHarnessRoot,
  resolveHarnessRoot,
} from './harness-location.js';
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
  /**
   * Where the executor's per-eval working directories were materialized. Lives
   * OUTSIDE `harnessPath` on purpose (see {@link resolveWorkspacesRoot}), so it
   * cannot be derived from the harness path and has to be reported. Retained on
   * exactly the same terms as the harness root; absent when the run ended before
   * workspaces were staged.
   */
  workspacesPath?: string;
  /**
   * Where this run's artifacts (`grading.json`, `friction.json`, `tool-eval.json`,
   * and `baseline.json` on a `--baseline` run) were written. Reported rather than
   * left to be derived from `harnessPath`, because it is the ONLY part of the
   * harness root that survives cleanup on a default run — see
   * {@link cleanupHarness}. Absent when the run ended before Step 7 created it.
   */
  resultsPath?: string;
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
 * Match a flag name as a whole token in `claude --help` output.
 *
 * The boundary matters: a bare `includes('--plugin-dir')` also matches
 * `--plugin-dirs` or `--plugin-dir-cache`, and vat's own flag names are prefixes
 * of each other (`--max-turns` / `--max-turns-per-eval` would collide). Neither
 * side of the token may be a letter or a dash.
 */
export function helpTextDeclaresFlag(helpText: string, flag: string): boolean {
  // A scan rather than a built regex: the flag is data (it comes from a list a
  // future edit will extend), and building a pattern from data is both a lint
  // error here and the kind of thing that silently changes meaning when someone
  // adds a flag containing a metacharacter.
  const isTokenChar = (ch: string | undefined): boolean =>
    ch !== undefined && (ch === '-' || ch === '_' || /[a-z0-9]/i.test(ch));
  for (let from = helpText.indexOf(flag); from !== -1; from = helpText.indexOf(flag, from + 1)) {
    if (!isTokenChar(helpText[from - 1]) && !isTokenChar(helpText[from + flag.length])) return true;
  }
  return false;
}

/**
 * A flag name no `claude` will ever accept. It is probed alongside the real ones
 * as a NEGATIVE CONTROL: if the probe reports this as supported, the probe is
 * broken and its answer about every other flag is worthless.
 */
export const FLAG_PROBE_SENTINEL = '--vat-probe-flag-that-cannot-exist';

/**
 * Build a token-free flag-support probe from `claude --help`.
 *
 * ⚠️ This REPLACES an exit-code probe (`claude <flag> <dummy> --help`, exit 0 ⇒
 * supported) that could not discriminate at all. Verified against claude 2.x:
 * `claude --no-such-flag-xyz 1 --help` exits **0**, because `--help` short-circuits
 * before argument validation. Every one of preflight's `flag <name>` checks
 * therefore reported "supported" unconditionally — including for flags that do not
 * exist — so the gate that is supposed to stop vat spawning with an unsupported
 * flag was decorative. (The same command without `--help` exits 1, but running it
 * would start a real session and bill tokens, which is why `--help` was there.)
 *
 * Help-text matching does discriminate, and it is still token-free: one `--help`
 * invocation for the whole run instead of one spawn per flag.
 *
 * The probe carries its own negative control ({@link FLAG_PROBE_SENTINEL}). If a
 * future `claude` prints something that matches the sentinel — or `--help` fails
 * outright — the probe reports EVERY flag unsupported rather than every flag
 * supported. A probe that cannot tell must fail closed and be seen; the defect it
 * replaces failed open and was invisible.
 */
export function buildFlagParseProbe(
  runHelp: () => string | null = defaultClaudeHelp,
): (flag: string) => boolean {
  const helpText = runHelp();
  // No help output, or a sentinel "match" ⇒ the probe is not trustworthy.
  const usable = helpText !== null && !helpTextDeclaresFlag(helpText, FLAG_PROBE_SENTINEL);
  return (flag: string): boolean =>
    usable && helpTextDeclaresFlag(helpText ?? '', flag);
}

/** Run `claude --help` once, returning its combined output (null if unreachable). */
function defaultClaudeHelp(): string | null {
  const result = safeExecResult('claude', ['--help'], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (!result.success) return null;
  // `stdout`/`stderr` are typed `Buffer | string`; `encoding: 'utf8'` makes them
  // strings, and `String()` is correct either way. Both streams are read because
  // a CLI is free to print its usage to either.
  return `${String(result.stdout)}\n${String(result.stderr)}`;
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

/**
 * Where this run READS its eval suite from, anchored at the subject's authored
 * source dir.
 *
 * `evalsRef` is `undefined` for the built-in convention and a config/flag value
 * otherwise, and the two are resolved differently ON PURPOSE:
 *
 * - The convention is VAT's OWN constant, not an adopter-supplied reference, so
 *   it stays plain path math. Routing it through {@link resolveAssetReference}
 *   would make `evals/evals.json` a bare specifier, and an installed package
 *   named `evals` would then shadow every skill's own suite.
 * - An explicit value IS a config-supplied file reference, so it goes through
 *   {@link resolveAssetReference} — the project's canonical resolver — and
 *   therefore accepts a relative path, an ABSOLUTE path, or an npm bare
 *   specifier honoring the target package's `exports` map.
 *
 * The absolute case is why this exists. A suite is the answer key, so it is
 * inherently repo-local; testing a skill you did not author requires supplying
 * one from outside its tree. `safePath.join` silently folded an absolute path
 * into `<skillDir>/<path>`, which does not exist — so the run did not fail, it
 * bootstrapped a starter template at the bogus location and graded that.
 */
export function resolveScaffoldEvalsPath(
  opts: RunHarnessOptions,
  repoRoot: string,
  evalsRef: string | undefined,
): string {
  const resolveFrom = (baseDir: string): string =>
    evalsRef === undefined
      ? safePath.join(baseDir, DEFAULT_EVALS_SUBPATH)
      : resolveAssetReference(evalsRef, baseDir);

  // Prefer the explicit authored source dir resolved by run.ts (the staged/built
  // tree is ephemeral; this is where the user can edit the scaffolded template).
  if (opts.subjectScaffoldDir !== undefined) {
    return resolveFrom(opts.subjectScaffoldDir);
  }
  const subjectName = opts.subject;
  const override = opts.withSources?.[subjectName];
  const overridePath = override && 'path' in override ? override.path : undefined;
  // Default (no override) resolution treats the positional name as a path.
  const sourcePath = overridePath ?? subjectName;
  // eslint-disable-next-line local/no-unsafe-root-join -- the positional skill source may be an absolute path; resolving it against repoRoot (which returns an absolute sourcePath unchanged) is intentional, documented behavior, not a containment bug.
  const sourceDir = safePath.resolve(repoRoot, sourcePath);
  return resolveFrom(sourceDir);
}

/**
 * Bootstrap (exit 3) — called when the eval suite is absent everywhere. A real run
 * writes a persistent template at the source scaffold location and reports it; a dry
 * run must never touch the filesystem, so it reports where a real run *would*
 * scaffold and writes nothing. Both surface the same exit-3 BootstrapNeededError.
 * Always throws.
 */
function bootstrapEvalSuite(opts: RunHarnessOptions, repoRoot: string, evalsRef: string | undefined): never {
  const scaffoldPath = resolveScaffoldEvalsPath(opts, repoRoot, evalsRef);
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
  /** Explicit `test.evals` / `--evals` value, or `undefined` for the convention. */
  evalsRef: string | undefined;
  /** Defaulted subpath — names the suite FILE inside a held artifact. */
  evalsSubpath: string;
  holdDir: string;
  subjectEvalSuiteHeld: boolean;
}): string | undefined {
  const authored = resolveScaffoldEvalsPath(input.opts, input.repoRoot, input.evalsRef);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- authored source path resolved from opts
  if (existsSync(authored)) return authored;
  if (!input.subjectEvalSuiteHeld) return undefined;
  return safePath.join(input.holdDir, basename(input.evalsSubpath));
}

/**
 * The per-run executor workspace root: `<tmp>/vat-skill-test-ws-<dirToken>/`.
 *
 * Deliberately OUTSIDE `harnessRoot`, alongside {@link resolveGraderOutDir} and
 * {@link resolveEvalSuiteHoldDir}. The executor's cwd lives under here, and the
 * harness root is where vat stages runnable copies of the skill (`staged/` and
 * the assembled plugin dir). While the two were parent and child, the skill-absent
 * arm of a `--baseline` run sat one `ls ..` away from the treatment it was
 * supposed to be denied — the control could reach vat's own copy without ever
 * leaving its working directory.
 *
 * Named by an unpredictable token, like the other vat-only dirs, and removed by
 * the same cleanup. Pure (derives a path only).
 */
export function resolveWorkspacesRoot(dirToken: string): string {
  return safePath.join(normalizedTmpdir(), `vat-skill-test-ws-${dirToken}`);
}

/** Parse the staged eval suite and materialize each eval's input `files` into
 * `<workspacesRoot>/<arm>/<id>/`, once per arm this run will execute. Returns the
 * workspaces root, the parsed {@link EvalSuite} (so the eval loop has the entries
 * without re-reading), and the declared eval count (derived from the suite). The
 * dir is wiped first so a reused root cannot leak a prior run's inputs. Throws
 * {@link EvalInputError} (mapped by the caller to exit 2) on a bad suite or a
 * missing input file. */
/**
 * Mint this run's opaque per-arm workspace directory segments.
 *
 * Independent random tokens, NOT the arm names and not derived from one another:
 * the segment ends up in the executor's cwd, which the prompt states verbatim, so
 * a name like `without` unblinds the control arm outright — and a name like `with`
 * hands it a guessable path to the treatment arm's live output one directory over.
 * 8 bytes is ample for "not guessable within a run that lasts minutes"; these are
 * blinding/anti-enumeration tokens, not secrets protecting data at rest.
 */
export function mintArmWorkspaceDirs(baseline: boolean): ArmWorkspaceDirs {
  const token = (): string => randomBytes(8).toString('hex');
  return baseline ? { with: token(), without: token() } : { with: token() };
}

export function stageWorkspacesForRun(
  evalsPath: string,
  workspacesRoot: string,
  armDirs: ArmWorkspaceDirs,
): { workspacesRoot: string; declaredEvalCount: number; suite: EvalSuite } {
  rmSync(workspacesRoot, { recursive: true, force: true });
  // 0700, matching the harness root. These dirs hold each eval's declared input
  // files, which with an out-of-tree suite may be data that was never in the repo
  // at all. Inheriting the umask (0755) left them readable by any local user the
  // moment `--out` relocated the harness root out from under its 0700 parent.
  mkdirSyncReal(workspacesRoot, { recursive: true, mode: 0o700 });
  // The same shared-tmp hardening the harness root gets. `mkdirSync(recursive)`
  // on an existing path neither throws nor chmods, so without this an attacker
  // winning the race between the rmSync and the mkdir owns the executor's working
  // directory and nothing ever re-checks. Cheap: the leaf sits directly under the
  // trusted tmp boundary, so the ancestry walk degrades to one lstat + stat.
  assertSafeHarnessRoot(workspacesRoot, process.getuid?.() ?? -1);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- evalsPath is our staged-subject path
  const suite = parseEvalSuite(readFileSync(evalsPath, 'utf-8'));
  return {
    workspacesRoot: stageEvalWorkspaces({
      suite,
      evalsDir: dirname(evalsPath),
      workspacesRoot,
      armDirs,
    }),
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
  workspacesRoot: string,
  armDirs: ArmWorkspaceDirs,
): { workspacesRoot: string; declaredEvalCount: number; suite: EvalSuite } | RunHarnessResult {
  try {
    return stageWorkspacesForRun(evalsPath, workspacesRoot, armDirs);
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
  /** The eval's staged input workspace — what `${fixturesDir}` resolves under. */
  workspaceDir?: string;
  /** Suppress the stderr transparency line (emitted once, by the first eval). */
  quiet?: boolean;
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
    ...(input.workspaceDir === undefined ? {} : { workspaceDir: input.workspaceDir }),
  });
  const injectEnv = resolveInjectEnv(input.opts.env, envTokens);
  const assembled = assembleChildEnv({
    base: input.resolvedAuth.forwardedEnv,
    source: process.env,
    ...(input.opts.passEnv ? { passEnv: input.opts.passEnv } : {}),
    ...(injectEnv ? { injectEnv } : {}),
    subjectPluginRoot: input.subjectPluginRoot,
  });
  if (input.quiet !== true) {
    for (const warning of assembled.warnings) process.stderr.write(`warning: ${warning}\n`);
    process.stderr.write(assembled.line + '\n');
  }
  return assembled;
}

/** Everything needed to re-assemble the executor env once an eval's workspace is known. */
interface PerEvalEnvAssembly {
  input: Omit<ResolveDeclaredChildEnvInput, 'workspaceDir' | 'quiet'>;
  /** Mutable latch so exactly one eval emits the stderr transparency line. */
  logged: { done: boolean };
}

/**
 * Split env assembly into its run-scoped and per-eval halves.
 *
 * Token NAMES are validated once, before any spend, so a typo fails at preflight.
 * Token VALUES cannot all be resolved here: `${fixturesDir}` names the staged
 * workspace of ONE eval, so the run-scoped env deliberately omits the declared
 * `env` injections and {@link runEvalWorker} re-assembles them once the eval's
 * workspace is known. When there are no injections, the run-scoped env is the
 * whole story and `perEvalEnv` is absent.
 */
function prepareExecutorEnv(input: Omit<ResolveDeclaredChildEnvInput, 'workspaceDir' | 'quiet'>): {
  assembledEnv: ReturnType<typeof assembleChildEnv>;
  perEvalEnv: PerEvalEnvAssembly | undefined;
} {
  const { opts, ...rest } = input;
  assertKnownEnvTokens(opts.env);
  const { env: declaredInjectEnv, ...optsWithoutDeclaredEnv } = opts;
  return {
    // Quiet when injections exist: the first eval emits the transparency line with
    // the REAL interpolated values, so this partial view is never the one printed.
    assembledEnv: resolveDeclaredChildEnv({
      opts: optsWithoutDeclaredEnv,
      ...rest,
      quiet: declaredInjectEnv !== undefined,
    }),
    perEvalEnv:
      declaredInjectEnv === undefined ? undefined : { input, logged: { done: false } },
  };
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
    // Say what actually happened. `--dry-run` builds once acknowledged, so the
    // summary reports a completed build; under `--no-build` (or without the
    // acknowledgement) nothing was built and claiming otherwise would be the same
    // false assurance the PROVISIONAL fingerprint marker exists to prevent.
    lines.push(
      input.dryRunStagedExistingDist === undefined
        ? '[dry-run] Built + staged the declared skill; a real run would additionally spawn claude.'
        : '[dry-run] Staged the declared skill WITHOUT building; a real run would build + stage it, then spawn claude.',
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
  // The manifest and fingerprint describe the STAGED TREE, so they are the only
  // build-dependent facts here — everything above (env, models, knobs, eval count)
  // is read from config and the AUTHORED suite and is exact either way. A bare
  // 64-hex fingerprint reads as authoritative; printing one computed from a tree
  // that was never rebuilt is the one way this preview can be confidently wrong, so
  // it is labelled rather than left to be taken at face value.
  const stagedFromUnbuiltTree = input.wouldBuild && input.dryRunStagedExistingDist !== undefined;
  const provisional = stagedFromUnbuiltTree ? ' (PROVISIONAL — not rebuilt)' : '';
  lines.push(
    `[dry-run] Would run ${input.evalCount} eval${input.evalCount === 1 ? '' : 's'} as executor→grader spawn ` +
      `pair${input.evalCount === 1 ? '' : 's'} at concurrency ${input.concurrency}.`,
    `[dry-run] Executor ${input.modelFlag}; grader model ${input.graderModel} (prompt via stdin).`,
    `[dry-run] Staged manifest: ${count} entr${count === 1 ? 'y' : 'ies'} | ` +
      `fingerprint: ${input.provenanceFingerprint}${provisional}`,
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
 * The one child of the harness root that cleanup NEVER removes. Cleanup exists to
 * evict staged untrusted skill bytes and prompts from OS tmp; `results/` is the
 * opposite — it is the run's product, written solely by vat.
 */
export const RETAINED_RESULTS_DIRNAME = 'results';

/**
 * Remove the harness directory's staged contents after a run so untrusted skill
 * bytes and prompts do not accumulate in OS tmp. No-op when the user asked to keep
 * it, when the dir is a user-supplied location (`--out`/`--workdir`), or when it is
 * already gone. Idempotent and never throws — it runs from a `finally`, so it must
 * not mask the run's real outcome.
 *
 * `results/` SURVIVES. It holds `grading.json`, `friction.json`, `tool-eval.json`
 * and — for a `--baseline` run — `baseline.json`, i.e. every artifact the command's
 * own help text tells the operator to go read. Removing the whole root on the
 * DEFAULT invocation (no `--out`, no `--workdir`, no `--keep`) deleted those files
 * inside this function's own `finally`, before `run.ts` had printed a single line:
 * the operator was handed a `Harness:` path to a directory that no longer existed.
 * That is the invocation `vat-skill-testing.md`'s copy-paste example uses.
 *
 * The retention is deliberately UNCONDITIONAL rather than `--baseline`-only: every
 * run's verdict detail lives in the same directory, and a rule that depends on a
 * flag is a rule that will drift away from the flag. The cost is bounded — the
 * harness root is a deterministic function of the subject set, so a re-run reuses
 * (and {@link wipeStaleArtifacts} clears) the same `results/`, rather than
 * accumulating one per run.
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
    const entries = readdirSync(harnessRoot);
    // Nothing to retain — a run that ended before Step 7 (preflight refusal, lock
    // failure, a throw during staging) has no results/, so leaving an empty 0700
    // dir behind in tmp would be pure litter. Remove the root outright.
    if (!entries.includes(RETAINED_RESULTS_DIRNAME)) {
      rmSync(harnessRoot, { recursive: true, force: true });
      return;
    }
    for (const entry of entries) {
      if (entry === RETAINED_RESULTS_DIRNAME) continue;
      rmSync(safePath.joinUnderRoot(harnessRoot, entry), { recursive: true, force: true });
    }
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
  arm: EvalArm;
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
 * The executor working directory for one eval ON ONE ARM: its staged input
 * workspace `<workspacesRoot>/<arm>/<id>`, ALWAYS — empty when the eval declares
 * no input `files` (see {@link stageEvalWorkspaces}).
 *
 * This used to return undefined for a file-less eval, which made the executor
 * fall back to running inside the staged subject dir. That fallback was the
 * quiet half of the `--baseline` control defect: the skill-absent arm's cwd
 * was the skill.
 *
 * The per-arm segment closes the OTHER half, found a round later: without it both
 * arms of one eval shared a single writable directory AND ran concurrently, so
 * the control arm could read the treatment arm's output files and answer from
 * them. Keyed on the eval id alone this is a pure function of the eval; the arm
 * is what makes the two runs independent.
 *
 * The segment is an OPAQUE per-run token, never the arm's name — this path is
 * quoted verbatim to the executor as its working directory, so `…/without/e1`
 * told the control arm it was the control, and `../with/e1` told it where to look.
 * See {@link mintArmWorkspaceDirs}. Pure + unit-testable.
 */
export function resolvePerEvalWorkspaceDir(
  entry: EvalEntry,
  workspacesRoot: string,
  arm: EvalArm,
  armDirs: ArmWorkspaceDirs,
): string {
  const armRoot = safePath.joinUnderRoot(workspacesRoot, armDirSegment(armDirs, arm));
  return safePath.joinUnderRoot(armRoot, String(entry.id));
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
  /** This run's opaque per-arm workspace segments (see {@link mintArmWorkspaceDirs}). */
  armDirs: ArmWorkspaceDirs;
  pluginDirs: string[];
  graderOutDir: string;
  runNonce: string;
  graderModel: string;
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  stallMs?: number;
  /**
   * Full assembled env (skill secrets included) for the executor spawn, WITHOUT
   * the declared `env` injections — those carry `${fixturesDir}`, which names the
   * eval's own workspace and so can only be resolved per eval (see `perEvalEnv`).
   */
  executorEnv: NodeJS.ProcessEnv;
  /**
   * Present only when the subject declares an `env` block. Re-assembles the child
   * env per eval so `${fixturesDir}` resolves under THAT eval's workspace. The
   * transparency line is emitted once, by whichever eval assembles first.
   */
  perEvalEnv: PerEvalEnvAssembly | undefined;
  /** AUTH-ONLY env for the grader spawn (trusted vat infra loads no skill). */
  graderEnv: NodeJS.ProcessEnv;
  /** Declared executables (WITH-arm grader recognition aid); absent when unreachable. */
  declaredExecutables?: Array<{ name: string; howInvoked: string; kind: string }>;
  spawn?: typeof spawnHeadlessClaude;
  /** Shared spend accumulator — each worker folds in its executor + grader session cost. */
  costAccumulator: RunCostSummary;
  /**
   * The harness root, where vat stages runnable copies of the subject. Used ONLY
   * as a contamination needle for the skill-absent arm (see baseline-integrity.ts):
   * nothing points the control arm here any more, so a mention of this path in its
   * transcript means it went looking and found vat's own copy.
   */
  harnessRoot: string;
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
/**
 * The executor env for ONE eval.
 *
 * `workspaceDir` is threaded to the token resolver ONLY when the eval actually
 * declares input `files`, even though every eval now HAS a workspace. The two are
 * different questions: the workspace is where the executor runs, while
 * `${fixturesDir}` promises a staged `fixtures/` directory that EXISTS — and
 * `stageEvalWorkspaces` creates that only for evals declaring files. Passing it
 * unconditionally silently downgraded `UnresolvableEnvTokenError` (a loud exit 2
 * naming the exact fix) into a dead path the skill discovers at runtime and is
 * then blamed for.
 */
function resolveExecutorEnvForEval(
  item: EvalWorkItem,
  ctx: EvalRunContext,
  workspaceDir: string,
): NodeJS.ProcessEnv {
  if (ctx.perEvalEnv === undefined) return ctx.executorEnv;
  const declaresFiles = item.entry.files !== undefined && item.entry.files.length > 0;
  const { input, logged } = ctx.perEvalEnv;
  const env = resolveDeclaredChildEnv({
    ...input,
    ...(declaresFiles ? { workspaceDir } : {}),
    quiet: logged.done,
  }).env;
  logged.done = true;
  return env;
}

/**
 * Scrub the control arm's env and SAY what it lost.
 *
 * The arms are meant to differ in the skill and nothing else, so any var withheld
 * from one side is a confound. A control arm silently spawned without `PATH` or
 * without its declared fixtures still runs — it just does worse, which reports as
 * skill lift. That failure is invisible unless the withholding is announced, and
 * `dropped` was previously computed and thrown away.
 */
function scrubAndReportControlArmEnv(
  env: NodeJS.ProcessEnv,
  harnessRoot: string,
  evalId: string,
): NodeJS.ProcessEnv {
  const { env: scrubbed, dropped, retainedLeaks } = scrubControlArmEnv(env, harnessRoot);
  if (dropped.length > 0) {
    process.stderr.write(
      `control arm (${evalId}): withheld ${dropped.length} env var(s) naming the harness root: ${dropped.join(', ')}\n`,
    );
  }
  if (retainedLeaks.length > 0) {
    process.stderr.write(
      `⚠️  control arm (${evalId}): ${retainedLeaks.join(', ')} name(s) the harness root but are required to run, so they were NOT withheld. ` +
        `The control arm can read the harness through them — move --out/--workdir off this path before trusting the delta.\n`,
    );
  }
  return scrubbed;
}

async function runEvalWorker(item: EvalWorkItem, ctx: EvalRunContext): Promise<EvalFragment> {
  const evalId = String(item.entry.id);
  const workspaceDir = resolvePerEvalWorkspaceDir(item.entry, ctx.workspacesRoot, item.arm, ctx.armDirs);
  const onProgress = (chunk: string): void => { process.stderr.write(chunk); };

  // Resolve the declared `env` against THIS eval's workspace.
  //
  // `workspaceDir` is threaded to the token resolver ONLY when the eval actually
  // declares input `files`, even though every eval now HAS a workspace. The two
  // are different questions: the workspace is where the executor runs, while
  // `${fixturesDir}` promises a staged `fixtures/` directory that exists — and
  // `stageEvalWorkspaces` creates that only for evals declaring files. Passing it
  // unconditionally silently downgraded `UnresolvableEnvTokenError` (a loud exit 2
  // naming the exact fix) into a dead path the skill discovers at runtime and gets
  // blamed for.
  let executorEnv = resolveExecutorEnvForEval(item, ctx, workspaceDir);

  // The skill-absent arm is not told where the subject is staged. Handing it that
  // path would defeat the control outright: the staged dir holds the SKILL.md AND
  // any executable the skill ships, so a control arm given the path can recover
  // the entire treatment with one `cat`. Withholding the plugin dir while naming
  // the staged dir in the prompt was the defect this arm's whole value rests on.
  const isWithArm = item.arm === 'with';

  // ...and the same reasoning applied to the ENVIRONMENT, which is the channel the
  // first round of this fix missed entirely: the run assembles ONE env and both
  // arms were handed it verbatim, `CLAUDE_PLUGIN_ROOT` included. See
  // scrubControlArmEnv — prompt, argv, cwd and env are four channels, not three.
  //
  // Report what the control arm lost. The arms are supposed to differ in the skill
  // and nothing else, so any var withheld from one side is a confound the operator
  // has to be able to see — silently spawning a degraded control is how a harness
  // manufactures the lift it is meant to measure.
  if (!isWithArm) executorEnv = scrubAndReportControlArmEnv(executorEnv, ctx.harnessRoot, evalId);

  const outcome = await runExecutorForEval({
    evalId,
    task: item.entry.prompt,
    ...(isWithArm ? { subjectStagedDir: ctx.subjectStagedDir } : {}),
    workspaceDir,
    pluginDirs: item.arm === 'without' ? [] : ctx.pluginDirs,
    env: executorEnv,
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

  const graded = withoutGraderContamination(fragment);
  if (isWithArm) return { ...graded, arm: item.arm };
  return { ...graded, arm: item.arm, ...baselineContaminationFor(outcome.transcript, ctx) };
}

/**
 * Strip any `contamination` the GRADER emitted, before VAT attaches its own.
 *
 * The grader's only input is the executor transcript, which untrusted skill code
 * controls — so a prompt injection there could otherwise fabricate a
 * `BASELINE CONTAMINATED` verdict carrying attacker-chosen strings into an
 * operator-facing artifact. Spreading VAT's value last is NOT sufficient: it is
 * `{}` on a clean run, so it overwrites nothing.
 */
export function withoutGraderContamination(fragment: EvalFragment): EvalFragment {
  if (fragment.contamination === undefined) return fragment;
  const copy = { ...fragment };
  delete copy.contamination;
  return copy;
}

/**
 * Baseline integrity for ONE skill-absent eval: vat has removed its OWN copies
 * from the control arm's reach, but an ambient copy in the adopter's repo or
 * installed plugin cache is not vat's to remove — so the control arm can still,
 * in principle, find and run the skill. Detect it from the transcript and return
 * the fragment patch that carries the evidence to the merge step, which turns it
 * into a loud caveat on baseline.json. A wrong number that announces itself is
 * recoverable; a silent one gets believed.
 *
 * Returns an empty patch when clean, so the caller spreads it unconditionally.
 */
function baselineContaminationFor(
  transcript: string,
  ctx: EvalRunContext,
): Pick<EvalFragment, 'contamination'> | Record<string, never> {
  const hits = detectBaselineContamination({
    transcript,
    harnessRoot: ctx.harnessRoot,
    // Only ever called for the skill-absent arm, so the sibling is `with` — the
    // treatment arm's live working directory, one `ls ..` away and containing no
    // harness path for the needles above to find.
    siblingArmDir: safePath.joinUnderRoot(
      ctx.workspacesRoot,
      armDirSegment(ctx.armDirs, 'with'),
    ),
    // `name` is the executable's basename with the extension stripped
    // (`scripts/csvsum.py` → `csvsum`) — a stable token appearing in both the
    // command the arm ran and the output it got back. `howInvoked` is a command
    // string, not a path, so it is deliberately NOT used here.
    ...(ctx.declaredExecutables === undefined
      ? {}
      : { executableNames: ctx.declaredExecutables.map((e) => e.name) }),
  });
  return hits.length === 0 ? {} : { contamination: hits };
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
/**
 * Collect per-eval baseline-integrity findings from the WITHOUT-arm fragments.
 * Fragments with no `contamination` are clean and contribute nothing. Pure.
 */
function collectBaselineFindings(withoutArm: EvalFragment[]): BaselineContamination[] {
  return withoutArm
    .filter((f): f is EvalFragment & { contamination: NonNullable<EvalFragment['contamination']> } =>
      f.contamination !== undefined && f.contamination.length > 0)
    .map((f) => ({ evalId: f.evalId, hits: f.contamination }));
}

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
    // Stamp the integrity verdict onto baseline.json (GradingReportSchema is
    // .passthrough(), so the extra field is contract-legal). Written on EVERY
    // baseline run, clean or not: a reader must be able to tell "checked and
    // clean" from "produced before this check existed", and only an
    // unconditional field does that.
    const integrity = summarizeBaselineIntegrity(collectBaselineFindings(withoutArm));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived results path
    writeFileSync(
      paths.baselineOut,
      JSON.stringify({ ...baseline, baselineIntegrity: integrity }, null, 2) + '\n',
      'utf-8',
    );
    if (integrity.contaminated) process.stderr.write(`\n⚠️  ${integrity.summary}\n\n`);
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
/**
 * Resolve WHERE this run lives, and whether the harness owns that location.
 *
 * `--out` names the harness root exactly; `--workdir` names the BASE the root is
 * derived under. They are mutually exclusive: passing both used to silently
 * discard `--workdir` — the run went entirely to `--out` and the `--workdir` path
 * was never even created — so an operator using the pair to separate the
 * executor's cwd from the staged trees got no separation and no warning.
 *
 * `harnessCreated` is true only for the derived-under-OS-tmp case; an explicit
 * `--out` or `--workdir` is a location the user owns and is never auto-removed.
 */
export function resolveHarnessLocation(
  opts: Pick<RunHarnessOptions, 'out' | 'workdir' | 'subject'>,
): { harnessRoot: string; harnessCreated: boolean } {
  if (opts.out !== undefined && opts.workdir !== undefined) {
    throw new HarnessLocationError(
      '--out and --workdir are mutually exclusive: --out names the harness root exactly, ' +
        '--workdir names the base it is derived under. Pass one.',
    );
  }

  // §7 workdir safety: refuse a --workdir whose ancestry contains CLAUDE.md/.claude
  // BEFORE deriving the harness root from it (defense in depth with --setting-sources "").
  if (opts.workdir !== undefined) {
    // Bounded at the user's home directory, which the walk stops BEFORE inspecting.
    //
    // Unbounded, this refuses every `--workdir` on Windows for every Claude Code
    // user: the OS temp dir there lives INSIDE the profile
    // (`C:\Users\<name>\AppData\Local\Temp`), so the ancestry walk climbs out of tmp
    // and finds the ambient `~/.claude` — and the resulting message, "Use an OS-tmp
    // location", names the thing the user just did. Unsatisfiable advice. It cannot
    // reproduce on POSIX, where tmp is never under `$HOME`, nor on the GitHub Windows
    // runner, whose `runneradmin` profile has no `~/.claude`; it needs a real Windows
    // developer machine, which is where it was found.
    //
    // Not a relaxation of the threat model: the gate refuses a workdir inside a
    // PROJECT, and `$HOME/.claude` is global config that every Claude Code user has on
    // every platform — it was never the target. A project at `$HOME/proj` is still
    // caught, because the walk inspects `$HOME/proj` and stops only at `$HOME` itself.
    assertSafeWorkdir(opts.workdir, homedir());
  }

  return {
    // `--out` is RESOLVED to an absolute path, not taken verbatim. A relative
    // `--out ./h` used to be stored as `./h` and then used as a contamination
    // needle — a two-character string that matches almost any transcript, so every
    // eval reported contaminated and the operator was told to discard a clean run.
    harnessRoot: opts.out === undefined
      ? resolveHarnessRoot([opts.subject], opts.workdir)
      : safePath.resolve(opts.out),
    harnessCreated: opts.out === undefined && opts.workdir === undefined,
  };
}

export async function runSkillTestHarness(opts: RunHarnessOptions): Promise<RunHarnessResult> {
  const { harnessRoot, harnessCreated } = resolveHarnessLocation(opts);
  const repoRoot = opts.repoRoot ?? harnessRoot;
  // Two distinct questions, deliberately not one value. `evalsRef` is what the
  // adopter ASKED FOR — a `test.evals`/`--evals` value, or `undefined` for the
  // built-in convention — and decides where the suite is READ from, which may be
  // outside the skill tree entirely. `evalsSubpath` is the defaulted form, used
  // where a *location inside a skill* is meant: stripping the suite out of every
  // staged tree, and naming the suite file inside a held artifact.
  const evalsRef = opts.evalsSubpath;
  const evalsSubpath = evalsRef ?? DEFAULT_EVALS_SUBPATH;
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

  // The executor's per-eval working directories. Like the grader and hold dirs
  // these live OUTSIDE harnessRoot — see resolveWorkspacesRoot for why that
  // separation is load-bearing for --baseline — so they need their own cleanup.
  const workspacesRoot = resolveWorkspacesRoot(randomBytes(16).toString('hex'));

  // The opaque per-arm segments beneath it. Minted here, with the roots, so the
  // same values reach staging, the executor's cwd, and the contamination
  // detector's sibling-arm needle — one source of truth for a value whose whole
  // job is to be unguessable and to carry no meaning.
  const armDirs = mintArmWorkspaceDirs(opts.baseline === true);

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
    // Per-eval workspaces are the executor's cwd. `--keep` is the ONLY thing that
    // retains them.
    //
    // Deliberately NOT mirrored on `cleanupHarness`'s rule (keep OR user-owned
    // location). That rule exists because `--out`/`--workdir` name a directory the
    // USER owns, so vat has no business deleting it. Since these moved out of the
    // harness root they live under OS tmp, which the user did not choose and does
    // not manage — carrying the rule across would orphan a
    // `vat-skill-test-ws-<token>` dir on every `--out` run, forever. The location
    // changed, so the retention policy has to change with it.
    if (opts.keep !== true) removeVatOnlyDir(workspacesRoot);
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
        evalsRef,
        evalsSubpath,
        holdDir: evalSuiteHoldDir,
        subjectEvalSuiteHeld: stageResult.subjectEvalSuiteHeld,
      }) ?? bootstrapEvalSuite(opts, repoRoot, evalsRef);

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
    const workspaceStageResult = attemptStageWorkspaces(
      evalsPath,
      harnessRoot,
      workspacesRoot,
      armDirs,
    );
    if ('exitCode' in workspaceStageResult) return workspaceStageResult;
    // `workspacesRoot` is resolved above (outside the try, so cleanup can reach it
    // on a signal); staging returns it unchanged, so only the derived values are
    // destructured here.
    const { declaredEvalCount, suite } = workspaceStageResult;

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
    // 0700, matching the harness root. `grading.json` quotes the executor
    // transcript verbatim in each expectation's evidence, so whatever the skill
    // read out of its input files ends up here as text — and unlike the
    // workspaces, results/ SURVIVES `--keep` by design.
    mkdirSyncReal(resultsDir, { recursive: true, mode: 0o700 });

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
    const { assembledEnv, perEvalEnv } = prepareExecutorEnv({
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
      armDirs,
      harnessRoot,
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
      perEvalEnv,
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
      workspacesPath: workspacesRoot,
      resultsPath: resultsDir,
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
