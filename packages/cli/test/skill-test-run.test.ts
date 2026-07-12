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

import * as harness from '@vibe-agent-toolkit/agent-skills';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isPathSourceTarget,
  resolveCappedKnob,
  resolveSubjectForTest,
  runSkillTestRun,
} from '../src/commands/skill/test/run.js';
import { resetSkillDiscoveryCache } from '../src/skill-resolution/index.js';

import { setupReferenceFixture } from './skill-resolution/helpers.js';

/** Path-form subject so resolution returns `source` without a declared skill. */
const PATH_SUBJECT = './my-skill';

/** Name of the config-declared (buildable) pool skill used across resolution tests. */
const DECLARED_POOL = 'declared-pool';

/** Pinned model string used across the #7 path-honors-config tests. */
const SONNET_MODEL = 'claude-sonnet-5';

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

  await runSkillTestRun([PATH_SUBJECT], {});

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
    await runSkillTestRun([PATH_SUBJECT], {});
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 3 on guided bootstrap', async () => {
    const { BootstrapNeededError } = await import('@vibe-agent-toolkit/agent-skills');
    vi.spyOn(harness, 'runSkillTestHarness').mockRejectedValue(
      new BootstrapNeededError('/h/evals/evals.json'),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun([PATH_SUBJECT], {});
    expect(exit).toHaveBeenCalledWith(3);
  });

  it('exits 2 on preflight-class error (HarnessLocationError)', async () => {
    const { HarnessLocationError } = await import('@vibe-agent-toolkit/agent-skills');
    vi.spyOn(harness, 'runSkillTestHarness').mockRejectedValue(
      new HarnessLocationError('harness root is unsafe'),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun([PATH_SUBJECT], {});
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('exits 1 on internal harness error (InternalHarnessError)', async () => {
    const { InternalHarnessError } = await import('@vibe-agent-toolkit/agent-skills');
    vi.spyOn(harness, 'runSkillTestHarness').mockRejectedValue(
      new InternalHarnessError('grading.json missing'),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun([PATH_SUBJECT], {});
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('surfaces the harness EvalFailure exit code (4) unchanged — not remapped or swallowed', async () => {
    vi.spyOn(harness, 'runSkillTestHarness').mockResolvedValue({
      harnessPath: '/h',
      exitCode: 4,
      summary: 'FAIL 1/2',
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runSkillTestRun([PATH_SUBJECT], {});
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
  await expect(runSkillTestRun([PATH_SUBJECT], options)).rejects.toThrow('exit:2');
  expect(harnessSpy).not.toHaveBeenCalled();
}

// Mocks runSkillTestHarness, runs runSkillTestRun, and returns the RunHarnessOptions
// the mock received so tests can assert env/passEnv plumbing.
async function runAndCaptureOpts(
  skills: string[],
  options: Parameters<typeof runSkillTestRun>[1],
): Promise<Record<string, unknown>> {
  const spy = vi
    .spyOn(harness, 'runSkillTestHarness')
    .mockResolvedValue({ harnessPath: '/h', exitCode: 0, summary: 'PASS 1/1' });
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  await runSkillTestRun(skills, options);
  return spy.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
}

const ENV_TEST_SKILL = './acme-skill';

describe('vat skill test run (env plumbing)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses --env KEY=VALUE into an env record (literal ${...} preserved)', async () => {
    const opts = await runAndCaptureOpts([ENV_TEST_SKILL], {
      env: ['CUSTOMER_SNAPSHOT_PATH=${fixturesDir}/snap.json'],
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.env).toEqual({ CUSTOMER_SNAPSHOT_PATH: '${fixturesDir}/snap.json' });
  });

  it('splits an --env value on the first = only', async () => {
    const opts = await runAndCaptureOpts([ENV_TEST_SKILL], {
      env: ['FOO=a=b'],
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.env).toEqual({ FOO: 'a=b' });
  });

  it('unions and de-duplicates --pass-env names', async () => {
    const opts = await runAndCaptureOpts([ENV_TEST_SKILL], {
      passEnv: ['VENDOR_LICENSE_KEY', 'VENDOR_LICENSE_KEY', 'OTHER'],
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.passEnv).toEqual(['VENDOR_LICENSE_KEY', 'OTHER']);
  });

  it('leaves env and passEnv undefined when no env flags are given', async () => {
    const opts = await runAndCaptureOpts([ENV_TEST_SKILL], {
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.env).toBeUndefined();
    expect(opts.passEnv).toBeUndefined();
  });

  it('threads --allow-eval-failure through to the harness opts as tolerateEvalFailure', async () => {
    const opts = await runAndCaptureOpts([ENV_TEST_SKILL], {
      allowEvalFailure: true,
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.tolerateEvalFailure).toBe(true);
  });

  it('leaves tolerateEvalFailure undefined by default (fail-closed on eval failure)', async () => {
    const opts = await runAndCaptureOpts([ENV_TEST_SKILL], {
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.tolerateEvalFailure).toBeUndefined();
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
    const opts = await runAndCaptureOpts([fx.poolDistDir(CONFIGURED)], { iUnderstandThisRunsSkillCode: true });
    expect(opts.model).toBe(SONNET_MODEL);
    expect(opts.evalsSubpath).toBe('evals/suite.json');
    expect(opts.timeout).toBe(240);
    expect(toForwardSlash(String(opts.subjectScaffoldDir))).toBe(safePath.join(fx.root, 'skills', CONFIGURED));
  });

  it('a path at a declared PLUGIN-LOCAL skill\'s dist also honors its test config', async () => {
    const PL = 'pl-configured';
    const fx = setupReferenceFixture({ pluginLocal: [PL], poolTest: { [PL]: { model: SONNET_MODEL } } });
    resetSkillDiscoveryCache();
    const opts = await runAndCaptureOpts([fx.pluginDistDir(PL)], { iUnderstandThisRunsSkillCode: true });
    expect(opts.model).toBe(SONNET_MODEL);
    expect(opts.subjectScaffoldDir).toBeDefined(); // anchored at the plugin skill's source
  });

  it('a config-blind path (matches no declared skill) applies NO test config', async () => {
    const fx = setupReferenceFixture({ pool: [CONFIGURED], poolTest: { [CONFIGURED]: { model: SONNET_MODEL } } });
    resetSkillDiscoveryCache();
    // Absolute path under the same config but NOT any declared skill's dist → config-blind.
    const ghost = safePath.join(fx.root, 'dist', 'skills', 'ghost-not-declared');
    const opts = await runAndCaptureOpts([ghost], { iUnderstandThisRunsSkillCode: true });
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
      resolveSubjectForTest('undeclared', fx.root, { noBuild: false, dryRun: false, acknowledged: false }),
    ).rejects.toThrow(/no skill named 'undeclared'/);
  });

  it('--no-build with no built dist → an exit-2 build error', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    await expect(
      resolveSubjectForTest(DECLARED_POOL, fx.root, { noBuild: true, dryRun: false, acknowledged: false }),
    ).rejects.toThrow(/no built dist/);
  });

  it('source-arm path → returns { subjectSource: { path } } without building', async () => {
    const out = await resolveSubjectForTest('./some/dist', process.cwd(), {
      noBuild: false,
      dryRun: false,
      acknowledged: false,
    });
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
    });
    expect(out.wouldBuild).toBe(false); // staged as-is, never rebuilt
    expect(out.linkedToDeclaredSkill).toBe(true);
    // Scaffold dir is the skill's source dir (dirname of SKILL.md), NOT the dist path,
    // so the authored eval suite resolves + overlays from there.
    expect(toForwardSlash(String(out.subjectScaffoldDir))).toBe(safePath.join(fx.root, 'skills', DECLARED_POOL));
  });
});

// Stage a declared-pool fixture, spy packageSkill, and resolve the buildable
// subject for the given gate inputs — shared by the ack-present / dry-run cases.
async function resolveBuildableWithPkgSpy(opts: { dryRun: boolean; acknowledged: boolean }) {
  const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
  resetSkillDiscoveryCache();
  const pkg = vi.spyOn(harness, 'packageSkill').mockResolvedValue(undefined as never);
  const out = await resolveSubjectForTest(DECLARED_POOL, fx.root, {
    noBuild: false,
    dryRun: opts.dryRun,
    acknowledged: opts.acknowledged,
  });
  return { out, pkg };
}

describe('resolveSubjectForTest (security ack gates the build — M2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('buildable subject + ack ABSENT + non-dry-run → SecurityAckError BEFORE any build/pre-stage command runs', async () => {
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    const preStage = vi.spyOn(harness, 'runPreStageBuild').mockImplementation((() => undefined) as never);
    const pkg = vi.spyOn(harness, 'packageSkill').mockResolvedValue(undefined as never);

    await expect(
      resolveSubjectForTest(DECLARED_POOL, fx.root, {
        noBuild: false,
        dryRun: false,
        acknowledged: false,
        // An ARBITRARY committed shell command — must NOT run without the ack.
        build: 'echo pwned > /tmp/pwned',
      }),
    ).rejects.toThrow(/Security acknowledgment required\. Pass --i-understand-this-runs-skill-code to proceed\./);

    expect(preStage).not.toHaveBeenCalled();
    expect(pkg).not.toHaveBeenCalled();
  });

  it('buildable subject + ack PRESENT → build proceeds (packageSkill invoked, rebuilt=true)', async () => {
    const { out, pkg } = await resolveBuildableWithPkgSpy({ dryRun: false, acknowledged: true });
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
    const fx = setupReferenceFixture({ pool: [DECLARED_POOL] });
    resetSkillDiscoveryCache();
    vi.spyOn(process, 'cwd').mockReturnValue(fx.root);
    const pkg = vi.spyOn(harness, 'packageSkill').mockResolvedValue(undefined as never);
    const harnessSpy = vi
      .spyOn(harness, 'runSkillTestHarness')
      .mockResolvedValue({ harnessPath: '/h', exitCode: 0, summary: '' });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    await runSkillTestRun([DECLARED_POOL], {});

    expect(exit).toHaveBeenCalledWith(2);
    expect(pkg).not.toHaveBeenCalled();
    expect(harnessSpy).not.toHaveBeenCalled();
  });
});
