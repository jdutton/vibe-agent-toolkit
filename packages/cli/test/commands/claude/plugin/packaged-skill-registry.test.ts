import type { PackageSkillResult } from '@vibe-agent-toolkit/agent-skills';
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

/** A logger that swallows output — this test asserts on calls, not on prose. */
const silentLogger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
} as unknown as Parameters<typeof packagePluginLocalSkills>[0]['logger'];

describe('packagePluginLocalSkills — shared registry', () => {
  it('passes the SAME registry to every skill it packages', async () => {
    packageSkillSpy.mockClear();
    // A sentinel stands in for the real registry: this lane only forwards it, so
    // identity is the whole contract, and a sentinel makes a fallback visible
    // (an undefined registry is what the N+1 looked like).
    const registry = { sentinel: 'shared-registry' } as never;

    await packagePluginLocalSkills({
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
    });

    expect(packageSkillSpy).toHaveBeenCalledTimes(2);
    for (const call of packageSkillSpy.mock.calls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading a spied call's options bag
      expect((call as any)[1]?.registry).toBe(registry);
    }
  });
});
