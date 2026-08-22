/**
 * Unit tests for `vat skill test run` CLI orchestration.
 *
 * These tests mock `runSkillTestHarness` entirely so no real binary, staging,
 * or filesystem work runs. The goal is to verify that:
 *   - exit 0  on happy-path success
 *   - exit 3  when BootstrapNeededError is thrown
 *   - exit 2  when a preflight-class error is thrown (HarnessLocationError)
 *   - exit 1  when an internal/parse-failure error is thrown (InternalHarnessError)
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import * as harness from '@vibe-agent-toolkit/agent-skills';
import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';

import * as pluginBuild from '../src/commands/claude/plugin/build.js';
import {
  buildMemoKey,
  createSkillTestRunCommand,
  deriveDeclaredExecutableNames,
  descriptorsToRecord,
  isPathSourceTarget,
  parseWithFlags,
  resolveCappedKnob,
  resolveCompanionSources,
  resolveCompanionSpec,
  resolveSubjectForTest,
  runSkillTestRun,
  type BuildFlags,
  type BuildMemo,
} from '../src/commands/skill/test/run.js';
import { findDeclaredSkillForSourceDir, resetSkillDiscoveryCache } from '../src/skill-resolution/index.js';

import {
  setupReferenceFixture,
  type NestedProjectFixture,
  type ReferenceFixture,
  type ReferenceFixtureSpec,
} from './skill-resolution/helpers.js';
import { createTestTempDir } from './system/test-common.js';

/** VAT project config filename — shared constant so the literal isn't repeated 3+ times. */
const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/** Path-form subject so resolution returns `source` without a declared skill. */
const PATH_SUBJECT = './my-skill';

/** Name of the config-declared (buildable) pool skill used across resolution tests. */
const DECLARED_POOL = 'declared-pool';

/** Pinned model string used across the #7 path-honors-config tests. */
const SONNET_MODEL = 'claude-sonnet-5';

/** A fresh per-call build memo (run.ts creates one per run; unit tests create their own). */
function newBuildMemo(): BuildMemo {
  return new Set();
}

/** Write a minimal SKILL.md into a mock-built dist dir (verifyBuiltDist requires it). */
function writeDistSkillMd(distDir: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path from mock build output
  writeFileSync(
    safePath.join(distDir, 'SKILL.md'),
    '---\nname: dist-skill\ndescription: Synthetic built SKILL.md for mock dist verification.\n---\n\nBody.\n',
  );
}

/**
 * Spy `packageSkill` with a mock that behaves like the real thing in the TWO ways
 * run.ts now depends on: it CREATES its `outputPath` AND writes a `SKILL.md` inside
 * it. run.ts verifies the dist materialized (dir + SKILL.md) after a "successful"
 * build, so a mock that omitted either would (correctly) be reported as a build
 * that produced no output / no skill.
 */
function spyPackageSkillCreatingDist() {
  return vi.spyOn(harness, 'packageSkill').mockImplementation((async (
    _skillPath: string,
    options: { outputPath: string },
  ) => {
    mkdirSyncReal(options.outputPath, { recursive: true });
    writeDistSkillMd(options.outputPath);
  }) as never);
}

/**
 * Spy `runClaudePluginBuild` (the marketplace-wide build behind a plugin-local
 * skill) with a mock that creates the given skills' dist dirs (each with a
 * `SKILL.md`) — one call materializes EVERY skill in the marketplace, which is
 * exactly why the memo keys plugin-local builds by marketplace rather than by skill.
 */
function spyPluginBuildCreatingDists(distDirs: string[]) {
  return vi.spyOn(pluginBuild, 'runClaudePluginBuild').mockImplementation((async () => {
    for (const dir of distDirs) {
      mkdirSyncReal(dir, { recursive: true });
      writeDistSkillMd(dir);
    }
    return [];
  }) as never);
}

/** The `--with` alias used across companion-failure tests (deliberately != the declared skill name). */
const COMPANION_ALIAS = 'my-helper';

/** Name of the config-declared PLUGIN-LOCAL skill used in the destructive-build tests. */
const PLUGIN_LOCAL_SKILL = 'plug-solo';

/** Message a mocked build failure carries — asserted to survive into the surfaced error/note. */
const BUILD_FAILURE_MESSAGE = 'synthetic build failure';

/** Build gating with the §12 ack present and no build-skipping flags — the common case. */
const ACKED_BUILD_FLAGS: BuildFlags = { noBuild: false, dryRun: false, acknowledged: true, explicitAck: true };

/** Spy `packageSkill` with a build that THROWS — the genuine pool build-failure path. */
function spyPackageSkillFailing() {
  return vi.spyOn(harness, 'packageSkill').mockImplementation((() => {
    throw new Error(BUILD_FAILURE_MESSAGE);
  }) as never);
}

/** Message of a caught unknown error (tests assert on the surfaced text). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve a declared-skill companion that is EXPECTED to fail, returning the thrown
 * error (never re-throwing) so a test can assert both its class and its message.
 */
async function companionBuildError(sourceDir: string, repoRoot: string, optional: boolean): Promise<unknown> {
  return resolveCompanionSpec(
    COMPANION_ALIAS,
    { path: sourceDir },
    repoRoot,
    ACKED_BUILD_FLAGS,
    optional,
    newBuildMemo(),
  ).catch((e: unknown) => e);
}

// Fixture + spies shared by the M2 (security ack) and issue #158 (companion build)
// end-to-end tests: a DECLARED_POOL project with process.cwd() mocked to its root
// and packageSkill spied so the tests can assert whether a build actually ran.
function setupDeclaredPoolFixtureWithPkgSpy() {
  const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
  resetSkillDiscoveryCache();
  vi.spyOn(process, 'cwd').mockReturnValue(fx.root);
  const pkg = spyPackageSkillCreatingDist();
  return { fx, pkg };
}

// Mocks runSkillTestHarness with the given result, captures stdout/stderr writes
// while runSkillTestRun executes, and returns the captured write payloads.
async function runAndCaptureStreams(result: {
  harnessPath: string;
  exitCode: number;
  summary: string;
}): Promise<{ stdoutCalls: string[]; stderrCalls: string[] }> {
  vi.spyOn(harness, 'runSkillTestHarness').mockResolvedValue(result);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

  await runSkillTestRun(PATH_SUBJECT, {});

  return {
    stdoutCalls: stdoutSpy.mock.calls.map((c) => String(c[0])),
    stderrCalls: stderrSpy.mock.calls.map((c) => String(c[0])),
  };
}

describe('vat skill test run (orchestration)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits 0 and prints the harness path on success', async () => {
    vi.spyOn(harness, 'runSkillTestHarness').mockResolvedValue({
      harnessPath: '/h',
      exitCode: 0,
      summary: 'PASS 3/3',
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun(PATH_SUBJECT, {});
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 3 on guided bootstrap', async () => {
    const { BootstrapNeededError } = await import('@vibe-agent-toolkit/agent-skills');
    vi.spyOn(harness, 'runSkillTestHarness').mockRejectedValue(
      new BootstrapNeededError('/h/evals/evals.json'),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun(PATH_SUBJECT, {});
    expect(exit).toHaveBeenCalledWith(3);
  });

  it('exits 2 on preflight-class error (HarnessLocationError)', async () => {
    const { HarnessLocationError } = await import('@vibe-agent-toolkit/agent-skills');
    vi.spyOn(harness, 'runSkillTestHarness').mockRejectedValue(
      new HarnessLocationError('harness root is unsafe'),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun(PATH_SUBJECT, {});
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('exits 1 on internal harness error (InternalHarnessError)', async () => {
    const { InternalHarnessError } = await import('@vibe-agent-toolkit/agent-skills');
    vi.spyOn(harness, 'runSkillTestHarness').mockRejectedValue(
      new InternalHarnessError('grading.json missing'),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun(PATH_SUBJECT, {});
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('surfaces the harness EvalFailure exit code (4) unchanged — not remapped or swallowed', async () => {
    vi.spyOn(harness, 'runSkillTestHarness').mockResolvedValue({
      harnessPath: '/h',
      exitCode: 4,
      summary: 'FAIL 1/2',
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun(PATH_SUBJECT, {});
    expect(exit).toHaveBeenCalledWith(4);
  });

  // A bad usage flag is validated BEFORE the async harness work. Without the
  // preflight guard these surfaced as an unhandled promise rejection (raw stack,
  // exit 1); they must now exit 2 (preflight) with a clean message and never
  // reach the harness. process.exit is mocked to throw so control actually stops.
  it('exits 2 on an unrecognized --auth value (never reaches the harness)', async () => {
    await expectPreflightExit2({ auth: 'bogus' });
  });

  it('exits 2 on a non-numeric --max-turns (never reaches the harness)', async () => {
    await expectPreflightExit2({ maxTurns: 'abc' });
  });

  it('exits 2 on a non-numeric --concurrency (never reaches the harness)', async () => {
    await expectPreflightExit2({ concurrency: 'abc' });
  });

  it('exits 2 on a non-positive --concurrency (never reaches the harness)', async () => {
    await expectPreflightExit2({ concurrency: '0' });
  });
});

// resolveCappedKnob encodes the security-critical asymmetry: a committed config
// value may only LOWER a built-in cost/runtime cap, while a CLI flag (explicit
// operator intent) may raise it. A stderr note is emitted when a config value is
// clamped — asserted here so the clamp is never silent.
describe('resolveCappedKnob (config may lower a cap but never raise it)', () => {
  const CAP = 50;
  const FLAG = '--max-turns';

  afterEach(() => vi.restoreAllMocks());

  it('lets a CLI flag exceed the built-in cap (explicit operator intent)', () => {
    expect(resolveCappedKnob(500, undefined, CAP, FLAG)).toBe(500);
  });

  it('clamps a config value that tries to exceed the cap, and warns', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    expect(resolveCappedKnob(undefined, 999, CAP, FLAG)).toBe(CAP);
    expect(stderr).toHaveBeenCalledOnce();
    expect(String(stderr.mock.calls[0]?.[0])).toContain('exceeds the built-in safety cap');
  });

  it('passes a config value that is at or below the cap through unchanged (no warn)', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    expect(resolveCappedKnob(undefined, 10, CAP, FLAG)).toBe(10);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('lets a flag win over config even when the config value is higher', () => {
    expect(resolveCappedKnob(5, 999, CAP, FLAG)).toBe(5);
  });

  it('returns undefined when neither source set the knob (domain default applies)', () => {
    expect(resolveCappedKnob(undefined, undefined, CAP, FLAG)).toBeUndefined();
  });
});

// Asserts a usage-level flag fails preflight: runSkillTestRun rejects with the
// preflight exit code (2, via a process.exit mock that throws) and the harness
// is never invoked.
async function expectPreflightExit2(
  options: Parameters<typeof runSkillTestRun>[1],
): Promise<void> {
  const harnessSpy = vi.spyOn(harness, 'runSkillTestHarness');
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${String(code)}`);
  }) as never);
  await expect(runSkillTestRun(PATH_SUBJECT, options)).rejects.toThrow('exit:2');
  expect(harnessSpy).not.toHaveBeenCalled();
}

// Mocks runSkillTestHarness, runs runSkillTestRun, and returns the RunHarnessOptions
// the mock received so tests can assert env/passEnv plumbing.
async function runAndCaptureOpts(
  subject: string,
  options: Parameters<typeof runSkillTestRun>[1],
): Promise<Record<string, unknown>> {
  const spy = vi
    .spyOn(harness, 'runSkillTestHarness')
    .mockResolvedValue({ harnessPath: '/h', exitCode: 0, summary: 'PASS 1/1' });
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  await runSkillTestRun(subject, options);
  return spy.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
}

const ENV_TEST_SKILL = './acme-skill';

/** Grader model values used across the top-level `test:` config precedence tests. */
const CONFIG_GRADER_MODEL = 'config-grader';
const FLAG_GRADER_MODEL = 'flag-grader';

/** Write a throwaway project config with a top-level `test:` node and point VAT_TEST_CONFIG at it. */
function stubGlobalTestConfig(testNode: Record<string, unknown>): void {
  const dir = createTestTempDir('vat-global-test-config-');
  const configPath = safePath.join(dir, CONFIG_FILENAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path from createTestTempDir
  writeFileSync(configPath, yaml.stringify({ version: 1, test: testNode }));
  process.env['VAT_TEST_CONFIG'] = configPath;
}

describe('vat skill test run (env plumbing)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses --env KEY=VALUE into an env record (literal ${...} preserved)', async () => {
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      env: ['CUSTOMER_SNAPSHOT_PATH=${fixturesDir}/snap.json'],
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.env).toEqual({ CUSTOMER_SNAPSHOT_PATH: '${fixturesDir}/snap.json' });
  });

  it('splits an --env value on the first = only', async () => {
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      env: ['FOO=a=b'],
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.env).toEqual({ FOO: 'a=b' });
  });

  it('unions and de-duplicates --pass-env names', async () => {
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      passEnv: ['VENDOR_LICENSE_KEY', 'VENDOR_LICENSE_KEY', 'OTHER'],
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.passEnv).toEqual(['VENDOR_LICENSE_KEY', 'OTHER']);
  });

  it('leaves env and passEnv undefined when no env flags are given', async () => {
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.env).toBeUndefined();
    expect(opts.passEnv).toBeUndefined();
  });

  it('threads --allow-eval-failure through to the harness opts as tolerateEvalFailure', async () => {
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      allowEvalFailure: true,
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.tolerateEvalFailure).toBe(true);
  });

  it('leaves tolerateEvalFailure undefined by default (fail-closed on eval failure)', async () => {
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.tolerateEvalFailure).toBeUndefined();
  });
});

// `--evals` is what makes an installed skill testable at all: a correctly
// packaged skill ships no suite (it is the answer key), so the suite has to come
// from outside its tree. The flag resolves against the CURRENT DIRECTORY, unlike
// config `test.evals`, which resolves against the skill source — an operator
// typing a shell path means the path they typed.
describe('vat skill test run (--evals resolves against the cwd)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves a relative --evals to an absolute path before it reaches the harness', async () => {
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      evals: './audit-corpus/their-skill.json',
      iUnderstandThisRunsSkillCode: true,
    });
    // Absolute, because the harness anchors a *relative* value at the skill
    // source — which for an out-of-tree suite is the wrong base entirely.
    expect(toForwardSlash(opts.evalsSubpath ?? '')).toBe(
      toForwardSlash(safePath.resolve(process.cwd(), 'audit-corpus/their-skill.json')),
    );
  });

  it('passes an absolute --evals through unchanged', async () => {
    const absolute = safePath.resolve('/corpora/their-skill.json');
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      evals: absolute,
      iUnderstandThisRunsSkillCode: true,
    });
    expect(toForwardSlash(opts.evalsSubpath ?? '')).toBe(toForwardSlash(absolute));
  });

  it('leaves evalsSubpath undefined without the flag, so the convention still applies', async () => {
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.evalsSubpath).toBeUndefined();
  });
});

describe('vat skill test run (output routing)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes Summary: to stdout and Harness: to stderr', async () => {
    const { stdoutCalls, stderrCalls } = await runAndCaptureStreams({
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      harnessPath: '/tmp/h',
      exitCode: 0,
      summary: 'PASS 2/2',
    });

    expect(stdoutCalls.some((s) => s.includes('Summary:'))).toBe(true); // Summary → stdout
    expect(stderrCalls.some((s) => s.includes('Harness:'))).toBe(true); // Harness debug → stderr
    expect(stderrCalls.some((s) => s.includes('Summary:'))).toBe(false); // Summary not on stderr
  });

  // On a default run the harness root holds nothing but `results/` by the time the
  // operator reads this — everything else was staged untrusted bytes that cleanup
  // evicts. The `Harness:` line alone therefore points at a directory whose useful
  // contents the operator has to guess at, so the artifact dir is named outright.
  it('names the results dir on stderr when the harness reports one', async () => {
    const { stderrCalls } = await runAndCaptureStreams({
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      harnessPath: '/tmp/h',
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      resultsPath: '/tmp/h/results',
      exitCode: 0,
      summary: 'PASS 2/2',
    });

    expect(stderrCalls.some((s) => s.includes('Results: /tmp/h/results'))).toBe(true);
  });

  // Absent for a run that ended before the results dir existed (a preflight
  // refusal, a bootstrap scaffold) — an empty `Results:` line would send the
  // operator to a path that was never created.
  it('omits the results line when the run reported no results dir', async () => {
    const { stderrCalls } = await runAndCaptureStreams({
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      harnessPath: '/tmp/h',
      exitCode: 2,
      summary: 'Security acknowledgment required.',
    });

    expect(stderrCalls.some((s) => s.includes('Results:'))).toBe(false);
  });

  it('does not write Summary: to stderr on non-zero exit', async () => {
    const { stdoutCalls, stderrCalls } = await runAndCaptureStreams({
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      harnessPath: '/tmp/h',
      exitCode: 1,
      summary: 'FAIL 1/3',
    });

    expect(stdoutCalls.some((s) => s.includes('Summary:'))).toBe(true);
    expect(stderrCalls.some((s) => s.includes('Summary:'))).toBe(false);
  });
});

// isPathSourceTarget flags a CONFIG-BLIND path target (staged as-is, mapping to no
// declared skill) — distinct from a NAME target (buildable) and from a path that DOES
// map to a declared skill (linkedToDeclaredSkill). The warning fires only for the blind case.
describe('deriveDeclaredExecutableNames (Phase T grader recognition aid)', () => {
  it('returns undefined for absent or empty executables', () => {
    expect(deriveDeclaredExecutableNames(undefined)).toBeUndefined();
    expect(deriveDeclaredExecutableNames([])).toBeUndefined();
  });

  it('maps each executable to { name: basename-without-ext, howInvoked, kind }', () => {
    const out = deriveDeclaredExecutableNames([
      { path: 'scripts/csvsum.py', kind: 'python', howInvoked: 'uv run csvsum.py' },
      { path: 'dist/csvsum.mjs', kind: 'node', howInvoked: 'node dist/csvsum.mjs' },
      { path: 'bin/csvsum', kind: 'binary', howInvoked: './csvsum' },
    ]);
    expect(out).toEqual([
      { name: 'csvsum', howInvoked: 'uv run csvsum.py', kind: 'python' },
      { name: 'csvsum', howInvoked: 'node dist/csvsum.mjs', kind: 'node' },
      { name: 'csvsum', howInvoked: './csvsum', kind: 'binary' },
    ]);
  });
});

describe('isPathSourceTarget', () => {
  it('is true for a plain {path} source that would NOT be built and maps to no declared skill', () => {
    expect(isPathSourceTarget({ wouldBuild: false, subjectSource: { path: './my-skill' } })).toBe(true);
  });

  it('is false for a config-declared (buildable) NAME target', () => {
    expect(isPathSourceTarget({ wouldBuild: true, subjectSource: { path: '/built/dist/my-skill' } })).toBe(false);
  });

  it('is false for a path that maps back to a declared skill (config IS honored)', () => {
    expect(
      isPathSourceTarget({ wouldBuild: false, subjectSource: { path: '/p/dist/skills/x' }, linkedToDeclaredSkill: true }),
    ).toBe(false);
  });

  it('is false for a non-path source (e.g. npm) even when not built', () => {
    expect(isPathSourceTarget({ wouldBuild: false, subjectSource: { npm: '@scope/s@1.0.0' } })).toBe(false);
  });
});

describe('vat skill test run (path-target config-blind warning — #7)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns on stderr that a config-blind path maps to no declared skill', async () => {
    const { stderrCalls } = await runAndCaptureStreams({
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      harnessPath: '/tmp/h',
      exitCode: 0,
      summary: 'PASS 1/1',
    });
    expect(stderrCalls.some((s) => s.includes('maps to no declared skill'))).toBe(true);
    expect(stderrCalls.some((s) => s.includes('Pass the skill NAME'))).toBe(true);
  });
});

describe('vat skill test run (path target honors declared test: config — #7)', () => {
  afterEach(() => vi.restoreAllMocks());

  const CONFIGURED = 'configured-skill';

  it('a path at a declared skill\'s dist honors its model/evals/timeout and anchors evals at the source', async () => {
    const fx = setupReferenceFixture({
      // timeout stays UNDER the 300s built-in cap: a committed config may only lower it,
      // so a sub-cap value passes through unclamped and proves the knob is honored.
      pool: [CONFIGURED],
      poolTest: { [CONFIGURED]: { evals: 'evals/suite.json', model: SONNET_MODEL, timeout: 240 } },
    });
    resetSkillDiscoveryCache();
    // An ABSOLUTE dist path keys entirely off itself (the reverse-lookup walks up from
    // the path, config-first), so it honors config regardless of the process cwd.
    const opts = await runAndCaptureOpts(fx.poolDistDir(CONFIGURED), { iUnderstandThisRunsSkillCode: true });
    expect(opts.model).toBe(SONNET_MODEL);
    expect(opts.evalsSubpath).toBe('evals/suite.json');
    expect(opts.timeout).toBe(240);
    expect(toForwardSlash(String(opts.subjectScaffoldDir))).toBe(safePath.join(fx.root, 'skills', CONFIGURED));
  });

  it('a path at a declared PLUGIN-LOCAL skill\'s dist also honors its test config', async () => {
    const PL = 'pl-configured';
    const fx = setupReferenceFixture({ pluginLocal: [PL], poolTest: { [PL]: { model: SONNET_MODEL } } });
    resetSkillDiscoveryCache();
    const opts = await runAndCaptureOpts(fx.pluginDistDir(PL), { iUnderstandThisRunsSkillCode: true });
    expect(opts.model).toBe(SONNET_MODEL);
    expect(opts.subjectScaffoldDir).toBeDefined(); // anchored at the plugin skill's source
  });

  it('a config-blind path (matches no declared skill) applies NO test config', async () => {
    const fx = setupReferenceFixture({ pool: [CONFIGURED], poolTest: { [CONFIGURED]: { model: SONNET_MODEL } } });
    resetSkillDiscoveryCache();
    // Absolute path under the same config but NOT any declared skill's dist → config-blind.
    const ghost = safePath.join(fx.root, 'dist', 'skills', 'ghost-not-declared');
    const opts = await runAndCaptureOpts(ghost, { iUnderstandThisRunsSkillCode: true });
    expect(opts.model).toBeUndefined();
    expect(opts.evalsSubpath).toBeUndefined();
  });
});

describe('resolveSubjectForTest (run.ts subject resolution)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('name-miss → throws a SkillBuildError listing known skills', async () => {
    const fx = setupReferenceFixture({ pool: ['declared'] });
    resetSkillDiscoveryCache();
    await expect(
      resolveSubjectForTest('undeclared', fx.root, { noBuild: false, dryRun: false, acknowledged: false }, newBuildMemo(), undefined),
    ).rejects.toThrow(/no skill named 'undeclared'/);
  });

  it('--no-build with no built dist → an exit-2 build error', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    await expect(
      resolveSubjectForTest(DECLARED_POOL, fx.root, { noBuild: true, dryRun: false, acknowledged: false }, newBuildMemo(), undefined),
    ).rejects.toThrow(/no built dist/);
  });

  it('source-arm path → returns { subjectSource: { path } } without building', async () => {
    const out = await resolveSubjectForTest('./some/dist', process.cwd(), {
      noBuild: false,
      dryRun: false,
      acknowledged: false,
    }, newBuildMemo(), undefined);
    expect(out.subjectSource).toEqual({ path: './some/dist' });
    expect(out.rebuilt).toBe(false);
  });

  it('path AT a declared skill\'s dist → linked, scaffold anchored at the AUTHORED source (#7)', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const out = await resolveSubjectForTest(fx.poolDistDir(DECLARED_POOL), fx.root, {
      noBuild: false,
      dryRun: false,
      acknowledged: false,
    }, newBuildMemo(), undefined);
    expect(out.wouldBuild).toBe(false); // staged as-is, never rebuilt
    expect(out.linkedToDeclaredSkill).toBe(true);
    // Scaffold dir is the skill's source dir (dirname of SKILL.md), NOT the dist path,
    // so the authored eval suite resolves + overlays from there.
    expect(toForwardSlash(String(out.subjectScaffoldDir))).toBe(safePath.join(fx.root, 'skills', DECLARED_POOL));
  });

  it('path AT a declared skill\'s SOURCE dir → buildable (wouldBuild=true), routed through the buildable branch not the source branch', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const pkg = spyPackageSkillCreatingDist();
    const out = await resolveSubjectForTest(dirname(fx.poolSkillMd(DECLARED_POOL)), fx.root, {
      noBuild: false,
      dryRun: false,
      acknowledged: true,
      explicitAck: true,
    }, newBuildMemo(), undefined);
    // This is the new #159/#158-parity contract: a path AT the SOURCE dir is NOT
    // staged as-is like the dist-path case above — it resolves `buildable` and is
    // actually built, exactly like the bare name would be.
    expect(out.wouldBuild).toBe(true);
    expect(out.rebuilt).toBe(true);
    expect(pkg).toHaveBeenCalled();
    expect(toForwardSlash(String(out.subjectSource && 'path' in out.subjectSource ? out.subjectSource.path : ''))).toBe(
      toForwardSlash(fx.poolDistDir(DECLARED_POOL)),
    );
  });
});

// Stage a declared-pool fixture, spy packageSkill, and resolve the buildable
// subject for the given gate inputs — shared by the ack-present / dry-run cases.
async function resolveBuildableWithPkgSpy(opts: { dryRun: boolean; acknowledged: boolean }) {
  const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
  resetSkillDiscoveryCache();
  const pkg = spyPackageSkillCreatingDist();
  const out = await resolveSubjectForTest(DECLARED_POOL, fx.root, {
    noBuild: false,
    dryRun: opts.dryRun,
    acknowledged: opts.acknowledged,
  }, newBuildMemo(), undefined);
  return { out, pkg };
}

describe('resolveSubjectForTest (security ack gates the build — M2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('buildable subject + ack ABSENT + non-dry-run → SecurityAckError BEFORE any build/pre-stage command runs', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const preStage = vi.spyOn(harness, 'runPreStageBuild').mockImplementation((() => undefined) as never);
    const pkg = spyPackageSkillCreatingDist();

    await expect(
      resolveSubjectForTest(
        DECLARED_POOL,
        fx.root,
        { noBuild: false, dryRun: false, acknowledged: false },
        newBuildMemo(),
        // An ARBITRARY committed shell command — must NOT run without the ack.
        'echo pwned > /tmp/pwned',
      ),
    ).rejects.toThrow(/Security acknowledgment required\. Pass --i-understand-this-runs-skill-code to proceed\./);

    expect(preStage).not.toHaveBeenCalled();
    expect(pkg).not.toHaveBeenCalled();
  });

  it('buildable subject + ack PRESENT → build proceeds (packageSkill invoked, rebuilt=true)', async () => {
    const { out, pkg } = await resolveBuildableWithPkgSpy({ dryRun: false, acknowledged: true, explicitAck: true });
    expect(pkg).toHaveBeenCalledTimes(1);
    expect(out.rebuilt).toBe(true);
  });

  it('--dry-run with ack ABSENT does NOT trigger SecurityAckError (no build runs)', async () => {
    const { out, pkg } = await resolveBuildableWithPkgSpy({ dryRun: true, acknowledged: false });
    expect(pkg).not.toHaveBeenCalled();
    expect(out.wouldBuild).toBe(true);
  });
});

describe('runSkillTestRun (security ack gates the build end-to-end — M2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('buildable subject + ack ABSENT + non-dry-run → exit 2 and neither build nor harness runs', async () => {
    const { pkg } = setupDeclaredPoolFixtureWithPkgSpy();
    const harnessSpy = vi
      .spyOn(harness, 'runSkillTestHarness')
      .mockResolvedValue({ harnessPath: '/h', exitCode: 0, summary: '' });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    await runSkillTestRun(DECLARED_POOL, {});

    expect(exit).toHaveBeenCalledWith(2);
    expect(pkg).not.toHaveBeenCalled();
    expect(harnessSpy).not.toHaveBeenCalled();
  });
});

// Issue #158: a --with/--with-optional companion given as `path:<source-dir>` was
// staged as a raw tree-copy, silently skipping the declared skill's `files:`
// injection (e.g. a build-artifact executable) that the SUBJECT always gets.
// resolveCompanionSpec/resolveCompanionSources give a companion the SAME
// buildable treatment as resolveSubjectForTest, gated by the same flags.
describe('resolveCompanionSpec (companion build resolution — issue #158)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a path AT a declared skill\'s source dir + ack PRESENT → builds and rewrites to the dist path', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const pkg = spyPackageSkillCreatingDist();

    const spec = await resolveCompanionSpec(
      'companion',
      { path: dirname(fx.poolSkillMd(DECLARED_POOL)) },
      fx.root,
      { noBuild: false, dryRun: false, acknowledged: true, explicitAck: true },
      false,
      newBuildMemo(),
    );

    expect(pkg).toHaveBeenCalledTimes(1);
    expect(spec).toEqual({ path: fx.poolDistDir(DECLARED_POOL) });
  });

  it('a path AT a declared skill\'s source dir + ack ABSENT + REQUIRED → throws SecurityAckError, no build', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const pkg = spyPackageSkillCreatingDist();
    const { SecurityAckError } = await import('@vibe-agent-toolkit/agent-skills');

    await expect(
      resolveCompanionSpec(
        'companion',
        { path: dirname(fx.poolSkillMd(DECLARED_POOL)) },
        fx.root,
        { noBuild: false, dryRun: false, acknowledged: false },
        false,
        newBuildMemo(),
      ),
    ).rejects.toBeInstanceOf(SecurityAckError);
    expect(pkg).not.toHaveBeenCalled();
  });

  it('a path matching NO declared skill → returned unchanged, no build attempted', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const pkg = spyPackageSkillCreatingDist();
    const outsidePath = safePath.join(fx.root, 'not-a-skill-dir');

    const spec = await resolveCompanionSpec(
      'companion',
      { path: outsidePath },
      fx.root,
      { noBuild: false, dryRun: false, acknowledged: true, explicitAck: true },
      false,
      newBuildMemo(),
    );

    expect(pkg).not.toHaveBeenCalled();
    expect(spec).toEqual({ path: outsidePath });
  });

  it('a non-path spec (npm:) is left untouched, no lookup performed', async () => {
    const spec = await resolveCompanionSpec(
      'companion',
      { npm: '@scope/s@1.2.3' },
      process.cwd(),
      { noBuild: false, dryRun: false, acknowledged: true, explicitAck: true },
      false,
      newBuildMemo(),
    );
    expect(spec).toEqual({ npm: '@scope/s@1.2.3' });
  });

  it('--no-build with no existing dist + REQUIRED → throws SkillBuildError', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();

    await expect(
      resolveCompanionSpec(
        'companion',
        { path: dirname(fx.poolSkillMd(DECLARED_POOL)) },
        fx.root,
        { noBuild: true, dryRun: false, acknowledged: false },
        false,
        newBuildMemo(),
      ),
    ).rejects.toThrow(/no built dist/);
  });

  it('OPTIONAL companion: --no-build with no existing dist falls back to the raw spec (no throw)', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const sourceDir = dirname(fx.poolSkillMd(DECLARED_POOL));

    const spec = await resolveCompanionSpec(
      COMPANION_ALIAS,
      { path: sourceDir },
      fx.root,
      { noBuild: true, dryRun: false, acknowledged: false },
      true,
      newBuildMemo(),
    );

    expect(spec).toEqual({ path: sourceDir });
  });
});

// The byte-identical stale-dist fact (a preview staged an EXISTING built dist
// WITHOUT rebuilding) warned for the SUBJECT (buildDryRunSummary) but silently
// dropped for a COMPANION — resolveCompanionSpec discarded dryRunStagedExistingDist
// entirely. It must warn, naming the companion so two stale warnings in one run are
// distinguishable, reusing buildStaleDistWarningLines (the subject's own
// warning-construction code) rather than a copied string.
//
// `--dry-run` BUILDS now, so the stale path is reached only by pairing it with
// `--no-build` — which is the point: the warning fires exactly when the user asked
// not to rebuild, and never when VAT rebuilt for them.
describe('resolveCompanionSpec (dry-run stale-dist warning propagates to a companion)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('--no-build --dry-run + an EXISTING companion dist → warns on stderr, naming the companion and its declared skill', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    mkdirSyncReal(fx.poolDistDir(DECLARED_POOL), { recursive: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    const spec = await resolveCompanionSpec(
      COMPANION_ALIAS,
      { path: dirname(fx.poolSkillMd(DECLARED_POOL)) },
      fx.root,
      { noBuild: true, dryRun: true, acknowledged: true, explicitAck: true },
      false,
      newBuildMemo(),
    );

    expect(spec).toEqual({ path: fx.poolDistDir(DECLARED_POOL) });
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    const expectedLines = harness.buildStaleDistWarningLines(
      `companion '${COMPANION_ALIAS}' (declared skill '${DECLARED_POOL}')`,
    );
    for (const line of expectedLines) expect(written).toContain(line);
  });

  it('--no-build --dry-run + NO existing companion dist (fell back to source) → no stale warning', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    await resolveCompanionSpec(
      COMPANION_ALIAS,
      { path: dirname(fx.poolSkillMd(DECLARED_POOL)) },
      fx.root,
      { noBuild: true, dryRun: true, acknowledged: true, explicitAck: true },
      false,
      newBuildMemo(),
    );

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).not.toContain('STALE');
  });

  it('a real (non-dry-run) build never warns, even though a dist dir already existed', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    mkdirSyncReal(fx.poolDistDir(DECLARED_POOL), { recursive: true });
    spyPackageSkillCreatingDist();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    await resolveCompanionSpec(
      COMPANION_ALIAS,
      { path: dirname(fx.poolSkillMd(DECLARED_POOL)) },
      fx.root,
      { noBuild: false, dryRun: false, acknowledged: true, explicitAck: true },
      false,
      newBuildMemo(),
    );

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).not.toContain('STALE');
  });
});

// The OPTIONAL branch is a NARROW degradation, not a catch-all. Only a genuine
// SkillBuildError from a NON-destructive `pool` build may fall back to raw-source
// staging; every other failure (missing security ack, broken config, build-hook
// failure) is a user-fixable preflight problem whose actionable message must not be
// replaced by a misleading "failed to build" note — and a `plugin-local` build has
// already `rm -rf`d the marketplace tree by the time it fails, so continuing would
// stage from an inconsistent dist and report SUCCESS with the user's output deleted.
describe('resolveCompanionSpec (the OPTIONAL catch is narrow, and failures name the alias)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('OPTIONAL + POOL build failure: falls back to the raw spec AND writes the degraded-companion note', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    spyPackageSkillFailing();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const sourceDir = dirname(fx.poolSkillMd(DECLARED_POOL));

    const spec = await resolveCompanionSpec(
      COMPANION_ALIAS,
      { path: sourceDir },
      fx.root,
      ACKED_BUILD_FLAGS,
      true,
      newBuildMemo(),
    );

    expect(spec).toEqual({ path: sourceDir });
    // The note is MANDATORY, not decorative: a silently-degraded companion means the
    // run tests an UNBUILT skill (no `files:` injection — the #158 symptom) while
    // reporting success. Asserted here so deleting the warning fails a unit test.
    const note = stderr.mock.calls.map((c) => String(c[0])).find((m) => m.includes('failed to build'));
    expect(note).toContain(`companion '${COMPANION_ALIAS}'`);
    expect(note).toContain(DECLARED_POOL);
    expect(note).toContain(BUILD_FAILURE_MESSAGE);
  });

  it('OPTIONAL + missing security ack: PROPAGATES SecurityAckError (never degraded to a build note)', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const pkg = spyPackageSkillCreatingDist();
    const { SecurityAckError } = await import('@vibe-agent-toolkit/agent-skills');

    await expect(
      resolveCompanionSpec(
        COMPANION_ALIAS,
        { path: dirname(fx.poolSkillMd(DECLARED_POOL)) },
        fx.root,
        { noBuild: false, dryRun: false, acknowledged: false },
        true,
        newBuildMemo(),
      ),
    ).rejects.toBeInstanceOf(SecurityAckError);
    expect(pkg).not.toHaveBeenCalled();
  });

  it('OPTIONAL + DESTRUCTIVE plugin-local build failure: PROPAGATES (the marketplace tree is already wiped)', async () => {
    const fx = setupReferenceFixture({ pluginLocal: [PLUGIN_LOCAL_SKILL] });
    resetSkillDiscoveryCache();
    vi.spyOn(pluginBuild, 'runClaudePluginBuild').mockImplementation((() => {
      throw new Error(BUILD_FAILURE_MESSAGE);
    }) as never);
    const { SkillBuildError } = await import('@vibe-agent-toolkit/agent-skills');

    const error = await companionBuildError(dirname(fx.pluginSkillMd(PLUGIN_LOCAL_SKILL)), fx.root, true);

    expect(error).toBeInstanceOf(SkillBuildError);
    expect(errorMessage(error)).toContain(BUILD_FAILURE_MESSAGE);
  });

  it('REQUIRED + build failure: the error names the --with ALIAS as well as the declared skill', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    spyPackageSkillFailing();
    const { SkillBuildError } = await import('@vibe-agent-toolkit/agent-skills');

    const error = await companionBuildError(dirname(fx.poolSkillMd(DECLARED_POOL)), fx.root, false);

    // Same class (so mapErrorToExitCode still yields 2) — only the message is prefixed.
    expect(error).toBeInstanceOf(SkillBuildError);
    expect(errorMessage(error)).toContain(`companion '${COMPANION_ALIAS}'`);
    expect(errorMessage(error)).toContain(DECLARED_POOL);
  });

  it('OPTIONAL + plugin-local companion under --no-build with no dist: DEGRADES (nothing was ever attempted, so nothing could have been wiped)', async () => {
    const fx = setupReferenceFixture({ pluginLocal: [PLUGIN_LOCAL_SKILL] });
    resetSkillDiscoveryCache();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const sourceDir = dirname(fx.pluginSkillMd(PLUGIN_LOCAL_SKILL));

    const spec = await resolveCompanionSpec(
      COMPANION_ALIAS,
      { path: sourceDir },
      fx.root,
      { noBuild: true, dryRun: false, acknowledged: false },
      true,
      newBuildMemo(),
    );

    // --no-build never reaches runClaudePluginBuild, so the marketplace tree was
    // never touched — a plugin-local companion degrades here exactly like a pool
    // one does, instead of hard-failing the run over a build that never happened.
    expect(spec).toEqual({ path: sourceDir });
    const note = stderr.mock.calls.map((c) => String(c[0])).find((m) => m.includes('failed to build'));
    expect(note).toContain(`companion '${COMPANION_ALIAS}'`);
    expect(note).toContain(PLUGIN_LOCAL_SKILL);
  });
});

describe('resolveCompanionSources', () => {
  afterEach(() => vi.restoreAllMocks());

  it('undefined sources → undefined (no-op)', async () => {
    const out = await resolveCompanionSources(undefined, process.cwd(), {
      noBuild: false,
      dryRun: false,
      acknowledged: true,
      explicitAck: true,
    }, false, newBuildMemo());
    expect(out).toBeUndefined();
  });

  it('resolves each entry independently: a declared-skill path builds, an unrelated one passes through', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    spyPackageSkillCreatingDist();

    const out = await resolveCompanionSources(
      {
        builds: { path: dirname(fx.poolSkillMd(DECLARED_POOL)) },
        passthrough: { npm: '@scope/other@2.0.0' },
      },
      fx.root,
      { noBuild: false, dryRun: false, acknowledged: true, explicitAck: true },
      false,
      newBuildMemo(),
    );

    expect(out).toEqual({
      builds: { path: fx.poolDistDir(DECLARED_POOL) },
      passthrough: { npm: '@scope/other@2.0.0' },
    });
  });
});

// End-to-end: runSkillTestRun actually rewrites --with's path spec to the built
// dist before calling runSkillTestHarness (not just the unit-level helpers above).
describe('runSkillTestRun (--with companion build resolution end-to-end — issue #158)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a --with path pointing at a declared skill\'s source dir is staged from its BUILT dist', async () => {
    const { fx, pkg } = setupDeclaredPoolFixtureWithPkgSpy();

    const sourceDir = dirname(fx.poolSkillMd(DECLARED_POOL));
    const opts = await runAndCaptureOpts(PATH_SUBJECT, {
      with: [`companion=path:${sourceDir}`],
      iUnderstandThisRunsSkillCode: true,
    });

    // Once for the companion (the subject here is a plain source, never built).
    expect(pkg).toHaveBeenCalledTimes(1);
    const withSources = opts.withSources as Record<string, { path?: string }>;
    expect(withSources['companion']).toEqual({ path: fx.poolDistDir(DECLARED_POOL) });
  });
});

// The per-run build memo: one declared skill never builds twice in a run, and a
// plugin-local build (which rebuilds its WHOLE marketplace) runs once per
// marketplace, not once per skill. Plus the post-build verification that the dist
// actually materialized — a "successful" build that writes nothing must be an error,
// not a path handed onward to staging.
describe('buildDeclaredSkill memoization + dist verification', () => {
  afterEach(() => vi.restoreAllMocks());

  it('subject AND a companion pointing at the SAME declared skill build exactly ONCE', async () => {
    const { fx, pkg } = setupDeclaredPoolFixtureWithPkgSpy();

    const opts = await runAndCaptureOpts(DECLARED_POOL, {
      with: [`companion=path:${dirname(fx.poolSkillMd(DECLARED_POOL))}`],
      iUnderstandThisRunsSkillCode: true,
    });

    expect(pkg).toHaveBeenCalledTimes(1);
    // Both arms still resolve to the built dist — memoized, not skipped.
    expect(opts.subjectSource).toEqual({ path: fx.poolDistDir(DECLARED_POOL) });
    const withSources = opts.withSources as Record<string, { path?: string }>;
    expect(withSources['companion']).toEqual({ path: fx.poolDistDir(DECLARED_POOL) });
  });

  it('two DIFFERENT pool companions each build (the memo must not over-collapse)', async () => {
    const other = 'declared-pool-b';
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL, other] });
    resetSkillDiscoveryCache();
    const pkg = spyPackageSkillCreatingDist();

    const out = await resolveCompanionSources(
      {
        first: { path: dirname(fx.poolSkillMd(DECLARED_POOL)) },
        second: { path: dirname(fx.poolSkillMd(other)) },
      },
      fx.root,
      { noBuild: false, dryRun: false, acknowledged: true, explicitAck: true },
      false,
      newBuildMemo(),
    );

    expect(pkg).toHaveBeenCalledTimes(2);
    expect(out).toEqual({
      first: { path: fx.poolDistDir(DECLARED_POOL) },
      second: { path: fx.poolDistDir(other) },
    });
  });

  it('two plugin-local companions in the SAME marketplace trigger ONE marketplace build', async () => {
    const [first, second] = ['plug-a', 'plug-b'];
    const fx = setupReferenceFixture({ pluginLocal: [first, second] });
    resetSkillDiscoveryCache();
    const build = spyPluginBuildCreatingDists([fx.pluginDistDir(first), fx.pluginDistDir(second)]);

    const out = await resolveCompanionSources(
      {
        a: { path: dirname(fx.pluginSkillMd(first)) },
        b: { path: dirname(fx.pluginSkillMd(second)) },
      },
      fx.root,
      { noBuild: false, dryRun: false, acknowledged: true, explicitAck: true },
      false,
      newBuildMemo(),
    );

    expect(build).toHaveBeenCalledTimes(1);
    // The memo HIT must still yield THIS skill's dist, never the sibling's.
    expect(out).toEqual({
      a: { path: fx.pluginDistDir(first) },
      b: { path: fx.pluginDistDir(second) },
    });
  });

  it('a build that reports success but writes nothing → SkillBuildError naming the skill and the missing dist', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    // A build that resolves without creating its outputPath — the silent-no-op case.
    vi.spyOn(harness, 'packageSkill').mockResolvedValue(undefined as never);
    const { SkillBuildError } = await import('@vibe-agent-toolkit/agent-skills');

    const error = await companionBuildError(dirname(fx.poolSkillMd(DECLARED_POOL)), fx.root, false);

    expect(error).toBeInstanceOf(SkillBuildError);
    const message = errorMessage(error);
    expect(message).toContain(DECLARED_POOL);
    expect(message).toContain(fx.poolDistDir(DECLARED_POOL));
    expect(message).toContain('reported success but produced no output');
    // The verification error is raised OUTSIDE the build try/catch, so it is never
    // re-wrapped into a doubled "Skill build failed for 'x': Skill build for 'x'…".
    expect(message).not.toContain('Skill build failed for');
  });

  it('a build that creates the dist dir but no SKILL.md → SkillBuildError distinguishing an empty shell', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    // A build that creates the output directory (unlike the fully-silent no-op
    // above) but never writes SKILL.md into it — an empty/incomplete shell, the
    // #158 symptom class this check exists to catch.
    vi.spyOn(harness, 'packageSkill').mockImplementation((async (
      _skillPath: string,
      options: { outputPath: string },
    ) => {
      mkdirSyncReal(options.outputPath, { recursive: true });
    }) as never);
    const { SkillBuildError } = await import('@vibe-agent-toolkit/agent-skills');

    const error = await companionBuildError(dirname(fx.poolSkillMd(DECLARED_POOL)), fx.root, false);

    expect(error).toBeInstanceOf(SkillBuildError);
    const message = errorMessage(error);
    expect(message).toContain(DECLARED_POOL);
    expect(message).toContain('no SKILL.md');
    // Distinct from the "no output at all" message above — this is the
    // dir-exists-but-empty-shell case, not the fully-silent-no-op case.
    expect(message).not.toContain('reported success but produced no output at');
  });
});

// The per-run build memo is a Set of OPERATION keys, consulted only AFTER the
// security-ack gate (buildDeclaredSkill checks `flags.acknowledged` BEFORE
// `memo.has(key)`). A reviewer once moved the memo lookup ABOVE the ack check and
// every other test still passed — this pins the ordering directly: pre-seeding the
// memo with the key this companion would use must NOT let an unacknowledged call
// slip through as a "cached" build.
describe('buildDeclaredSkill security-ack ordering (memo lookup must never precede the ack check)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a memo HIT does not bypass the security-ack check', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const pkg = spyPackageSkillCreatingDist();
    const { SecurityAckError } = await import('@vibe-agent-toolkit/agent-skills');

    const sourceDir = dirname(fx.poolSkillMd(DECLARED_POOL));
    const declared = await findDeclaredSkillForSourceDir(sourceDir, fx.root);
    if (declared === undefined) throw new Error('fixture setup: expected a declared skill for the source dir');
    // Pre-seed the memo with the EXACT key this companion's build operation uses.
    const memo: BuildMemo = new Set([buildMemoKey(declared)]);

    await expect(
      resolveCompanionSpec(
        'companion',
        { path: sourceDir },
        fx.root,
        { noBuild: false, dryRun: false, acknowledged: false },
        false,
        memo,
      ),
    ).rejects.toBeInstanceOf(SecurityAckError);
    expect(pkg).not.toHaveBeenCalled();
  });
});

// The `test.build` PRE-STAGE HOOK is per-SKILL, not per-run: it belongs to the skill
// that DECLARED it and must run with THAT skill's config root as cwd. Before this fix
// the subject's command rode along in the shared build flags and was re-executed for
// every declared-skill companion — with the COMPANION's config root as cwd (wrong
// command AND wrong cwd in a monorepo), N+1 times, breaking runPreStageBuild's
// documented "runs that shell command ONCE before staging" contract.
const SUBJECT_HOOK = 'echo subject-hook';
const COMPANION_HOOK = 'echo companion-hook';
const SIBLING_SKILL = 'companion-skill';
const NESTED_DIR = 'packages/nested';
const NESTED_SKILL = 'nested-companion';

/** Spy `runPreStageBuild` (no-op) and expose the (command, cwd) pairs it was invoked with. */
function spyPreStageBuild() {
  const spy = vi.spyOn(harness, 'runPreStageBuild').mockImplementation((() => undefined) as never);
  return () =>
    spy.mock.calls.map((call) => {
      const opts = call[0] as { buildCommand: string | undefined; configRoot: string };
      return { buildCommand: opts.buildCommand, configRoot: toForwardSlash(opts.configRoot) };
    });
}

/** Fixture + the spies every hook-scoping case needs (cwd pinned at the fixture root). */
function setupHookFixture(spec: ReferenceFixtureSpec) {
  const fx = setupReferenceFixture(spec);
  resetSkillDiscoveryCache();
  vi.spyOn(process, 'cwd').mockReturnValue(fx.root);
  return { fx, pkg: spyPackageSkillCreatingDist(), pairs: spyPreStageBuild() };
}

/** The `--with` flag value staging `dir` as a required companion named "companion". */
function withCompanionAt(dir: string): string[] {
  return [`companion=path:${dir}`];
}

/** The nested sub-project of a fixture, asserted present (its absence is a fixture bug). */
function nestedOf(fx: ReferenceFixture): NestedProjectFixture {
  const nested = fx.nested;
  if (nested === undefined) throw new Error('fixture setup: expected a nested project');
  return nested;
}

describe('test.build hook scoping (per-declaring-skill command + cwd, memoized once)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('subject declares the hook, companion (same config root) declares none → ONE call, the SUBJECT pair', async () => {
    const { fx, pairs } = setupHookFixture({
      pool: [DECLARED_POOL, SIBLING_SKILL],
      poolTest: { [DECLARED_POOL]: { build: SUBJECT_HOOK } },
    });

    await runAndCaptureOpts(DECLARED_POOL, {
      with: withCompanionAt(dirname(fx.poolSkillMd(SIBLING_SKILL))),
      iUnderstandThisRunsSkillCode: true,
    });

    expect(pairs()).toEqual([{ buildCommand: SUBJECT_HOOK, configRoot: fx.root }]);
  });

  it('a companion in a NESTED config runs ITS OWN hook, with the NESTED config root as cwd', async () => {
    const { fx, pairs } = setupHookFixture({
      pool: [DECLARED_POOL],
      nested: { dir: NESTED_DIR, pool: [NESTED_SKILL], poolTest: { [NESTED_SKILL]: { build: COMPANION_HOOK } } },
    });
    const nested = nestedOf(fx);

    // PATH_SUBJECT maps to no declared skill, so the companion's is the ONLY hook in play.
    await runAndCaptureOpts(PATH_SUBJECT, {
      with: withCompanionAt(nested.skillDir(NESTED_SKILL)),
      iUnderstandThisRunsSkillCode: true,
    });

    expect(pairs()).toEqual([{ buildCommand: COMPANION_HOOK, configRoot: nested.root }]);
  });

  it('regression: the SUBJECT\'s command is never invoked with a COMPANION\'s config root', async () => {
    const { fx, pairs } = setupHookFixture({
      pool: [DECLARED_POOL],
      poolTest: { [DECLARED_POOL]: { build: SUBJECT_HOOK } },
      nested: { dir: NESTED_DIR, pool: [NESTED_SKILL], poolTest: { [NESTED_SKILL]: { build: COMPANION_HOOK } } },
    });
    const nested = nestedOf(fx);

    await runAndCaptureOpts(DECLARED_POOL, {
      with: withCompanionAt(nested.skillDir(NESTED_SKILL)),
      iUnderstandThisRunsSkillCode: true,
    });

    // Each hook ran exactly once, each against the root of the config that declares it.
    expect(pairs()).toEqual([
      { buildCommand: SUBJECT_HOOK, configRoot: fx.root },
      { buildCommand: COMPANION_HOOK, configRoot: nested.root },
    ]);
    expect(pairs()).not.toContainEqual({ buildCommand: SUBJECT_HOOK, configRoot: nested.root });
  });

  it('subject + companion declaring the SAME command in the SAME config root → the hook runs ONCE', async () => {
    const { fx, pkg, pairs } = setupHookFixture({
      pool: [DECLARED_POOL, SIBLING_SKILL],
      poolTest: { [DECLARED_POOL]: { build: SUBJECT_HOOK }, [SIBLING_SKILL]: { build: SUBJECT_HOOK } },
    });

    await runAndCaptureOpts(DECLARED_POOL, {
      with: withCompanionAt(dirname(fx.poolSkillMd(SIBLING_SKILL))),
      iUnderstandThisRunsSkillCode: true,
    });

    expect(pairs()).toEqual([{ buildCommand: SUBJECT_HOOK, configRoot: fx.root }]);
    // ...while BOTH skills still built: the memo collapses the shared HOOK only,
    // never the two distinct build operations.
    expect(pkg).toHaveBeenCalledTimes(2);
  });
});

// loadTestConfig's basename fallback (run.ts) is a LAST RESORT: a source-dir-path
// subject must resolve its `test:` config through the EXACT declared-skill link
// (findDeclaredSkillForSourceDir → declaredSkillTestConfig), not through a directory
// BASENAME that happens to coincide with the skill's declared name. This fixture
// deliberately gives the skill a declared NAME different from its directory's
// basename, so a basename-keyed lookup misses it entirely.
const MISMATCH_DIR_NAME = 'weird-directory-name';
const MISMATCH_SKILL_NAME = 'actual-declared-skill-name';

/** A pool project whose one skill's directory basename != its declared frontmatter name. */
function setupNameBasenameMismatchFixture(buildHook: string): { root: string; skillDir: string } {
  const root = safePath.resolve(createTestTempDir('vat-skill-name-mismatch-'));
  const skillDir = safePath.join(root, 'skills', MISMATCH_DIR_NAME);
  mkdirSyncReal(skillDir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path from createTestTempDir
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: ${MISMATCH_SKILL_NAME}\ndescription: Synthetic skill whose declared name differs from its directory basename.\n---\n\n# ${MISMATCH_SKILL_NAME}\n\nBody.\n`,
  );
  const config = {
    version: 1,
    skills: {
      include: ['skills/*/SKILL.md'],
      config: { [MISMATCH_SKILL_NAME]: { test: { build: buildHook } } },
    },
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path from createTestTempDir
  writeFileSync(safePath.join(root, CONFIG_FILENAME), yaml.stringify(config));
  return { root, skillDir };
}

describe('loadTestConfig (source-dir subject resolves test: config by the EXACT declared-skill link, not by basename)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a source-dir path subject whose declared NAME differs from its directory basename still picks up its test.build hook', async () => {
    const { root, skillDir } = setupNameBasenameMismatchFixture(SUBJECT_HOOK);
    resetSkillDiscoveryCache();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    spyPackageSkillCreatingDist();
    const pairs = spyPreStageBuild();

    await runAndCaptureOpts(skillDir, { iUnderstandThisRunsSkillCode: true });

    expect(pairs()).toEqual([{ buildCommand: SUBJECT_HOOK, configRoot: root }]);
  });
});

// Exit-code symmetry between the two phases of runSkillTestRun. A ConfigLoadError is
// a user-fixable PREFLIGHT problem (exit 2), but mapErrorToExitCode has no case for it
// and falls through to Internal (1) — the SUBJECT arm special-cased it, the COMPANION
// arm did not. That gap is reachable precisely because a companion's governing config
// root can differ from the subject's: here the subject resolves against the (valid)
// outer config while the companion's NESTED config is broken.
describe('runSkillTestRun (a broken COMPANION config exits 2, not 1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a ConfigLoadError raised during companion resolution to the preflight code', async () => {
    const fx = setupReferenceFixture({
      pool: [DECLARED_POOL],
      nested: { dir: NESTED_DIR, pool: [NESTED_SKILL] },
    });
    resetSkillDiscoveryCache();
    const nested = nestedOf(fx);
    // Break ONLY the nested config (unparseable YAML: an unterminated flow sequence).
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path from createTestTempDir
    writeFileSync(safePath.join(nested.root, CONFIG_FILENAME), 'version: 1\nskills: [unclosed\n');
    vi.spyOn(process, 'cwd').mockReturnValue(fx.root);
    const harnessSpy = vi.spyOn(harness, 'runSkillTestHarness');
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    // PATH_SUBJECT maps to no declared skill, so the ONLY config load that can fail
    // is the companion's — the error therefore surfaces in the SECOND try block.
    await runSkillTestRun(PATH_SUBJECT, {
      with: withCompanionAt(nested.skillDir(NESTED_SKILL)),
      iUnderstandThisRunsSkillCode: true,
    });

    expect(exit).toHaveBeenCalledWith(2);
    expect(harnessSpy).not.toHaveBeenCalled();
  });
});

// --grader-model / --concurrency (issue #145): GLOBAL knobs resolved from the
// TOP-LEVEL `test:` config node (SkillTestGlobalConfigSchema), never the
// per-skill `skills.config.<skill>.test` block. Precedence: flag > top-level
// config > built-in default (left undefined so the harness applies
// DEFAULT_GRADER_MODEL / DEFAULT_CONCURRENCY). VAT_TEST_CONFIG overrides the
// config file `loadConfig` reads, independent of the resolved project root.
describe('vat skill test run (--grader-model / --concurrency — global test: config, issue #145)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['VAT_TEST_CONFIG'];
  });

  it('a --grader-model flag wins over top-level config', async () => {
    stubGlobalTestConfig({ graderModel: CONFIG_GRADER_MODEL });
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      graderModel: FLAG_GRADER_MODEL,
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.graderModel).toBe(FLAG_GRADER_MODEL);
  });

  it('reads graderModel from the top-level test: config when no flag is set', async () => {
    stubGlobalTestConfig({ graderModel: CONFIG_GRADER_MODEL });
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.graderModel).toBe(CONFIG_GRADER_MODEL);
  });

  it('a --concurrency flag wins over top-level config', async () => {
    stubGlobalTestConfig({ concurrency: 2 });
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      concurrency: '9',
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.concurrency).toBe(9);
  });

  it('reads concurrency from the top-level test: config when no flag is set', async () => {
    stubGlobalTestConfig({ concurrency: 7 });
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.concurrency).toBe(7);
  });

  it('leaves graderModel and concurrency undefined when neither flag nor top-level config sets them', async () => {
    const opts = await runAndCaptureOpts(ENV_TEST_SKILL, {
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.graderModel).toBeUndefined();
    expect(opts.concurrency).toBeUndefined();
  });
});

// The command takes a SINGLE subject skill (companions are staged separately via
// --with/--with-optional) — asserted directly against the Commander option/argument
// metadata so a regression to the old multi-subject phrasing fails a fast unit test.
describe('createSkillTestRunCommand (single-subject argument + companion help text)', () => {
  it('declares a single (non-variadic) <skill> argument', () => {
    const command = createSkillTestRunCommand();
    expect(command.registeredArguments).toHaveLength(1);
    expect(command.registeredArguments[0]?.variadic).toBe(false);
    expect(command.registeredArguments[0]?.name()).toBe('skill');
  });

  it('describes --with as staging a REQUIRED companion (fails if unresolved)', () => {
    const command = createSkillTestRunCommand();
    const withOption = command.options.find((o) => o.long === '--with');
    expect(withOption?.description).toContain('REQUIRED companion skill');
    expect(withOption?.description).toContain('fails if a source cannot be resolved');
  });

  it('describes --with-optional as staging an OPTIONAL companion (raw source with a warning)', () => {
    const command = createSkillTestRunCommand();
    const withOptionalOption = command.options.find((o) => o.long === '--with-optional');
    expect(withOptionalOption?.description).toContain('OPTIONAL companion skill');
    expect(withOptionalOption?.description).toContain('Staged from its raw (unbuilt) source with a warning');
  });
});

describe('companion-name deduplication (fail-closed, not last-wins)', () => {
  it('parseWithFlags throws DuplicateStagedSkillError on a repeated --with name', () => {
    expect(() => parseWithFlags(['dup=path:one', 'dup=path:two'])).toThrow(harness.DuplicateStagedSkillError);
  });

  it('parseWithFlags accepts distinct --with names', () => {
    const record = parseWithFlags(['a=path:one', 'b=path:two']);
    expect(Object.keys(record ?? {})).toEqual(['a', 'b']);
  });

  it('descriptorsToRecord throws when two config descriptors derive the same name', () => {
    // Both `path:` basenames derive the name "router" — a silent overwrite before
    // buildStageItems ever saw it (the #153 no-op class, one layer up).
    expect(() => descriptorsToRecord([{ path: 'helpers/foo/router' }, { path: 'helpers/bar/router' }])).toThrow(
      harness.DuplicateStagedSkillError,
    );
  });

  it('descriptorsToRecord accepts descriptors with distinct derived names', () => {
    const record = descriptorsToRecord([{ workspace: 'alpha' }, { workspace: 'beta' }]);
    expect(Object.keys(record ?? {})).toEqual(['alpha', 'beta']);
  });
});
