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

import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { InternalHarnessError } from '../../src/skill-test/exit-codes.js';
import {
  assertExperimenterSucceeded,
  buildPreflightInput,
  buildResolveCtx,
  buildStageItems,
  detectItemPluginLayout,
  flagDummyValueFor,
  isAcknowledged,
  makeStageItem,
  renderPreflightSummary,
  resolveKnobs,
  resolveScaffoldEvalsPath,
  resolveStallMs,
  resolveTimeoutMs,
  subjectSkillName,
  type RunHarnessOptions,
} from '../../src/skill-test/run-harness.js';
import { createTestPlugin, setupTempDir } from '../test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SUBJECT_NAME = 'report-tools';
const PLAIN_SKILL = 'plain-skill';
const PLUGIN_NAME = 'my-plugin';
const PLUGIN_SKILL_REL = 'skills/report-tools';
const OVERRIDE_LOC = 'override-loc';

/** Build a minimal RunHarnessOptions with the given skills and overrides. */
function makeOpts(overrides: Partial<RunHarnessOptions> = {}): RunHarnessOptions {
  return { skills: ['my-skill'], ...overrides };
}

/** Build a preflight check entry. */
function check(name: string, passed: boolean, message: string): { name: string; passed: boolean; message: string } {
  return { name, passed, message };
}

/** Build a spawn outcome for assertExperimenterSucceeded. */
function spawnOutcome(
  over: Partial<{ stalled: boolean; timedOut: boolean; status: number }> = {},
): { stalled: boolean; timedOut: boolean; status: number } {
  return { stalled: false, timedOut: false, status: 0, ...over };
}

/**
 * Assert that assertExperimenterSucceeded throws an InternalHarnessError whose
 * message contains the expected figure for a given non-success outcome.
 */
function expectExperimenterThrows(
  outcome: { stalled: boolean; timedOut: boolean; status: number },
  stallMs: number | undefined,
  timeoutMs: number,
  expectedFigure: string,
): void {
  let thrown: unknown;
  try {
    assertExperimenterSucceeded(outcome, stallMs, timeoutMs);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(InternalHarnessError);
  expect((thrown as Error).message).toContain(expectedFigure);
}

/** Create a plain (non-plugin) directory under the temp root and return its path. */
function makePlainDir(tempDir: string, name: string): string {
  const dir = safePath.join(tempDir, name);
  mkdirSyncReal(dir, { recursive: true });
  return dir;
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
  it('returns the default when timeout is undefined', () => {
    expect(resolveTimeoutMs(makeOpts())).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('converts seconds to milliseconds', () => {
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
// Experimenter success guard
// ---------------------------------------------------------------------------

describe('assertExperimenterSucceeded', () => {
  it('does not throw on a clean exit', () => {
    expect(() => assertExperimenterSucceeded(spawnOutcome(), undefined, 1000)).not.toThrow();
  });

  it('throws InternalHarnessError mentioning the stall figure', () => {
    expectExperimenterThrows(spawnOutcome({ stalled: true }), 250, 1000, '250');
  });

  it('throws InternalHarnessError mentioning the timeout figure', () => {
    expectExperimenterThrows(spawnOutcome({ timedOut: true }), undefined, 9000, '9000');
  });

  it('throws InternalHarnessError mentioning the non-zero status', () => {
    expectExperimenterThrows(spawnOutcome({ status: 137 }), undefined, 1000, '137');
  });
});

// ---------------------------------------------------------------------------
// Subject skill name
// ---------------------------------------------------------------------------

describe('subjectSkillName', () => {
  it('returns the trailing segment of a path-like skill arg', () => {
    expect(subjectSkillName(makeOpts({ skills: [`some/dir/${SUBJECT_NAME}`] }))).toBe(SUBJECT_NAME);
  });

  it('returns a plain name unchanged', () => {
    expect(subjectSkillName(makeOpts({ skills: [SUBJECT_NAME] }))).toBe(SUBJECT_NAME);
  });

  it("falls back to 'skill' when there are no skills", () => {
    expect(subjectSkillName(makeOpts({ skills: [] }))).toBe('skill');
  });
});

// ---------------------------------------------------------------------------
// Scaffold evals path
// ---------------------------------------------------------------------------

describe('resolveScaffoldEvalsPath', () => {
  const repoRoot = '/repo';
  const evalsSubpath = 'evals/evals.json';

  // repoRoot is an absolute POSIX-style path; on Windows safePath.resolve prepends
  // a drive letter, so assertions anchor on the resolved root + relative tail
  // rather than a hardcoded literal (the Windows CI gate).
  const resolvedRepoRoot = toForwardSlash(safePath.resolve(repoRoot));

  it('resolves against repoRoot + the positional name when no override', () => {
    const out = toForwardSlash(resolveScaffoldEvalsPath(makeOpts({ skills: ['skills/foo'] }), repoRoot, evalsSubpath));
    expect(out.startsWith(resolvedRepoRoot)).toBe(true);
    expect(out.endsWith('/skills/foo/evals/evals.json')).toBe(true);
  });

  it('honors a withSources[name].path override', () => {
    const out = toForwardSlash(
      resolveScaffoldEvalsPath(
        makeOpts({ skills: ['foo'], withSources: { foo: { path: 'custom/loc' } } }),
        repoRoot,
        evalsSubpath,
      ),
    );
    expect(out.startsWith(resolvedRepoRoot)).toBe(true);
    expect(out.endsWith('/custom/loc/evals/evals.json')).toBe(true);
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

  it('buildStageItems tags the first skill subject and appends optional with no role', () => {
    const tempDir = getTempDir();
    makePlainDir(tempDir, 'first');
    makePlainDir(tempDir, 'second');
    makePlainDir(tempDir, 'opt');

    const items = buildStageItems(
      makeOpts({ skills: ['first', 'second'], withOptional: { opt: { path: 'opt' } } }),
      tempDir,
    );

    expect(items).toHaveLength(3);
    expect(items[0]?.role).toBe('subject');
    expect('role' in (items[1] ?? {})).toBe(false);
    expect(items[2]?.name).toBe('opt');
    expect('role' in (items[2] ?? {})).toBe(false);
  });

  it('uses subjectSource for the subject item when provided', () => {
    const items = buildStageItems(
      { skills: ['my-skill'], subjectSource: { path: '/built/dist/skills/my-skill' } } as never,
      '/repo',
    );
    const subject = items.find((i) => i.role === 'subject');
    expect(subject?.source).toEqual({ path: '/built/dist/skills/my-skill' });
  });

  it('falls back to {path: name} when subjectSource absent', () => {
    const items = buildStageItems({ skills: ['my-skill'] } as never, '/repo');
    expect(items.find((i) => i.role === 'subject')?.source).toEqual({ path: 'my-skill' });
  });

  it('buildStageItems uses the withSources override for a primary skill', () => {
    const tempDir = getTempDir();
    makePlainDir(tempDir, OVERRIDE_LOC);
    const items = buildStageItems(
      makeOpts({ skills: ['first'], withSources: { first: { path: OVERRIDE_LOC } } }),
      tempDir,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.source).toEqual({ path: OVERRIDE_LOC });
    expect(items[0]?.role).toBe('subject');
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
