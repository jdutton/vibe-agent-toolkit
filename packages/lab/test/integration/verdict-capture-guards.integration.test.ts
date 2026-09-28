/**
 * The verdict capture's safety rails, read back through a probe that prints the
 * environment it actually received.
 *
 * Each arm runs under the caller's `--env`/`--unset` plus two lab-owned
 * settings — a private projection store under `--out`, and no inherited
 * `CLAUDE_CONFIG_DIR` — and a capture must never write into a measured tree or
 * reuse a store an earlier capture warmed. A refusal that silently stopped
 * firing would still leave every compare green, so each rail is pinned here.
 *
 * Integration-tier because capture spawns the probe.
 */

import { basename } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { captureVerdict, type VerdictCaptureResult } from '../../src/facets/verdict/capture.js';
import type { ArmEnvironment } from '../../src/harness/arm-env.js';
import { PROBE_ECHO_ENV, PROBE_NO_LOG_ENV, setupProbe } from '../command-probe.js';

import { cleanupVerdictFixtures, FIXTURE_ALIAS, fixtureSubject, tempDir } from './verdict-fixtures.js';

const STORE_ENV = 'VAT_PROJECTION_STORE_DIR';
const CLAUDE_ENV = 'CLAUDE_CONFIG_DIR';
const CALLER_ENV = 'LAB_VERDICT_CALLER';

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(cleanupVerdictFixtures);

/**
 * Capture the fixture subject under a probe that echoes the three variables.
 *
 * @param env - The caller's arm environment, over the probe's own switches
 * @param subjectPath - The subject root
 * @param outDir - Where the capture writes
 * @returns The capture
 */
function capture(env: ArmEnvironment, subjectPath: string, outDir: string): Promise<VerdictCaptureResult> {
  return captureVerdict({
    instrument: setupProbe('lab-verdict-guard-').instrument,
    subjects: [{ alias: FIXTURE_ALIAS, path: subjectPath, verbs: ['audit'], sqlFiles: [], buildVerbs: false }],
    subjectsDir: subjectPath,
    env: {
      set: { [PROBE_NO_LOG_ENV]: '1', [PROBE_ECHO_ENV]: [STORE_ENV, CLAUDE_ENV, CALLER_ENV].join(','), ...env.set },
      unset: env.unset,
    },
    outDir,
    capturedAt: new Date().toISOString(),
  });
}

/**
 * @param result - A capture that must not have been refused
 * @returns What the probe said it received, from the one row
 */
function echoed(result: VerdictCaptureResult): Record<string, string | null> {
  if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
  return JSON.parse(result.envelopes[0]?.body.rows[0]?.document ?? '') as Record<string, string | null>;
}

describe('verdict capture — the per-arm overlay', () => {
  it('gives the child the private store, no CLAUDE_CONFIG_DIR, and the caller’s own --env', async () => {
    // The parent really does carry CLAUDE_CONFIG_DIR, so "the child saw none"
    // is the overlay's doing and not an empty inheritance.
    vi.stubEnv(CLAUDE_ENV, tempDir('lab-verdict-claude-'));
    expect(process.env[CLAUDE_ENV]).toBeDefined();
    const outDir = tempDir('lab-verdict-out-');

    const seen = echoed(await capture({ set: { [CALLER_ENV]: 'kept' }, unset: [] }, fixtureSubject(), outDir));

    // The tail, not the whole path: the normalizer may rewrite an absolute
    // prefix (a temp dir under $HOME on Windows reads as <HOME>/…).
    expect(seen[STORE_ENV]?.endsWith(`${basename(outDir)}/${FIXTURE_ALIAS}/store`)).toBe(true);
    expect(seen[CLAUDE_ENV]).toBeNull();
    expect(seen[CALLER_ENV]).toBe('kept');
  });
});

describe('verdict capture — refusals', () => {
  it('refuses an --out inside a subject', async () => {
    const subjectPath = fixtureSubject();

    const result = await capture({ set: {}, unset: [] }, subjectPath, safePath.join(subjectPath, 'lab-out'));

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('lies inside subject') });
  });

  it('refuses a caller that names VAT_PROJECTION_STORE_DIR', async () => {
    const result = await capture(
      { set: { [STORE_ENV]: tempDir('lab-verdict-store-') }, unset: [] },
      fixtureSubject(),
      tempDir('lab-verdict-out-'),
    );

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining(`${STORE_ENV} is set by the verdict facet`) });
  });

  it('refuses a caller that names CLAUDE_CONFIG_DIR', async () => {
    const result = await capture({ set: {}, unset: [CLAUDE_ENV] }, fixtureSubject(), tempDir('lab-verdict-out-'));

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining(`${CLAUDE_ENV} is set by the verdict facet`) });
  });

  it('refuses an --out whose private store an earlier capture already made', async () => {
    const outDir = tempDir('lab-verdict-out-');
    mkdirSyncReal(safePath.join(outDir, FIXTURE_ALIAS, 'store'), { recursive: true });

    const result = await capture({ set: {}, unset: [] }, fixtureSubject(), outDir);

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('Capture into a fresh --out') });
  });
});
