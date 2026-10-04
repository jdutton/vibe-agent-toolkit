/**
 * A `vi.mock('@vibe-agent-toolkit/agent-skills', …)` factory body: the real
 * module with `packageSkills` replaced by `stub`. A packager DEFECT cannot be
 * staged from a fixture — that is what makes it a defect — so the suites that
 * test what a lane does with one stub the packager and keep everything else real.
 *
 * Called from inside the hoisted factory through `await import()`.
 */

import type * as agentSkills from '@vibe-agent-toolkit/agent-skills';

/** Stand-in for `packageSkills`: one outcome per spec. */
type PackageSkillsStub = (specs: agentSkills.SkillBuildSpec[]) => Promise<agentSkills.SkillPackageOutcome[]>;

export async function withStubbedPackager(
  importOriginal: () => Promise<typeof agentSkills>,
  stub: PackageSkillsStub,
): Promise<typeof agentSkills> {
  return { ...(await importOriginal()), packageSkills: stub as typeof agentSkills.packageSkills };
}
