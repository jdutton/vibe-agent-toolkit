/**
 * `vat skills build` and what a packager THROW is: the skill's finding, or a defect.
 *
 * One contract across the five packaging lanes, through one predicate
 * (`isSkillPackagingInputError`): the packager's CODED refusal of the skill's
 * own content is a `SKILL_PACKAGING_FAILED` finding; any other throw is not the
 * adopter's to fix and leaves the run as the thrown value itself, which the
 * phase runner publishes by its own code (`INTERNAL_ERROR` when it has none).
 *
 * The packager is stubbed because a defect cannot be staged from a fixture —
 * that is what makes it a defect. The real packager refusing real content is
 * `build-run-ledger.test.ts` and `test/system/skills-build.system.test.ts`.
 * Everything else is real: the phase runner loads a real config and discovers
 * real skills in a temp project.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath, VatError } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSkillBuild, runSkillsBuildPhase, type BuildSkillSpec, type SkillBuildRun } from '../../../src/commands/skills/build.js';
import type { DiscoveredSkill } from '../../../src/commands/skills/command-helpers.js';
import { publishedPhase } from '../../helpers/published-phase.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { silentLogger } from '../../test-doubles.js';

const harness = vi.hoisted(() => ({
  /** What each skill's packaging threw, in spec order. */
  thrown: [] as Error[],
  /** When set, the whole packaging call rejects with it (a refusal inside the build bracket). */
  rejectWith: undefined as Error | undefined,
}));

vi.mock('@vibe-agent-toolkit/agent-skills', async (importOriginal) =>
  (await import('../../helpers/stubbed-packager.js')).withPackagerFailing(importOriginal, harness, (i) =>
    harness.thrown[i] ?? new Error(`no throw staged for spec ${i}`)));
const PREVIOUS_BUNDLE = 'dist/skills/previous/SKILL.md';
const PREVIOUS_CONTENT = 'the previous build\n';
const REFUSAL_MESSAGE = 'files: source does not exist';

/** One valid skill per staged throw under `cwd`, over a previous `dist/skills`. */
async function seedProject(cwd: string, thrown: Error[]): Promise<DiscoveredSkill[]> {
  harness.thrown = thrown;
  const skills: DiscoveredSkill[] = [];
  for (const i of thrown.keys()) {
    const name = `skill-${i}`;
    const dir = safePath.join(cwd, 'skills', name);
    await mkdir(dir, { recursive: true });
    const sourcePath = safePath.join(dir, 'SKILL.md');
    await writeFile(sourcePath, `---\nname: ${name}\ndescription: A skill whose packaging is made to throw in a test.\n---\n\n# ${name}\n\nNothing to see.\n`);
    skills.push({ name, sourcePath });
  }
  await mkdir(safePath.join(cwd, 'dist/skills/previous'), { recursive: true });
  await writeFile(safePath.join(cwd, PREVIOUS_BUNDLE), PREVIOUS_CONTENT);
  return skills;
}

async function buildWithPackagerThrowing(cwd: string, thrown: Error[]): Promise<SkillBuildRun> {
  const specs = (await seedProject(cwd, thrown)).map((skill): BuildSkillSpec => ({ skill, packagingConfig: {} as BuildSkillSpec['packagingConfig'] }));
  return runSkillBuild({ specs, cwd, logger: silentLogger, projectSkills: [], onlySkill: undefined, verbose: false, runOutputs: [] });
}

/** What `vat skills build` would publish for the project, and the exit code that document derives. */
async function publishedBuild(cwd: string, thrown: Error[]): Promise<ReturnType<typeof publishedPhase>> {
  await seedProject(cwd, thrown);
  await writeFile(safePath.join(cwd, 'vibe-agent-toolkit.config.yaml'), 'skills:\n  include: ["skills/**/SKILL.md"]\n');
  return publishedPhase('skills build', await runSkillsBuildPhase(cwd, {}, []));
}

function codedRefusal(code = 'SKILL_PACKAGING_INPUT_INVALID'): VatError {
  return new VatError(code, REFUSAL_MESSAGE);
}

const DEFECT = new TypeError("Cannot read properties of undefined (reading 'length')");

describe('runSkillBuild - a packager throw is the skill\'s finding only when the packager coded it', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-packager-defect-');

  afterEach(() => cleanupTempDirs());

  it.each(['SKILL_PACKAGING_INPUT_INVALID', 'SKILL_NAME_NOT_A_SEGMENT'])('collects a %s refusal as that skill\'s failure', async (code) => {
    const run = await buildWithPackagerThrowing(createTempDir(), [codedRefusal(code)]);

    expect(run.failures).toStrictEqual([{ name: 'skill-0', message: REFUSAL_MESSAGE, error: expect.objectContaining({ code }) as unknown }]);
    expect(run.outputCommitted).toBe(false);
  });

  it('lets an uncoded throw leave the run as the thrown value, never as a finding', async () => {
    await expect(buildWithPackagerThrowing(createTempDir(), [DEFECT])).rejects.toBe(DEFECT);
  });

  it('stops on a defect even when another skill was refused for its content', async () => {
    await expect(buildWithPackagerThrowing(createTempDir(), [codedRefusal(), DEFECT])).rejects.toBe(DEFECT);
  });

  it('restores the previous dist/skills before a defect leaves the run, with no staging residue', async () => {
    const cwd = createTempDir();

    await expect(buildWithPackagerThrowing(cwd, [DEFECT])).rejects.toBe(DEFECT);

    expect(existsSync(safePath.join(cwd, PREVIOUS_BUNDLE))).toBe(true);
    expect(readFileSync(safePath.join(cwd, PREVIOUS_BUNDLE), 'utf8')).toBe(PREVIOUS_CONTENT);
    expect(readdirSync(safePath.join(cwd, 'dist'))).toStrictEqual(['skills']);
  });

  // A refusal thrown INSIDE the build bracket (a git snapshot naming an unreadable
  // file) used to skip settling, leaving a `dist/.vat-skills-*` staging dir behind
  // that every later build kept beside dist/skills.
  it('settles staging when the build bracket itself throws: no residue, the previous dist/skills restored', async () => {
    const cwd = createTempDir();
    const refusal = new VatError('GIT_SNAPSHOT_UNREADABLE', 'private.txt is unreadable');
    harness.rejectWith = refusal;
    try {
      await expect(buildWithPackagerThrowing(cwd, [codedRefusal()])).rejects.toBe(refusal);
    } finally {
      harness.rejectWith = undefined;
    }

    expect(readFileSync(safePath.join(cwd, PREVIOUS_BUNDLE), 'utf8')).toBe(PREVIOUS_CONTENT);
    expect(readdirSync(safePath.join(cwd, 'dist'))).toStrictEqual(['skills']);
  });
});

describe('vat skills build - the document a packager throw publishes', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-packager-document-');

  afterEach(() => cleanupTempDirs());

  it('publishes a coded refusal as a SKILL_PACKAGING_FAILED finding at the skill, exit 1', async () => {
    const { exitCode, document } = await publishedBuild(createTempDir(), [codedRefusal()]);

    expect(exitCode).toBe(ExitCode.FINDINGS);
    expect(document).toMatchObject({ status: 'findings', data: { skillsFailed: 1 } });
    expect(document.findings.map(({ code, severity, location }) => ({ code, severity, location }))).toStrictEqual([
      { code: 'SKILL_PACKAGING_FAILED', severity: 'error', location: 'skills/skill-0/SKILL.md' },
    ]);
  });

  it('publishes an uncoded throw as INTERNAL_ERROR, exit 2, with no finding blaming the skill', async () => {
    const { exitCode, document } = await publishedBuild(createTempDir(), [codedRefusal(), DEFECT]);

    expect(exitCode).toBe(ExitCode.ERROR);
    expect(document).toMatchObject({ status: 'error', error: { code: 'INTERNAL_ERROR', message: DEFECT.message }, findings: [] });
  });

  it('publishes a throw carrying a mapped library code under that code, not as a defect', async () => {
    const refused = new VatError('COPY_LINK_ESCAPES_SOURCE', 'a link in the tree points outside it');

    const { exitCode, document } = await publishedBuild(createTempDir(), [refused]);

    expect(exitCode).toBe(ExitCode.ERROR);
    expect(document).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' }, findings: [] });
  });
});
