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

async function withStubbedPackager(
  importOriginal: () => Promise<typeof agentSkills>,
  stub: PackageSkillsStub,
): Promise<typeof agentSkills> {
  return { ...(await importOriginal()), packageSkills: stub as typeof agentSkills.packageSkills };
}

/** What a {@link withPackagerFailing} stub reads on every call, so a test can change it between calls. */
interface PackagerFailureHarness {
  /** When set, the whole packaging call rejects with it: a refusal thrown inside the build bracket. */
  rejectWith: Error | undefined;
}

/**
 * `withStubbedPackager` with a stub under which every spec's packaging throws
 * `errorFor(index)` — or, while `harness.rejectWith` is set, the whole call
 * rejects with it.
 */
export function withPackagerFailing(
  importOriginal: () => Promise<typeof agentSkills>,
  harness: PackagerFailureHarness,
  errorFor: (index: number) => Error,
): Promise<typeof agentSkills> {
  return withStubbedPackager(importOriginal, (specs) =>
    harness.rejectWith === undefined
      ? Promise.resolve(specs.map(({ skillPath }, i) => ({ status: 'failed' as const, skillPath, error: errorFor(i) })))
      : Promise.reject(harness.rejectWith));
}
