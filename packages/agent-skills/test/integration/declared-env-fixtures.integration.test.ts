/**
 * `${fixturesDir}` must name a directory that EXISTS at executor-spawn time.
 *
 * The token is a documented, shipped feature: a skill declares
 * `env: { SNAP: "${fixturesDir}/snap.json" }` so the executor can read a fixture by
 * absolute path. It used to resolve to `<stagedSkillDir>/<evalsDir>/fixtures` —
 * but eval-suite isolation DELETES `<staged>/evals/` (the answer key, and
 * `fixtures/` beneath it) from every staged subject. The token therefore named a
 * path that provably did not exist, and `interpolateEnvValue` is a bare string
 * substitution with no existence check, so the executor received a dead path and
 * the resulting failure read as a SKILL bug rather than a harness one.
 *
 * The unit tests in `declared-env.test.ts` pin the token computation; this pins the
 * WIRING — that the harness actually threads each eval's own workspace in, which is
 * the half that was broken. It asserts against the real filesystem rather than a
 * computed string, because a computed string is exactly what passed before.
 *
 * Fixtures now stage into the eval's own workspace, which is also the executor's
 * working directory. Pointing the token back at the suite directory would hand the
 * executor a sibling path to `evals.json` and reopen the leak.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- every path derives from
   this test's own temp dir. */
import { existsSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestTempDir, createTestTempDir } from '../../../cli/test/system/test-common.js';
import { runSkillTestHarness, type RunHarnessOptions } from '../../src/skill-test/run-harness.js';
import { makeHarnessFakeSpawn } from '../skill-test/spawn-stub.js';

// This test asserts on staging and env assembly, which run well after preflight —
// so preflight's real `claude` probe would gate it on the developer's environment.
vi.mock('../../src/skill-test/preflight.js', async (io) => (await import('../skill-test/preflight-stub.js')).passingPreflight(io));

const SKILL_NAME = 'env-fixture-skill';
const SKILL_MD = `---\nname: ${SKILL_NAME}\ndescription: Fixture skill for the \${fixturesDir} wiring test.\n---\n\n# ${SKILL_NAME}\n`;

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir('vat-declared-env-fixtures-');
});

afterEach(() => {
  cleanupTestTempDir(tempDir);
});

/** Write a subject whose single eval declares an input fixture. */
function writeFixture(): string {
  const subjectDir = safePath.join(tempDir, 'subject', SKILL_NAME);
  mkdirSyncReal(subjectDir, { recursive: true });
  writeFileSync(safePath.join(subjectDir, 'SKILL.md'), SKILL_MD, 'utf8');

  const evalsDir = safePath.join(subjectDir, 'evals');
  mkdirSyncReal(safePath.join(evalsDir, 'fixtures'), { recursive: true });
  writeFileSync(safePath.join(evalsDir, 'fixtures', 'snap.json'), '{"customer":"acme"}\n', 'utf8');
  writeFileSync(
    safePath.join(evalsDir, 'evals.json'),
    JSON.stringify({
      skill_name: SKILL_NAME,
      evals: [
        {
          id: 'reads-a-fixture',
          prompt: 'read the snapshot',
          expected_output: 'ACME',
          expectations: ['it works'],
          files: ['fixtures/snap.json'],
        },
      ],
    }) + '\n',
    'utf8',
  );
  return subjectDir;
}

function optsFor(subjectDir: string, spawn: RunHarnessOptions['spawn']): RunHarnessOptions {
  return {
    subject: SKILL_NAME,
    repoRoot: tempDir,
    out: safePath.join(tempDir, 'harness'),
    subjectSource: { path: subjectDir },
    subjectScaffoldDir: subjectDir,
    acknowledgedRunsSkillCode: true,
    allowUnverifiedSkillSource: true,
    env: { CUSTOMER_SNAPSHOT_PATH: '${fixturesDir}/snap.json' },
    ...(spawn === undefined ? {} : { spawn }),
  };
}

describe('${fixturesDir} wiring (integration)', () => {
  it('hands the executor a fixture path that exists on disk', async () => {
    const subjectDir = writeFixture();
    let injected: string | undefined;

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        injected = opts.env?.CUSTOMER_SNAPSHOT_PATH;
      },
    });

    const result = await runSkillTestHarness(optsFor(subjectDir, fake.spawn));

    // Carry the harness's own summary into the failure message: exit 2 is preflight,
    // which has ~8 distinct causes, and a bare "expected 2 to be 0" names none of them.
    expect(result.exitCode, `harness exit ${result.exitCode}: ${result.summary ?? '(no summary)'}`).toBe(0);
    expect(injected, 'the declared env var never reached the executor').toBeDefined();

    // The assertion that matters: the interpolated path RESOLVES. Asserting the
    // expected string instead would have passed throughout the regression.
    const injectedPath = injected as string;
    expect(existsSync(injectedPath), `injected a path that does not exist: ${injectedPath}`).toBe(true);

    // And it points into the eval's OWN workspace — never back at the suite dir,
    // which holds the answer key.
    expect(injectedPath).toContain('workspaces');
    expect(injectedPath).not.toContain(safePath.join('evals', 'fixtures'));
  });
});
