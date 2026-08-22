/**
 * Unit tests for the pure / semi-pure module-private helpers of run-harness.ts.
 *
 * These cover the small, deterministic decision functions the big async
 * orchestrator (`runSkillTestHarness`) composes — knob/timeout resolution, stage
 * item construction, preflight-input shaping, summary rendering, ack logic, the
 * experimenter-success guard, and scaffold-path resolution. The orchestrator
 * itself is genuine I/O (spawn/lock/staging) and is covered elsewhere by
 * integration/system tests; it is intentionally NOT exercised here.
 *
 * Helpers are imported via the direct source-file path (not the barrel) — the
 * barrel re-exports named symbols explicitly, so `export`ing these for testing
 * does NOT widen the public package surface.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- tests use controlled temp directories */
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { EvalFragment } from '../../src/skill-test/eval-fragment.js';
import { EvalInputError, type EvalEntry } from '../../src/skill-test/eval-inputs.js';
import { DuplicateStagedSkillError, SkillTestExitCode } from '../../src/skill-test/exit-codes.js';
import type { FrictionItem } from '../../src/skill-test/friction-schema.js';
import type { GradingVerdict } from '../../src/skill-test/grading-adapter.js';
import {
  buildDryRunSummary,
  buildEvalWorkItems,
  buildPreflightInput,
  buildResolveCtx,
  buildRunSummary,
  buildRunSummaryWithSkips,
  buildStageItems,
  buildStaleDistWarningLines,
  cleanupHarness,
  computeCompositeVerdict,
  detectItemPluginLayout,
  flagDummyValueFor,
  formatFrictionReport,
  formatRunCostSuffix,
  isAcknowledged,
  makeStageItem,
  partitionFragmentsByArm,
  renderPreflightSummary,
  recordSessionCost,
  resolveArtifactPaths,
  resolveCompositeAllPassed,
  resolveGraderOutDir,
  resolveHarnessLocation,
  resolveKnobs,
  resolvePerEvalWorkspaceDir,
  resolveWorkspacesRoot,
  resolveScaffoldEvalsPath,
  resolveStallMs,
  resolveTimeoutMs,
  stageWorkspacesForRun,
  subjectSkillName,
  verdictExitCode,
  wipeStaleArtifacts,
  type DryRunSummaryInput,
  type RunHarnessOptions,
} from '../../src/skill-test/run-harness.js';
import type { SkippedEvalsSummary } from '../../src/skill-test/tier-plan.js';
import type { ToolEvalReport } from '../../src/skill-test/tool-eval-schema.js';
import { createTestPlugin, setupTempDir } from '../test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const EVALS_JSON = 'evals.json';
const SUBJECT_NAME = 'report-tools';
const PLAIN_SKILL = 'plain-skill';
const PLUGIN_NAME = 'my-plugin';
const PLUGIN_SKILL_REL = 'skills/report-tools';
const OVERRIDE_LOC = 'override-loc';

/** Build a minimal RunHarnessOptions with the given subject and overrides. */
function makeOpts(overrides: Partial<RunHarnessOptions> = {}): RunHarnessOptions {
  return { subject: 'my-skill', ...overrides };
}

/** Build a preflight check entry. */
function check(name: string, passed: boolean, message: string): { name: string; passed: boolean; message: string } {
  return { name, passed, message };
}

/** Create a plain (non-plugin) directory under the temp root and return its path. */
function makePlainDir(tempDir: string, name: string): string {
  const dir = safePath.join(tempDir, name);
  mkdirSyncReal(dir, { recursive: true });
  return dir;
}

/** Create a populated harness-like directory (one staged file) and return its path. */
function makeHarnessDir(tempDir: string, name: string): string {
  const root = makePlainDir(tempDir, name);
  writeFileSync(safePath.join(root, 'staged.txt'), 'untrusted', 'utf-8');
  return root;
}

/**
 * Create a Claude-plugin source tree under `tempDir`: a plugin root holding
 * `.claude-plugin/plugin.json` with a skill nested at `relSkill` beneath it.
 * Returns the skill source path RELATIVE to tempDir (the repoRoot anchor) so it
 * can be passed straight to a `{ path }` source.
 */
function makePluginSkillDir(tempDir: string, pluginName: string, relSkill: string): string {
  createTestPlugin(tempDir, { name: pluginName }, pluginName);
  mkdirSyncReal(safePath.join(tempDir, pluginName, relSkill), { recursive: true });
  return `${pluginName}/${relSkill}`;
}

// ---------------------------------------------------------------------------
// Timeout / stall resolution
// ---------------------------------------------------------------------------

describe('resolveTimeoutMs', () => {
  it('returns the flat per-eval default when timeout is undefined', () => {
    expect(resolveTimeoutMs(makeOpts())).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('converts an explicit --timeout from seconds to milliseconds', () => {
    expect(resolveTimeoutMs(makeOpts({ timeout: 30 }))).toBe(30_000);
  });
});

describe('resolveStallMs', () => {
  it('returns undefined when stall is undefined', () => {
    expect(resolveStallMs(makeOpts())).toBeUndefined();
  });

  it('converts seconds to milliseconds', () => {
    expect(resolveStallMs(makeOpts({ stall: 12 }))).toBe(12_000);
  });
});

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

describe('resolveKnobs', () => {
  it('applies defaults and omits model/stallMs when unset', () => {
    const knobs = resolveKnobs(makeOpts());
    expect(knobs).toEqual({ maxTurns: 50, maxBudgetUsd: 5 });
    expect('model' in knobs).toBe(false);
    expect('stallMs' in knobs).toBe(false);
  });

  it('applies overrides including model and stallMs', () => {
    const knobs = resolveKnobs(
      makeOpts({ maxTurns: 7, maxBudgetUsd: 2, model: 'opus', stall: 4 }),
    );
    expect(knobs).toEqual({ maxTurns: 7, maxBudgetUsd: 2, model: 'opus', stallMs: 4000 });
  });
});

// ---------------------------------------------------------------------------
// Flag dummy values
// ---------------------------------------------------------------------------

describe('flagDummyValueFor', () => {
  it('maps known flags to their dummy values', () => {
    expect(flagDummyValueFor('--output-format')).toBe('stream-json');
    expect(flagDummyValueFor('--permission-mode')).toBe('bypassPermissions');
    expect(flagDummyValueFor('--setting-sources')).toBe('');
    expect(flagDummyValueFor('--plugin-dir')).toBe('.');
    expect(flagDummyValueFor('--max-turns')).toBe('1');
    expect(flagDummyValueFor('--max-budget-usd')).toBe('1');
  });

  it('falls back to "1" for an unknown flag', () => {
    expect(flagDummyValueFor('--totally-unknown')).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Preflight summary
// ---------------------------------------------------------------------------

describe('renderPreflightSummary', () => {
  it('reports success when all checks passed', () => {
    const summary = renderPreflightSummary([
      check('auth', true, 'ok'),
      check('version', true, 'ok'),
    ]);
    expect(summary).toBe('  All preflight checks passed.');
  });

  it('lists only the failed checks, one [FAIL] line each', () => {
    const summary = renderPreflightSummary([
      check('auth', true, 'ok'),
      check('version', false, 'too old'),
      check('integrity', false, 'mutated'),
    ]);
    expect(summary).toBe('  [FAIL] version: too old\n  [FAIL] integrity: mutated');
    expect(summary).not.toContain('auth');
  });
});

// ---------------------------------------------------------------------------
// Acknowledgment
// ---------------------------------------------------------------------------

describe('isAcknowledged', () => {
  it('is true for a dry run', () => {
    expect(isAcknowledged(makeOpts({ dryRun: true }))).toBe(true);
  });

  it('is true when the run-skill-code ack is set', () => {
    expect(isAcknowledged(makeOpts({ acknowledgedRunsSkillCode: true }))).toBe(true);
  });

  it('is false when neither is set', () => {
    expect(isAcknowledged(makeOpts())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-eval pipeline helpers
// ---------------------------------------------------------------------------

/** Build a minimal EvalEntry with the given overrides. */
function makeEvalEntry(over: Partial<EvalEntry> = {}): EvalEntry {
  return { id: 'e1', prompt: 'do the thing', expectations: ['works'], ...over } as EvalEntry;
}

/** Build a minimal graded fragment with the given arm. */
function makeFragment(evalId: string, arm?: 'with' | 'without'): EvalFragment {
  return {
    runNonce: 'n',
    evalId,
    ...(arm === undefined ? {} : { arm }),
    expectations: [{ text: 'e', passed: true }],
  };
}

describe('buildEvalWorkItems', () => {
  it('emits one WITH-arm item per eval when baseline is off', () => {
    const items = buildEvalWorkItems([makeEvalEntry({ id: 'a' }), makeEvalEntry({ id: 'b' })], false);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.arm === 'with')).toBe(true);
    expect(items.map((i) => i.entry.id)).toEqual(['a', 'b']);
  });

  it('emits a WITH and a WITHOUT arm per eval when baseline is on', () => {
    const items = buildEvalWorkItems([makeEvalEntry({ id: 'a' })], true);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.arm)).toEqual(['with', 'without']);
  });
});

describe('partitionFragmentsByArm', () => {
  it('routes undefined/with arms to withArm and without to withoutArm', () => {
    const { withArm, withoutArm } = partitionFragmentsByArm([
      makeFragment('a'),
      makeFragment('b', 'with'),
      makeFragment('a', 'without'),
    ]);
    expect(withArm.map((f) => f.evalId)).toEqual(['a', 'b']);
    expect(withoutArm.map((f) => f.evalId)).toEqual(['a']);
  });
});

describe('resolveGraderOutDir', () => {
  it('derives a nonce-named dir directly UNDER the OS tmp dir (outside any harness root)', () => {
    // relative(tmp, graderDir) === the nonce dir name proves it sits directly
    // under tmp with no `..` escape — i.e. outside any harness root under a workdir.
    expect(safePath.relative(normalizedTmpdir(), resolveGraderOutDir('deadbeef'))).toBe('vat-skill-grade-deadbeef');
  });
});

describe('resolveWorkspacesRoot', () => {
  // The executor's cwd must NOT live under the harness root: that root holds
  // `staged/` and the assembled plugin dir, so a control arm working inside it is
  // one `ls ..` from the skill it was denied.
  it('lands under OS tmp, not under any harness root', () => {
    expect(safePath.relative(normalizedTmpdir(), resolveWorkspacesRoot('cafebabe')))
      .toBe('vat-skill-test-ws-cafebabe');
  });
});

describe('resolveHarnessLocation', () => {
  // Passing both used to silently discard --workdir, so an operator trying to
  // separate the executor's cwd from the staged trees got neither the separation
  // nor a warning — the --workdir path was never even created.
  it('refuses --out and --workdir together instead of silently dropping one', () => {
    expect(() => resolveHarnessLocation({ subject: 'demo', out: '/o', workdir: '/w' }))
      .toThrow(/mutually exclusive/);
  });

  it('treats an explicit --out as user-owned (never auto-removed)', () => {
    const { harnessRoot, harnessCreated } = resolveHarnessLocation({ subject: 'demo', out: '/o' });
    expect(harnessRoot).toBe('/o');
    expect(harnessCreated).toBe(false);
  });

  it('derives under OS tmp and claims ownership when neither flag is given', () => {
    const { harnessRoot, harnessCreated } = resolveHarnessLocation({ subject: 'demo' });
    expect(harnessCreated).toBe(true);
    expect(toForwardSlash(harnessRoot)).toContain('/vat-skill-test/');
  });
});

describe('resolvePerEvalWorkspaceDir', () => {
  const workspacesRoot = '/harness/workspaces';

  // No undefined case any more: an eval without `files` used to get no workspace,
  // which made the executor run inside the staged subject dir — the skill-absent
  // arm's cwd was then the skill itself.
  it('routes to <workspacesRoot>/<id> even when the eval declares no files', () => {
    const dir = resolvePerEvalWorkspaceDir(makeEvalEntry({ id: '1' }), workspacesRoot);
    expect(toForwardSlash(dir).endsWith('/workspaces/1')).toBe(true);
  });

  it('routes to <workspacesRoot>/<id> when the eval declares files', () => {
    const dir = resolvePerEvalWorkspaceDir(makeEvalEntry({ id: '7', files: ['a.md'] }), workspacesRoot);
    expect(toForwardSlash(dir ?? '').endsWith('/workspaces/7')).toBe(true);
  });
});

describe('resolveArtifactPaths + wipeStaleArtifacts', () => {
  const { getTempDir } = setupTempDir('vat-wipe-');

  it('resolves the three results/ artifact paths', () => {
    const paths = resolveArtifactPaths('/harness/results');
    expect(toForwardSlash(paths.gradingOut).endsWith('/results/grading.json')).toBe(true);
    expect(toForwardSlash(paths.frictionOut).endsWith('/results/friction.json')).toBe(true);
    expect(toForwardSlash(paths.baselineOut).endsWith('/results/baseline.json')).toBe(true);
  });

  it('removes a prior run\'s grading/friction/baseline artifacts and is a no-op when absent', () => {
    const resultsDir = getTempDir();
    const paths = resolveArtifactPaths(resultsDir);
    for (const p of [paths.gradingOut, paths.frictionOut, paths.baselineOut]) {
      writeFileSync(p, 'STALE', 'utf-8');
    }
    wipeStaleArtifacts(paths);
    expect(existsSync(paths.gradingOut)).toBe(false);
    expect(existsSync(paths.frictionOut)).toBe(false);
    expect(existsSync(paths.baselineOut)).toBe(false);
    // Idempotent: wiping already-absent artifacts must not throw.
    expect(() => wipeStaleArtifacts(paths)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Friction report formatter
// ---------------------------------------------------------------------------

describe('formatFrictionReport', () => {
  const highItem: FrictionItem = {
    severity: 'high',
    category: 'path-assumption',
    message: 'Skill hardcodes /Users/me/data',
  };
  const lowItem: FrictionItem = {
    severity: 'low',
    category: 'doc-engine-drift',
    message: 'README references a removed flag',
  };

  it('returns the empty string for no entries (no output)', () => {
    expect(formatFrictionReport([])).toBe('');
  });

  it('formats one line per entry as [severity] category: message', () => {
    const out = formatFrictionReport([highItem, lowItem]);
    expect(out).toBe(
      '[high] path-assumption: Skill hardcodes /Users/me/data\n' +
        '[low] doc-engine-drift: README references a removed flag',
    );
  });
});

// ---------------------------------------------------------------------------
// Subject skill name
// ---------------------------------------------------------------------------

describe('subjectSkillName', () => {
  it('returns the trailing segment of a path-like subject arg', () => {
    expect(subjectSkillName(makeOpts({ subject: `some/dir/${SUBJECT_NAME}` }))).toBe(SUBJECT_NAME);
  });

  it('returns a plain name unchanged', () => {
    expect(subjectSkillName(makeOpts({ subject: SUBJECT_NAME }))).toBe(SUBJECT_NAME);
  });
});

// ---------------------------------------------------------------------------
// Scaffold evals path
// ---------------------------------------------------------------------------

describe('resolveScaffoldEvalsPath', () => {
  const repoRoot = '/repo';
  const evalsSubpath = 'evals/evals.json';
  /** Subject under test here — a nested skill, so the anchor is visible in the tail. */
  const SUBJECT = 'skills/foo';
  /** The convention's tail, asserted by every case that anchors inside the skill. */
  const CONVENTION_TAIL = '/skills/foo/evals/evals.json';

  // repoRoot is an absolute POSIX-style path; on Windows safePath.resolve prepends
  // a drive letter, so assertions anchor on the resolved root + relative tail
  // rather than a hardcoded literal (the Windows CI gate).
  const resolvedRepoRoot = toForwardSlash(safePath.resolve(repoRoot));

  it('resolves against repoRoot + the subject name when no override', () => {
    const out = toForwardSlash(resolveScaffoldEvalsPath(makeOpts({ subject: SUBJECT }), repoRoot, evalsSubpath));
    expect(out.startsWith(resolvedRepoRoot)).toBe(true);
    expect(out.endsWith(CONVENTION_TAIL)).toBe(true);
  });

  it('honors a withSources[name].path override', () => {
    const out = toForwardSlash(
      resolveScaffoldEvalsPath(
        makeOpts({ subject: 'foo', withSources: { foo: { path: 'custom/loc' } } }),
        repoRoot,
        evalsSubpath,
      ),
    );
    expect(out.startsWith(resolvedRepoRoot)).toBe(true);
    expect(out.endsWith('/custom/loc/evals/evals.json')).toBe(true);
  });

  // An eval suite is the answer key, so it is inherently repo-local — which means
  // testing a skill you did not author REQUIRES pointing at a suite outside that
  // skill's tree. These pin the three spellings that must reach the same place.
  it('returns an ABSOLUTE suite path unchanged instead of joining it under the skill', () => {
    // Was: safePath.join(skillDir, '/shared/evals/evals.json') silently produced
    // `<skillDir>/shared/evals/evals.json`. That path does not exist, so the run
    // did not fail — it BOOTSTRAPPED a starter template there, reporting success
    // while grading nothing the operator asked for.
    const absolute = toForwardSlash(safePath.resolve('/shared/evals/evals.json'));
    const out = toForwardSlash(
      resolveScaffoldEvalsPath(makeOpts({ subject: SUBJECT }), repoRoot, absolute),
    );
    expect(out).toBe(absolute);
  });

  it('resolves a suite path that escapes the skill dir', () => {
    // Already worked (join normalizes `..`), pinned so the absolute-path fix does
    // not regress the layout adopters use today to keep suites out of a bundle.
    const out = toForwardSlash(
      resolveScaffoldEvalsPath(makeOpts({ subject: SUBJECT }), repoRoot, '../shared/evals.json'),
    );
    expect(out.startsWith(resolvedRepoRoot)).toBe(true);
    expect(out.endsWith('/skills/shared/evals.json')).toBe(true);
  });

  it('keeps the built-in convention on plain path resolution', () => {
    // The default is VAT's own constant, not an adopter-supplied reference, so it
    // must never be interpreted as a package specifier — an installed package
    // named `evals` would otherwise shadow every skill's own suite.
    const out = toForwardSlash(
      resolveScaffoldEvalsPath(makeOpts({ subject: SUBJECT }), repoRoot, undefined),
    );
    expect(out.endsWith(CONVENTION_TAIL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolve context
// ---------------------------------------------------------------------------

describe('buildResolveCtx', () => {
  it('returns repoRoot, a staged staging root, and a fetch cache dir', () => {
    const ctx = buildResolveCtx('/harness', '/repo');
    expect(ctx.repoRoot).toBe('/repo');
    const staging = toForwardSlash(ctx.stagingRoot);
    // Windows: joinUnderRoot resolves the harness root and prepends a drive letter.
    expect(staging.startsWith(toForwardSlash(safePath.resolve('/harness')))).toBe(true);
    expect(staging.endsWith('/staged')).toBe(true);
    expect(toForwardSlash(ctx.fetchCacheDir).endsWith('/vat-fetch-cache')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage item construction (real temp dirs)
// ---------------------------------------------------------------------------

describe('stage item construction', () => {
  const { getTempDir } = setupTempDir('vat-run-harness-test-');

  it('detectItemPluginLayout returns undefined for a non-{path} source', () => {
    expect(detectItemPluginLayout({ npm: '@scope/pkg' }, getTempDir())).toBeUndefined();
  });

  it('detectItemPluginLayout returns undefined for a plain (flat) {path} dir', () => {
    const tempDir = getTempDir();
    makePlainDir(tempDir, PLAIN_SKILL);
    expect(detectItemPluginLayout({ path: PLAIN_SKILL }, tempDir)).toBeUndefined();
  });

  it('detectItemPluginLayout detects the plugin root for a {path} nested under a plugin', () => {
    const tempDir = getTempDir();
    const rel = makePluginSkillDir(tempDir, PLUGIN_NAME, PLUGIN_SKILL_REL);
    const layout = detectItemPluginLayout({ path: rel }, tempDir);
    expect(layout).toBeDefined();
    expect(toForwardSlash(layout?.pluginRoot ?? '').endsWith(`/${PLUGIN_NAME}`)).toBe(true);
    expect(layout?.relPathUnderPlugin).toBe(PLUGIN_SKILL_REL);
  });

  it('makeStageItem includes pluginLayout for a plugin-distributed {path} subject', () => {
    const tempDir = getTempDir();
    const rel = makePluginSkillDir(tempDir, PLUGIN_NAME, PLUGIN_SKILL_REL);
    const item = makeStageItem(SUBJECT_NAME, { path: rel }, tempDir, 'subject');
    expect(item.role).toBe('subject');
    expect(item.pluginLayout?.relPathUnderPlugin).toBe(PLUGIN_SKILL_REL);
    expect(toForwardSlash(item.pluginLayout?.pluginRoot ?? '').endsWith(`/${PLUGIN_NAME}`)).toBe(true);
  });

  it('makeStageItem stages a plain dir flat with the subject role', () => {
    const tempDir = getTempDir();
    makePlainDir(tempDir, PLAIN_SKILL);
    const item = makeStageItem(PLAIN_SKILL, { path: PLAIN_SKILL }, tempDir, 'subject');
    expect(item).toEqual({ name: PLAIN_SKILL, source: { path: PLAIN_SKILL }, role: 'subject' });
    expect('pluginLayout' in item).toBe(false);
  });

  it('makeStageItem omits role when undefined', () => {
    const tempDir = getTempDir();
    makePlainDir(tempDir, PLAIN_SKILL);
    const item = makeStageItem(PLAIN_SKILL, { path: PLAIN_SKILL }, tempDir, undefined);
    expect('role' in item).toBe(false);
  });

  it('uses subjectSource for the subject item when provided', () => {
    const items = buildStageItems(
      { subject: 'my-skill', subjectSource: { path: '/built/dist/skills/my-skill' } } as never,
      '/repo',
    );
    const subject = items.find((i) => i.role === 'subject');
    expect(subject?.source).toEqual({ path: '/built/dist/skills/my-skill' });
  });

  it('falls back to {path: name} when subjectSource absent', () => {
    const items = buildStageItems({ subject: 'my-skill' } as never, '/repo');
    expect(items.find((i) => i.role === 'subject')?.source).toEqual({ path: 'my-skill' });
  });

  it('stages the subject plus every --with companion, each invocable with no role', () => {
    const tempDir = getTempDir();
    const helperOne = 'helper-one';
    const helperTwo = 'helper-two';
    makePlainDir(tempDir, 'subject');
    makePlainDir(tempDir, helperOne);
    makePlainDir(tempDir, helperTwo);

    const items = buildStageItems(
      makeOpts({
        subject: 'subject',
        withSources: { [helperOne]: { path: helperOne }, [helperTwo]: { path: helperTwo } },
      }),
      tempDir,
    );

    expect(items).toHaveLength(3);
    const subject = items.find((i) => i.role === 'subject');
    expect(subject?.name).toBe('subject');
    const companionNames = items
      .filter((i) => i.role !== 'subject')
      .map((i) => i.name)
      .sort((a, b) => a.localeCompare(b));
    expect(companionNames).toEqual([helperOne, helperTwo]);
    for (const item of items) {
      if (item.role === 'subject') continue;
      expect('role' in item).toBe(false);
      expect('optional' in item).toBe(false);
    }
    expect(items.find((i) => i.name === helperOne)?.source).toEqual({ path: helperOne });
    expect(items.find((i) => i.name === helperTwo)?.source).toEqual({ path: helperTwo });
  });

  it('stages every --with-optional companion carrying optional: true', () => {
    const tempDir = getTempDir();
    makePlainDir(tempDir, 'subject');
    makePlainDir(tempDir, 'opt-one');
    makePlainDir(tempDir, 'opt-two');

    const items = buildStageItems(
      makeOpts({
        subject: 'subject',
        withOptional: { 'opt-one': { path: 'opt-one' }, 'opt-two': { path: 'opt-two' } },
      }),
      tempDir,
    );

    expect(items).toHaveLength(3);
    const optionalItems = items.filter((i) => i.name !== 'subject');
    expect(optionalItems).toHaveLength(2);
    for (const item of optionalItems) {
      expect(item.optional).toBe(true);
      expect('role' in item).toBe(false);
    }
  });

  it('throws DuplicateStagedSkillError when a --with name collides with the subject name', () => {
    const tempDir = getTempDir();
    makePlainDir(tempDir, 'subject');
    let thrown: unknown;
    try {
      buildStageItems(
        makeOpts({ subject: 'subject', withSources: { subject: { path: OVERRIDE_LOC } } }),
        tempDir,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DuplicateStagedSkillError);
    expect((thrown as DuplicateStagedSkillError).name === 'DuplicateStagedSkillError').toBe(true);
    expect((thrown as Error).message).toContain('subject');
  });

  it('throws DuplicateStagedSkillError when the same name is used in --with and --with-optional', () => {
    const tempDir = getTempDir();
    makePlainDir(tempDir, 'subject');
    let thrown: unknown;
    try {
      buildStageItems(
        makeOpts({
          subject: 'subject',
          withSources: { helper: { path: OVERRIDE_LOC } },
          withOptional: { helper: { path: OVERRIDE_LOC } },
        }),
        tempDir,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DuplicateStagedSkillError);
    expect((thrown as Error).message).toContain('helper');
  });
});

// ---------------------------------------------------------------------------
// Dry-run summary builder
// ---------------------------------------------------------------------------

// Shared constants for the dry-run summary assertions (avoids sonarjs/no-duplicate-string).
// `--dry-run` BUILDS now (the "dry" part is the skill testing, not the build), so
// the summary reports what it DID rather than what a real run would do. The
// stale/fallback branches below are reachable only via `--no-build --dry-run`.
const DRY_RUN_BUILD_PHRASE = 'Built + staged the declared skill';
/** What the summary says when nothing was built (--no-build, or ack absent). */
const DRY_RUN_UNBUILT_PHRASE = 'Staged the declared skill WITHOUT building';
const DRY_RUN_FALLBACK_PHRASE = 'fell back to the source dir';

/** Build a minimal DryRunSummaryInput with the given overrides. */
function makeDryRunInput(overrides: Partial<DryRunSummaryInput> = {}): DryRunSummaryInput {
  return {
    wouldBuild: false,
    provenancePath: '/harness/results/provenance.json',
    provenanceFingerprint: 'abc123',
    provenanceEntryCount: 3,
    modelFlag: '--model claude-sonnet-5',
    evalCount: 2,
    concurrency: 4,
    graderModel: 'claude-sonnet-5',
    ...overrides,
  };
}

describe('buildDryRunSummary', () => {
  it('plain source subject: states stage-as-is, no build mention in opening line', () => {
    const summary = buildDryRunSummary(makeDryRunInput({ wouldBuild: false }));
    expect(summary).toContain('stage the source dir as-is');
    expect(summary).not.toContain(DRY_RUN_BUILD_PHRASE);
  });

  it('declared subject, no build + no dist: says it did NOT build, and fell back to source', () => {
    const summary = buildDryRunSummary(
      makeDryRunInput({ wouldBuild: true, dryRunStagedExistingDist: false }),
    );
    expect(summary).toContain(DRY_RUN_UNBUILT_PHRASE);
    expect(summary).not.toContain(DRY_RUN_BUILD_PHRASE);
    expect(summary).toContain(DRY_RUN_FALLBACK_PHRASE);
    expect(summary).not.toContain('STALE');
  });

  it('declared subject, no build + existing dist: says it did NOT build, flags stale, marks the fingerprint provisional', () => {
    const summary = buildDryRunSummary(
      makeDryRunInput({ wouldBuild: true, dryRunStagedExistingDist: true }),
    );
    expect(summary).toContain(DRY_RUN_UNBUILT_PHRASE);
    expect(summary).toContain('STALE');
    expect(summary).toContain('vat build');
    // A bare fingerprint from an unbuilt tree reads as authoritative; it must not.
    expect(summary).toContain('PROVISIONAL');
    expect(summary).not.toContain(DRY_RUN_FALLBACK_PHRASE);
  });

  it('declared subject that WAS built: states it built, with no stale/fallback/provisional caveat', () => {
    // dryRunStagedExistingDist absent = the normal acknowledged --dry-run path,
    // which builds. Nothing here is provisional: the staged tree is current.
    const summary = buildDryRunSummary(makeDryRunInput({ wouldBuild: true }));
    expect(summary).toContain(DRY_RUN_BUILD_PHRASE);
    expect(summary).not.toContain('STALE');
    expect(summary).not.toContain(DRY_RUN_FALLBACK_PHRASE);
    expect(summary).not.toContain('PROVISIONAL');
  });

  it('describes the executor→grader pipeline with eval count, concurrency, and models', () => {
    const summary = buildDryRunSummary(
      makeDryRunInput({ modelFlag: '--model opus', evalCount: 3, concurrency: 6, graderModel: 'claude-sonnet-5' }),
    );
    expect(summary).toContain('Would run 3 evals as executor→grader spawn pairs at concurrency 6.');
    expect(summary).toContain('Executor --model opus; grader model claude-sonnet-5');
  });

  it('uses singular phrasing for a single eval', () => {
    const summary = buildDryRunSummary(makeDryRunInput({ evalCount: 1 }));
    expect(summary).toContain('Would run 1 eval as executor→grader spawn pair at concurrency');
  });

  it('includes entry count and fingerprint in the manifest line', () => {
    const summary = buildDryRunSummary(
      makeDryRunInput({ provenanceEntryCount: 5, provenanceFingerprint: 'deadbeef' }),
    );
    expect(summary).toContain('5 entries');
    expect(summary).toContain('fingerprint: deadbeef');
  });

  it('uses singular "entry" for a count of 1', () => {
    const summary = buildDryRunSummary(makeDryRunInput({ provenanceEntryCount: 1 }));
    expect(summary).toContain('1 entry');
    expect(summary).not.toContain('1 entries');
  });

  it('includes the provenance path in the summary', () => {
    const customPath = '/harness/custom/results/provenance.json';
    const summary = buildDryRunSummary(makeDryRunInput({ provenancePath: customPath }));
    expect(summary).toContain(`Provenance: ${customPath}`);
  });
});

// A companion (--with/--with-optional) previewed from a stale dist
// under --dry-run silently warned nobody, while the byte-identical subject case
// warned loudly. buildStaleDistWarningLines is the ONE warning-construction used
// by both buildDryRunSummary (subject, unlabeled) and run.ts's companion
// resolution (labeled with the companion's alias + declared skill), so the two
// call sites never drift into two different strings for the same fact.
const COMPANION_ROLE_LABEL = "companion 'my-helper' (declared skill 'declared-pool')";

describe('buildStaleDistWarningLines', () => {
  it('subject (no label): matches the exact wording buildDryRunSummary emits for a stale subject dist', () => {
    const lines = buildStaleDistWarningLines();
    const summary = buildDryRunSummary(makeDryRunInput({ wouldBuild: true, dryRunStagedExistingDist: true }));
    for (const line of lines) expect(summary).toContain(line);
  });

  it('labeled (companion): names the companion so the two warnings are distinguishable', () => {
    const lines = buildStaleDistWarningLines(COMPANION_ROLE_LABEL);
    expect(lines[0]).toContain(COMPANION_ROLE_LABEL);
    expect(lines[0]).toContain('WITHOUT rebuilding');
    expect(lines[0]).toContain('STALE');
    expect(lines.join(' ')).toContain('vat build');
  });

  it('subject and labeled companion warnings are textually distinct', () => {
    const subjectLines = buildStaleDistWarningLines();
    const companionLines = buildStaleDistWarningLines(COMPANION_ROLE_LABEL);
    expect(subjectLines[0]).not.toEqual(companionLines[0]);
  });
});

// ---------------------------------------------------------------------------
// Preflight input
// ---------------------------------------------------------------------------

describe('buildPreflightInput', () => {
  const evalsPath = '/staged/evals/evals.json';
  const pluginDirs = ['/staged/a', '/staged/b'];

  it('shapes the preflight input from opts + knobs, defaulting authMode to auto', () => {
    const input = buildPreflightInput(evalsPath, pluginDirs, makeOpts(), { maxBudgetUsd: 5 });
    expect(input.evalInputPaths).toEqual([evalsPath]);
    expect(input.declaredDepDirs).toBe(pluginDirs);
    expect(input.authMode).toBe('auto');
    expect(input.costEstimate.maxBudgetUsd).toBe(5);
    expect('requireAuth' in input).toBe(false);
  });

  it('passes through an explicit auth mode and requireAuth', () => {
    const input = buildPreflightInput(
      evalsPath,
      pluginDirs,
      makeOpts({ auth: 'api-key', requireAuth: 'api-key' }),
      { maxBudgetUsd: 2 },
    );
    expect(input.authMode).toBe('api-key');
    expect(input.requireAuth).toBe('api-key');
    expect(input.costEstimate.maxBudgetUsd).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Harness cleanup
// ---------------------------------------------------------------------------

describe('cleanupHarness', () => {
  const { getTempDir } = setupTempDir('vat-cleanup-test-');

  it('removes the harness dir by default (created, not kept)', () => {
    const root = makeHarnessDir(getTempDir(), 'default');
    cleanupHarness(root, { keep: false, created: true });
    expect(existsSync(root)).toBe(false);
  });

  it('retains the dir when keep is set', () => {
    const root = makeHarnessDir(getTempDir(), 'kept');
    cleanupHarness(root, { keep: true, created: true });
    expect(existsSync(root)).toBe(true);
  });

  it('retains a user-supplied dir (created=false, e.g. --out/--workdir)', () => {
    const root = makeHarnessDir(getTempDir(), 'user-owned');
    cleanupHarness(root, { keep: false, created: false });
    expect(existsSync(root)).toBe(true);
  });

  it('is a no-op (no throw) on an already-removed dir', () => {
    const root = safePath.join(getTempDir(), 'missing');
    expect(() => cleanupHarness(root, { keep: false, created: true })).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a symlinked root — leaves the link target intact',
    () => {
      const target = makeHarnessDir(getTempDir(), 'symlink-target');
      const link = safePath.join(getTempDir(), 'symlink-root');
      symlinkSync(target, link);
      cleanupHarness(link, { keep: false, created: true });
      // The symlink target (and its contents) must survive — cleanup must not
      // follow a swapped symlink out of tmp.
      expect(existsSync(safePath.join(target, 'staged.txt'))).toBe(true);
    },
  );
});

describe('verdictExitCode', () => {
  it('returns Ok when all expectations passed (regardless of tolerance)', () => {
    expect(verdictExitCode(true, false)).toBe(SkillTestExitCode.Ok);
    expect(verdictExitCode(true, true)).toBe(SkillTestExitCode.Ok);
  });

  it('escalates a failing verdict to EvalFailure by DEFAULT (fail-closed)', () => {
    expect(verdictExitCode(false, false)).toBe(SkillTestExitCode.EvalFailure);
  });

  it('downgrades a failing verdict to Ok when eval failure is tolerated (opt-out)', () => {
    expect(verdictExitCode(false, true)).toBe(SkillTestExitCode.Ok);
  });
});

// ---------------------------------------------------------------------------
// Composite verdict + summary (Phase T)
// ---------------------------------------------------------------------------

/** Build a ToolEvalReport whose eval verdicts carry the given `passed` flags. */
function makeToolEval(passedFlags: boolean[]): ToolEvalReport {
  return { evals: passedFlags.map((passed, i) => ({ evalId: `e${i}`, passed })) };
}

const VERDICT_3_OF_3: GradingVerdict = { passed: 3, total: 3, allPassed: true };

describe('computeCompositeVerdict', () => {
  it('no tool verdicts → equals the output verdict', () => {
    const empty = makeToolEval([]);
    expect(computeCompositeVerdict(true, empty)).toBe(true);
    expect(computeCompositeVerdict(false, empty)).toBe(false);
  });

  it('output-pass AND every tool verdict passes → true', () => {
    expect(computeCompositeVerdict(true, makeToolEval([true, true]))).toBe(true);
  });

  it('output-pass but a tool verdict fails → false (composite FAIL)', () => {
    expect(computeCompositeVerdict(true, makeToolEval([true, false]))).toBe(false);
  });

  it('output-fail short-circuits to false regardless of tool verdicts', () => {
    expect(computeCompositeVerdict(false, makeToolEval([true, true]))).toBe(false);
  });
});

describe('resolveCompositeAllPassed', () => {
  const skip: SkippedEvalsSummary = { gatedByTier: 0, firstSkippedTier: 1, tiers: [], totalSkipped: 1 };

  it('equals the composite verdict when no tiers were skipped', () => {
    expect(resolveCompositeAllPassed(true, makeToolEval([true]), undefined)).toBe(true);
    expect(resolveCompositeAllPassed(false, makeToolEval([]), undefined)).toBe(false);
  });

  it('forces false when tiers were skipped even if every ran eval passed (skipped ≠ passed)', () => {
    expect(resolveCompositeAllPassed(true, makeToolEval([true]), skip)).toBe(false);
  });
});

describe('buildRunSummary', () => {
  it('reads PASS with counts and no suffix when everything passed', () => {
    expect(buildRunSummary(VERDICT_3_OF_3, makeToolEval([true]), true)).toBe('PASS 3/3');
  });

  it('appends a (N tool) suffix when tool verdicts failed though output looks all-green', () => {
    // Output counts are 3/3 (all prose expectations passed) but a tool verdict failed,
    // so the COMPOSITE reads FAIL and the suffix explains why the counts look green.
    expect(buildRunSummary(VERDICT_3_OF_3, makeToolEval([true, false]), false)).toBe('FAIL 3/3 (1 tool)');
  });

  it('omits the tool suffix for a plain output FAIL with no tool failures', () => {
    expect(buildRunSummary({ passed: 1, total: 2, allPassed: false }, makeToolEval([]), false)).toBe('FAIL 1/2');
  });
});

describe('buildRunSummaryWithSkips', () => {
  const FAIL_1_OF_2: GradingVerdict = { passed: 1, total: 2, allPassed: false };
  /** A fail-fast gate that skipped `evalIds` in tier 1, gated by a tier-0 failure. */
  const gatedSkip = (evalIds: string[]): SkippedEvalsSummary => ({
    gatedByTier: 0,
    firstSkippedTier: 1,
    tiers: [{ tier: 1, evalIds }],
    totalSkipped: evalIds.length,
  });

  it('returns the base summary unchanged when no tiers were skipped', () => {
    expect(buildRunSummaryWithSkips(VERDICT_3_OF_3, makeToolEval([true]), true, undefined)).toBe('PASS 3/3');
  });

  it('appends a legible SKIPPED note on its own line when the gate fired', () => {
    const summary = buildRunSummaryWithSkips(FAIL_1_OF_2, makeToolEval([]), false, gatedSkip(['x', 'y']));
    expect(summary).toBe('FAIL 1/2\nSKIPPED (fail-fast): tier 1 and above (2 evals) — gated by tier 0 failure');
  });

  it('appends the spend suffix on the verdict line, before any skipped note', () => {
    const summary = buildRunSummaryWithSkips(FAIL_1_OF_2, makeToolEval([]), false, gatedSkip(['x']), {
      totalUsd: 0.5,
      sessions: 2,
    });
    expect(summary).toBe(
      'FAIL 1/2 | ≈$0.50 across 2 sessions\nSKIPPED (fail-fast): tier 1 and above (1 eval) — gated by tier 0 failure',
    );
  });

  it('omits the spend suffix when no session reported a cost', () => {
    expect(buildRunSummaryWithSkips(VERDICT_3_OF_3, makeToolEval([true]), true, undefined, { totalUsd: 0, sessions: 0 })).toBe(
      'PASS 3/3',
    );
  });
});

describe('recordSessionCost', () => {
  it('folds a numeric cost into the accumulator and counts the session', () => {
    const acc = { totalUsd: 0, sessions: 0 };
    recordSessionCost(acc, 0.25);
    recordSessionCost(acc, 0.1);
    expect(acc).toEqual({ totalUsd: 0.35, sessions: 2 });
  });

  it('ignores an undefined or non-finite cost (mock spawn / missing result)', () => {
    const acc = { totalUsd: 1, sessions: 1 };
    recordSessionCost(acc, undefined);
    recordSessionCost(acc, Number.NaN);
    expect(acc).toEqual({ totalUsd: 1, sessions: 1 });
  });
});

describe('formatRunCostSuffix', () => {
  it('formats a cost + session count with two-decimal dollars', () => {
    expect(formatRunCostSuffix({ totalUsd: 1.234, sessions: 6 })).toBe(' | ≈$1.23 across 6 sessions');
  });

  it('uses the singular "session" for exactly one', () => {
    expect(formatRunCostSuffix({ totalUsd: 0.4, sessions: 1 })).toBe(' | ≈$0.40 across 1 session');
  });

  it('returns an empty string when no session reported a cost', () => {
    expect(formatRunCostSuffix({ totalUsd: 0, sessions: 0 })).toBe('');
    expect(formatRunCostSuffix(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// stageWorkspacesForRun
// ---------------------------------------------------------------------------

describe('stageWorkspacesForRun', () => {
  const { getTempDir } = setupTempDir('vat-wsrun-');

  it('materializes declared eval files under the harness workspaces dir', () => {
    const root = getTempDir();
    const evalsDir = safePath.join(root, 'evals');
    mkdirSyncReal(safePath.join(evalsDir, 'fixtures'), { recursive: true });
    writeFileSync(safePath.join(evalsDir, 'fixtures', 'doc.md'), 'x', 'utf-8');
    writeFileSync(safePath.join(evalsDir, EVALS_JSON), JSON.stringify({
      skill_name: 'demo',
      evals: [{ id: 5, prompt: 'p', expected_output: 'o', files: ['fixtures/doc.md'], expectations: ['e'] }],
    }), 'utf-8');
    const harnessRoot = safePath.join(root, 'harness');
    mkdirSyncReal(harnessRoot, { recursive: true });
    const { workspacesRoot, declaredEvalCount } = stageWorkspacesForRun(
      safePath.join(evalsDir, EVALS_JSON),
      harnessRoot,
    );
    expect(existsSync(safePath.join(workspacesRoot, '5', 'fixtures', 'doc.md'))).toBe(true);
    expect(declaredEvalCount).toBe(1);
  });

  it('throws EvalInputError when a declared eval file is absent', () => {
    const root = getTempDir();
    const evalsDir = safePath.join(root, 'evals');
    mkdirSyncReal(evalsDir, { recursive: true });
    const evalsPath = safePath.join(evalsDir, EVALS_JSON);
    writeFileSync(evalsPath, JSON.stringify({
      skill_name: 'demo',
      evals: [{ id: 1, prompt: 'p', expected_output: 'o', files: ['fixtures/nope.md'], expectations: ['e'] }],
    }), 'utf-8');
    const harnessRoot = safePath.join(root, 'harness');
    mkdirSyncReal(harnessRoot, { recursive: true });
    expect(() => stageWorkspacesForRun(evalsPath, harnessRoot)).toThrow(EvalInputError);
  });
});
