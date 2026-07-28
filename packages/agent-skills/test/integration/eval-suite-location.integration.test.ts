/**
 * WHERE the eval suite and its fixtures live, and what the executor can reach
 * from there.
 *
 * One file because it is one question. Both halves below broke the same way:
 * a path was COMPUTED correctly and then resolved against a tree that did not
 * contain what the computation assumed — the recurring defect in this area, and
 * the reason every assertion here checks the real filesystem rather than a
 * string. A computed string is exactly what passed through both regressions.
 *
 * Half 1 — `${fixturesDir}` must name a directory that EXISTS at executor-spawn
 * time. The token is a documented, shipped feature: a skill declares
 * `env: { SNAP: "${fixturesDir}/snap.json" }` so the executor can read a fixture
 * by absolute path. It used to resolve to `<stagedSkillDir>/<evalsDir>/fixtures`
 * — but eval-suite isolation DELETES `<staged>/evals/` (the answer key, and
 * `fixtures/` beneath it) from every staged subject, so the token named a path
 * that provably did not exist. `interpolateEnvValue` is a bare substitution with
 * no existence check, so the executor got a dead path and the failure read as a
 * SKILL bug rather than a harness one.
 *
 * Half 2 — a suite may live entirely OUTSIDE the skill's tree. This is the
 * missing half of a feature that already shipped: `npm:`/`url:`/`vendored`
 * subjects have always been stageable, but suite lookup only ever searched
 * inside the subject's own tree — and a correctly packaged skill provably
 * carries no suite, because the suite is the answer key and excluding it from
 * the bundle is what this branch enforces. The only external skill you could
 * eval was one whose publisher shipped their answer key.
 *
 * Neither half may point the executor back at the suite directory: that hands it
 * a sibling path to `evals.json` and reopens the leak.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- every path derives from
   this test's own temp dir. */
import { existsSync, statSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestTempDir, createTestTempDir } from '../../../cli/test/system/test-common.js';
import { runSkillTestHarness, type RunHarnessOptions } from '../../src/skill-test/run-harness.js';
import {
  harnessOptsFor,
  writeEvalSuite,
  writeSubjectSkill,
  writeSuiteFixture,
} from '../skill-test/eval-fixture.js';
import { makeHarnessFakeSpawn } from '../skill-test/spawn-stub.js';

// Preflight shells out to a real `claude` and probes its flags, so without this
// the whole file would be gated on the developer's PATH rather than the code.
vi.mock('../../src/skill-test/preflight.js', async (io) => (await import('../skill-test/preflight-stub.js')).passingPreflight(io));

const SKILL_NAME = 'suite-location-skill';
const INTERNAL_EVAL_ID = 'reads-a-fixture';
const EXTERNAL_EVAL_ID = 'reads-external-fixture';
const WORKSPACES = 'workspaces';
const EVALS_JSON = 'evals.json';

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir('vat-eval-suite-location-');
});

afterEach(() => {
  cleanupTestTempDir(tempDir);
});

/** The subject skill's own tree. Written the same way in both layouts. */
function subjectSkillDir(): string {
  return writeSubjectSkill(
    safePath.join(tempDir, 'subject', SKILL_NAME),
    SKILL_NAME,
    'Fixture skill for the eval-suite location tests.',
  );
}

/** One eval declaring a single input fixture, which is what makes a workspace exist. */
function evalWithFixture(id: string, rel: string): Record<string, unknown> {
  return {
    id,
    prompt: 'operate on the fixture',
    expected_output: 'FIXTURE-ANSWER-KEY',
    expectations: ['it works'],
    files: [`fixtures/${rel}`],
  };
}

/** Suite in the CONVENTIONAL place: `<skill>/evals/evals.json`. */
function writeInternalLayout(): string {
  const subjectDir = subjectSkillDir();
  const evalsDir = safePath.join(subjectDir, 'evals');
  writeSuiteFixture(evalsDir, 'snap.json', '{"customer":"acme"}\n');
  writeEvalSuite(safePath.join(evalsDir, EVALS_JSON), SKILL_NAME, [
    evalWithFixture(INTERNAL_EVAL_ID, 'snap.json'),
  ]);
  return subjectDir;
}

interface ExternalLayout {
  /** Packaged-shaped: SKILL.md only, no suite anywhere in the tree. */
  subjectDir: string;
  /** The out-of-tree suite — a sibling of the skill rather than a child. */
  evalsPath: string;
}

/** Suite in an unrelated directory. Nothing links the two but the path passed in. */
function writeExternalLayout(): ExternalLayout {
  const subjectDir = subjectSkillDir();
  const suiteDir = safePath.join(tempDir, 'audit-corpus');
  writeSuiteFixture(suiteDir, 'case.md', '# external fixture\n');
  const evalsPath = writeEvalSuite(safePath.join(suiteDir, EVALS_JSON), SKILL_NAME, [
    evalWithFixture(EXTERNAL_EVAL_ID, 'case.md'),
  ]);
  return { subjectDir, evalsPath };
}

function optsFor(
  subjectDir: string,
  spawn: RunHarnessOptions['spawn'],
  extra: Partial<RunHarnessOptions>,
): RunHarnessOptions {
  return harnessOptsFor({
    name: SKILL_NAME,
    tempDir,
    subjectDir,
    ...(spawn === undefined ? {} : { spawn }),
    extra,
  });
}

describe('${fixturesDir} wiring (integration)', () => {
  it('hands the executor a fixture path that exists on disk', async () => {
    const subjectDir = writeInternalLayout();
    let injected: string | undefined;

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        injected = opts.env?.CUSTOMER_SNAPSHOT_PATH;
      },
    });

    const result = await runSkillTestHarness(
      optsFor(subjectDir, fake.spawn, {
        env: { CUSTOMER_SNAPSHOT_PATH: '${fixturesDir}/snap.json' },
      }),
    );

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
    expect(injectedPath).toContain(WORKSPACES);
    expect(injectedPath).not.toContain(safePath.join('evals', 'fixtures'));
  });
});

describe('external eval suite (integration)', () => {
  it('grades a skill against an absolute out-of-tree suite and stages its fixtures', async () => {
    const layout = writeExternalLayout();
    let spawns = 0;

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: () => {
        spawns += 1;
      },
    });

    const result = await runSkillTestHarness(
      optsFor(layout.subjectDir, fake.spawn, { evalsSubpath: layout.evalsPath }),
    );

    // Exit 3 is bootstrap — "no suite found, here is a template". Before the fix
    // that is exactly what an absolute path produced: it was folded under the
    // skill dir, did not exist, and a starter template was written there.
    expect(result.exitCode, `harness exit ${result.exitCode}: ${result.summary ?? '(no summary)'}`).toBe(0);

    // The suite really drove a run; a pass with zero spawns would mean the
    // harness found nothing to grade and said so quietly.
    expect(spawns).toBe(1);

    // Fixtures resolve relative to the EXTERNAL suite dir, not the skill dir,
    // and land in the eval's own workspace.
    expect(
      existsSync(safePath.join(tempDir, 'harness', WORKSPACES, EXTERNAL_EVAL_ID, 'fixtures', 'case.md')),
    ).toBe(true);

    // And the external suite was never copied into the subject tree.
    expect(existsSync(safePath.join(layout.subjectDir, EVALS_JSON))).toBe(false);
    expect(existsSync(safePath.join(layout.subjectDir, 'evals'))).toBe(false);
  });

  // Windows does not model POSIX permission bits, so this is Unix-only — the
  // same guard the sibling harness-root mode tests use.
  it.skipIf(process.platform === 'win32')(
    'creates the dirs holding external input and quoted output 0700, not at the umask',
    async () => {
      // An out-of-tree suite can carry data that was never in the repo, so the
      // two dirs that end up holding it must not inherit the umask (0755). They
      // were protected only by the 0700 harness ROOT — which `--out` relocates
      // and `--keep` preserves, so the parent is not something to rely on.
      //
      // Necessary, not sufficient: `grading.json` quotes the executor transcript
      // verbatim, so whatever the skill READ out of a fixture is written into
      // results/ as text. Tightening the mode narrows who can read that file; it
      // does not stop the content from being written. See the `--evals` docs.
      const layout = writeExternalLayout();
      const fake = makeHarnessFakeSpawn({});

      await runSkillTestHarness(
        optsFor(layout.subjectDir, fake.spawn, { evalsSubpath: layout.evalsPath }),
      );

      const harnessRoot = safePath.join(tempDir, 'harness');
      for (const name of [WORKSPACES, 'results']) {
        const dir = safePath.join(harnessRoot, name);
        expect(existsSync(dir), `${name}/ was never created`).toBe(true);
        expect(statSync(dir).mode & 0o777, `${name}/ is not 0700`).toBe(0o700);
      }
    },
  );
});
