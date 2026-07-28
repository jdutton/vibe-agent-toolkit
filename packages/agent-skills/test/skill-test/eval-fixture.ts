/**
 * Shared fixture builders for tests that drive the FULL `runSkillTestHarness`.
 *
 * Every such test needs the same three things — a minimal subject skill on disk,
 * an eval suite somewhere, and a `RunHarnessOptions` with the security ack and
 * integrity escape hatch already set — and the interesting part of each test is
 * only ever *where* those live relative to each other (suite inside the subject,
 * in a separate authored dir, or out of the tree entirely).
 *
 * Keeping the boilerplate here lets each test file say just that, and keeps the
 * shared setup from being re-typed per file — which the duplication gate rightly
 * flags, and which is a genuine maintenance cost besides: the harness options
 * shape has changed several times, and every copy has to change with it.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- callers pass their own temp dirs */
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

import type { RunHarnessOptions } from '../../src/skill-test/run-harness.js';

/** A minimal valid SKILL.md. `description` varies so fixtures stay self-describing. */
export function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

/** Write `<dir>/SKILL.md` for `name`, creating `dir`. Returns `dir`. */
export function writeSubjectSkill(dir: string, name: string, description: string): string {
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(safePath.join(dir, 'SKILL.md'), skillMd(name, description), 'utf8');
  return dir;
}

/** Write an `evals.json` holding `evals` at `suitePath`, creating its directory. */
export function writeEvalSuite(suitePath: string, skillName: string, evals: unknown[]): string {
  mkdirSyncReal(safePath.join(suitePath, '..'), { recursive: true });
  writeFileSync(suitePath, JSON.stringify({ skill_name: skillName, evals }) + '\n', 'utf8');
  return suitePath;
}

/** Write one fixture file under `<suiteDir>/fixtures/`, creating the directory. */
export function writeSuiteFixture(suiteDir: string, relName: string, body: string): string {
  const fixturesDir = safePath.join(suiteDir, 'fixtures');
  mkdirSyncReal(fixturesDir, { recursive: true });
  const path = safePath.join(fixturesDir, relName);
  writeFileSync(path, body, 'utf8');
  return path;
}

export interface HarnessFixtureOptions {
  /** Skill name AND positional subject — the harness resolves the two together. */
  name: string;
  /** Temp root: anchors `repoRoot` and the harness `out` dir. */
  tempDir: string;
  /** The dir staged as the subject. */
  subjectDir: string;
  /** Authored dir the suite is looked up from. Defaults to `subjectDir`. */
  scaffoldDir?: string;
  spawn?: RunHarnessOptions['spawn'];
  /** Extra options merged last — `evalsSubpath`, `env`, `keep`, and friends. */
  extra?: Partial<RunHarnessOptions>;
}

/**
 * Harness options for a fixture run: real staging, caller-supplied spawn.
 *
 * `acknowledgedRunsSkillCode` and `allowUnverifiedSkillSource` are always set —
 * a test that had to re-assert the §12 ack would be testing the gate, not the
 * behavior under test, and the gate has its own tests.
 */
export function harnessOptsFor(input: HarnessFixtureOptions): RunHarnessOptions {
  return {
    subject: input.name,
    repoRoot: input.tempDir,
    out: safePath.join(input.tempDir, 'harness'),
    subjectSource: { path: input.subjectDir },
    subjectScaffoldDir: input.scaffoldDir ?? input.subjectDir,
    acknowledgedRunsSkillCode: true,
    allowUnverifiedSkillSource: true,
    ...(input.spawn === undefined ? {} : { spawn: input.spawn }),
    ...input.extra,
  };
}
