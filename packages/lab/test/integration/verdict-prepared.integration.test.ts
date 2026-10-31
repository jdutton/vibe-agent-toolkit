/**
 * `verdict run --prepared`: a subject runs in the prepared clone instead of its
 * subjects-file path, and its body records which — `verdict union` judges bar 3
 * only over captures that ran in the clone the arms ran in.
 *
 * Integration-tier because capture spawns the probe.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { captureVerdict, type VerdictCaptureResult } from '../../src/facets/verdict/capture.js';
import { PROBE_NO_LOG_ENV, setupProbe } from '../command-probe.js';

import { cleanupVerdictFixtures, FIXTURE_ALIAS, fixtureSubject, tempDir } from './verdict-fixtures.js';

afterAll(cleanupVerdictFixtures);

/**
 * Capture the fixture alias, listed at `listed`, with these prepared clones.
 *
 * @param listed - The subjects-file path
 * @param prepared - Alias → prepared clone
 * @returns The capture
 */
function capture(listed: string, prepared: Readonly<Record<string, string>>): Promise<VerdictCaptureResult> {
  return captureVerdict({
    instrument: setupProbe('lab-verdict-prepared-').instrument,
    subjects: [{ alias: FIXTURE_ALIAS, path: listed, verbs: ['audit'], sqlFiles: [], buildVerbs: false, unmeasurableBuildVerbs: {} }],
    subjectsDir: listed,
    env: { set: { [PROBE_NO_LOG_ENV]: '1' }, unset: [] },
    prepared,
    outDir: tempDir('lab-verdict-prepared-out-'),
    armsRoot: tempDir('lab-verdict-prepared-arms-'),
    capturedAt: new Date().toISOString(),
  });
}

describe('verdict capture --prepared', () => {
  it('runs a prepared subject in its clone and records it; an unprepared one records null', async () => {
    const clone = fixtureSubject();

    const prepared = await capture(fixtureSubject(), { [FIXTURE_ALIAS]: clone });
    const unprepared = await capture(fixtureSubject(), {});

    if (!prepared.ok || !unprepared.ok) throw new Error('unexpected refusal');
    expect(prepared.envelopes[0]?.body.preparedClone).toBe(safePath.resolve(clone));
    expect(prepared.envelopes[0]?.coordinate.subject.source).toBe(clone);
    expect(unprepared.envelopes[0]?.body.preparedClone).toBeNull();
  });

  it('refuses a prepared alias the subjects file does not list, before anything runs', async () => {
    expect(await capture(fixtureSubject(), { nonesuch: fixtureSubject() })).toEqual({
      ok: false,
      refusal: expect.stringContaining("'nonesuch'") as unknown,
    });
  });
});
