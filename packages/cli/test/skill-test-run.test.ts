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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveSubjectForTest, runSkillTestRun } from '../src/commands/skill/test/run.js';
import { resetSkillDiscoveryCache } from '../src/skill-resolution/index.js';

import { setupReferenceFixture } from './skill-resolution/helpers.js';

/** Path-form subject so resolution returns `source` without a declared skill. */
const PATH_SUBJECT = './my-skill';

/** Name of the config-declared (buildable) pool skill used across resolution tests. */
const DECLARED_POOL = 'declared-pool';

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
});

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

  it('threads --fail-on-eval-failure through to the harness opts', async () => {
    const opts = await runAndCaptureOpts([ENV_TEST_SKILL], {
      failOnEvalFailure: true,
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.failOnEvalFailure).toBe(true);
  });

  it('leaves failOnEvalFailure undefined by default (opt-in)', async () => {
    const opts = await runAndCaptureOpts([ENV_TEST_SKILL], {
      iUnderstandThisRunsSkillCode: true,
    });
    expect(opts.failOnEvalFailure).toBeUndefined();
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
