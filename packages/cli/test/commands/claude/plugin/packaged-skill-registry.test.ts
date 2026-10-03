import type { PackageSkillResult } from '@vibe-agent-toolkit/agent-skills';
import { VatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

/**
 * The plugin build must package every plugin-local skill against ONE shared
 * `ResourceRegistry`.
 *
 * `packageSkill` falls back to `createProjectRegistry(projectRoot)` when the
 * caller passes no registry, and that crawls and parses EVERY markdown file in
 * the project. This lane used to call `packageSkill` in a loop with no registry,
 * so an N-skill plugin paid N full-project scans — a fixed per-skill cost that
 * does not vary with the skill's own size. Measured on a real monorepo (1039
 * markdown files, ~12s to scan): ~25s per skill, flat, whether the skill
 * packaged 1 file or 17, which put a 46-skill build past a 30-minute CI cap.
 *
 * `vat skills build` never had this: it goes through `packageSkills`, whose own
 * doc comment says "one registry for the entire project (crawling all .md files
 * once)". Two producers of a plugin's skills, two answers about how many times
 * the project gets read.
 */
const stubResult = { files: { dependencies: [] } } as unknown as PackageSkillResult;
const packageSkillSpy = vi.fn(async () => stubResult);

vi.mock('@vibe-agent-toolkit/agent-skills', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, packageSkill: packageSkillSpy };
});

const { packagePluginLocalSkills } = await import('../../../../src/commands/claude/plugin/build.js');
// Imported after the mock, like the build: a static import would load the mocked module first.
const { refusalCodeOf } = await import('../../../../src/utils/command-refusal.js');

/** A logger that swallows output — this test asserts on calls, not on prose. */
const silentLogger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
} as unknown as Parameters<typeof packagePluginLocalSkills>[0]['logger'];

/**
 * @param registry - The registry the run shares
 * @returns The run's input: two plugin-local skills, no skills config
 */
function twoSkills(registry: never): Parameters<typeof packagePluginLocalSkills>[0] {
  return {
      skills: [
        { skillDirPath: 'alpha', skillPath: '/project/plugins/p/skills/alpha/SKILL.md', skillName: 'alpha' },
        { skillDirPath: 'beta', skillPath: '/project/plugins/p/skills/beta/SKILL.md', skillName: 'beta' },
      ],
      pluginDir: '/project/dist/plugin',
      skillsConfig: undefined,
      registry,
      // No skills config above, so the project declares no eval suites at all.
      projectSkills: [],
      // The run's conventional-suite probe. Required rather than defaulted, so it
      // is stated here even though this test asserts nothing about it. A local stub
      // rather than the real `conventionalSuiteProbe`: this file mocks the whole
      // `@vibe-agent-toolkit/agent-skills` module, so importing a value from it
      // would resolve to the mock. Answering `false` is right for the fixture —
      // neither skill path exists on disk, so a real probe would say the same.
      suiteProbe: () => false,
      logger: silentLogger,
  };
}

describe('packagePluginLocalSkills — shared registry', () => {
  it('passes the SAME registry to every skill it packages', async () => {
    packageSkillSpy.mockClear();
    // A sentinel stands in for the real registry: this lane only forwards it, so
    // identity is the whole contract, and a sentinel makes a fallback visible
    // (an undefined registry is what the N+1 looked like).
    const registry = { sentinel: 'shared-registry' } as never;

    await packagePluginLocalSkills(twoSkills(registry));

    expect(packageSkillSpy).toHaveBeenCalledTimes(2);
    for (const call of packageSkillSpy.mock.calls) {
      expect((call as any)[1]?.registry).toBe(registry);
    }
  });
});

/** @returns What the run threw when the packager rejects with `thrown` on its first skill */
async function thrownFor(thrown: Error): Promise<unknown> {
  packageSkillSpy.mockClear();
  packageSkillSpy.mockRejectedValueOnce(thrown);
  return packagePluginLocalSkills(twoSkills({} as never)).then(() => undefined, (error: unknown) => error);
}

describe('packagePluginLocalSkills — a packager throw is coded by what it IS', () => {
  it('codes the packager refusing the skill\'s content as RUN_INCOMPLETE, at that skill (positive control)', async () => {
    const refused = new VatError('SKILL_PACKAGING_INPUT_INVALID', "files entry for skill 'alpha': source 'x' does not exist.");
    const error = await thrownFor(refused);

    expect(refusalCodeOf(error)).toBe('RUN_INCOMPLETE');
    expect(error).toMatchObject({ message: refused.message, skillPath: '/project/plugins/p/skills/alpha/SKILL.md', cause: refused });
  });

  // The other direction: a defect inside the packager is VAT's, and must not be
  // published as the skill's fault. Wrapping every throw would do exactly that.
  it('leaves an UNCODED packager throw untouched — it stays INTERNAL_ERROR', async () => {
    const defect = new Error('integrity post-condition failed');
    const error = await thrownFor(defect);

    expect(error).toBe(defect);
    expect(refusalCodeOf(error)).toBe('INTERNAL_ERROR');
  });
});
