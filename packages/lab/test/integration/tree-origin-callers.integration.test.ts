/**
 * Each caller that copies a subject names the copy's tree origin, and the origin
 * decides whose git refreshes the copy's index (`arm-git.ts`). These cases drive
 * the real callers over subjects whose copy refreshes ONLY under the right git:
 *
 * - an operator checkout whose `.txt` filter is marked required in its own config
 *   but defined only in the developer's global one: the arm's git refuses to
 *   re-hash it;
 * - a lab-made tree under a developer's global required filter that always fails:
 *   the developer's git refuses to re-hash it.
 *
 * So a caller that names the wrong origin refuses the copy, and the capture with it.
 *
 * Integration-tier: real git, and the stand-in probe.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { captureVerdict } from '../../src/facets/verdict/capture.js';
import { runRepeats } from '../../src/harness/repeat.js';
import { committedSettledTree, filteredOperatorCheckout, preparedCloneDirectory, stubBrokenDeveloperFilter } from '../arm-tree-fixtures.js';
import { cleanupProbes, PROBE_NO_LOG_ENV, probeSpec, probeStep, setupProbe } from '../command-probe.js';

import { cleanupVerdictFixtures, FIXTURE_ALIAS, fixtureSubject, tempDir } from './verdict-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(cleanupProbes);
afterAll(cleanupVerdictFixtures);

/** @returns An operator checkout the arm's git cannot refresh */
function operatorSubject(): string {
  return filteredOperatorCheckout(tempDir('lab-origin-operator-'), tempDir('lab-origin-home-'), true);
}

/**
 * Capture one subject with its build verbs, which run in a clone of it.
 *
 * @param listed - The subjects-file path
 * @param prepared - Alias to prepared clone
 * @returns The build-verb rows' names
 * @throws {Error} on a refusal, naming it
 */
async function buildVerbRows(listed: string, prepared: Readonly<Record<string, string>>): Promise<string[]> {
  const result = await captureVerdict({
    instrument: setupProbe('lab-origin-verdict-').instrument,
    subjects: [{ alias: FIXTURE_ALIAS, path: listed, verbs: [], sqlFiles: [], buildVerbs: true, unmeasurableBuildVerbs: {} }],
    subjectsDir: listed,
    env: { set: { [PROBE_NO_LOG_ENV]: '1' }, unset: [] },
    prepared,
    outDir: tempDir('lab-origin-out-'),
    armsRoot: tempDir('lab-origin-arms-'),
    capturedAt: new Date().toISOString(),
  });
  if (!result.ok) throw new Error(result.refusal);
  return result.envelopes[0]?.body.rows.map((row) => row.name) ?? [];
}

// The build verbs run in an APFS clone (`cp -c`), so this path exists on macOS only.
describe.runIf(process.platform === 'darwin')("verdict capture refreshes the build-verb clone under its subject's origin", () => {
  it("refreshes an operator subject's clone under the developer's config", async () => {
    expect(await buildVerbRows(operatorSubject(), {})).toContain('build');
  });

  it("refreshes a --prepared subject's clone under the arm's git", async () => {
    const clone = committedSettledTree(tempDir('lab-origin-prepared-'));
    stubBrokenDeveloperFilter(tempDir('lab-origin-home-'));

    expect(await buildVerbRows(fixtureSubject(), { [FIXTURE_ALIAS]: clone })).toContain('build');
  });
});

/**
 * Run one cold repeat of a step that writes `dist/`, so the arm runs in a copy of `subject`.
 *
 * @param probe - The probe whose instrument and arms root the arm uses
 * @param subject - The subject
 * @returns The one result's violation
 */
async function writingArmViolation(probe: ReturnType<typeof setupProbe>, subject: string): Promise<string | null | undefined> {
  const spec = probeSpec(probe, {
    runs: 1,
    cache: 'cold',
    steps: [probeStep(['build'], { writes: ['dist'] })],
    env: { [PROBE_NO_LOG_ENV]: '1' },
  });
  const run = await runRepeats({ ...spec, cwd: subject });
  return run.results[0]?.violation;
}

// Windows skipped as the other writing-arm cases are (`subject-copy.integration.test.ts`).
describe.skipIf(process.platform === 'win32')("a writing arm refreshes its subject copy under the subject's origin", () => {
  it("refreshes an operator subject's copy under the developer's config", async () => {
    expect(await writingArmViolation(setupProbe('lab-origin-repeat-'), operatorSubject())).toBeNull();
  });

  it("refreshes the lab's prepared clone's copy under the arm's git", async () => {
    const probe = setupProbe('lab-origin-repeat-');
    const clone = committedSettledTree(preparedCloneDirectory(probe.armsRoot));
    stubBrokenDeveloperFilter(tempDir('lab-origin-home-'));

    expect(await writingArmViolation(probe, clone)).toBeNull();
  });
});
