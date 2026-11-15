/**
 * The verdict capture's safety rails, read back through a probe that prints the
 * environment it actually received.
 *
 * Each arm runs under the caller's `--env`/`--unset` over a cleared
 * environment (no inherited `VAT_*`), with lab-owned directories under
 * `<out>/<alias>/` — a private projection store, a `tmp/` pinned as
 * `TMPDIR`/`TEMP`/`TMP`, and an empty home pointed at by `HOME` and
 * `CLAUDE_CONFIG_DIR` — and a capture must never write into a measured tree or
 * reuse a store an earlier capture warmed. A refusal that silently stopped
 * firing would still leave every compare green, so each rail is pinned here.
 *
 * Integration-tier because capture spawns the probe.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { captureVerdict, type VerdictCaptureResult } from '../../src/facets/verdict/capture.js';
import type { VerdictSubject } from '../../src/facets/verdict/subjects.js';
import { VerdictBodySchema } from '../../src/facets/verdict/types.js';
import type { ArmEnvironment } from '../../src/harness/arm-env.js';
import { PROBE_ECHO_ENV, PROBE_NO_LOG_ENV, PROBE_STAT_ENV, setupProbe } from '../command-probe.js';

import { cleanupVerdictFixtures, FIXTURE_ALIAS, fixtureSubject, tempDir } from './verdict-fixtures.js';

const STORE_ENV = 'VAT_PROJECTION_STORE_DIR';
const CLAUDE_ENV = 'CLAUDE_CONFIG_DIR';
const CALLER_ENV = 'LAB_VERDICT_CALLER';
const PLANTED_ENV = 'VAT_LAB_VERDICT_PLANTED';
/** A real VAT_* name the caller sets explicitly: only the INHERITED VAT_* is cleared. */
const CALLER_VAT_ENV = 'VAT_RESOURCES_CRAWL';
const ECHOED = [STORE_ENV, CLAUDE_ENV, CALLER_ENV, CALLER_VAT_ENV, PLANTED_ENV, 'TMPDIR', 'TEMP', 'TMP', 'HOME'];

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(cleanupVerdictFixtures);

/**
 * Capture the fixture subject under a probe that echoes the three variables.
 *
 * @param env - The caller's arm environment, over the probe's own switches
 * @param subjectPath - The subject root
 * @param where - Where the capture writes its reports (`out`) and lays its arms out (`arms`)
 * @param build - The subject's build-verb settings; none unless given
 * @returns The capture
 */
function capture(
  env: ArmEnvironment,
  subjectPath: string,
  where: { readonly out: string; readonly arms: string },
  build: Pick<VerdictSubject, 'buildVerbs' | 'unmeasurableBuildVerbs'> = { buildVerbs: false, unmeasurableBuildVerbs: {} },
): Promise<VerdictCaptureResult> {
  return captureVerdict({
    instrument: setupProbe('lab-verdict-guard-').instrument,
    subjects: [{ alias: FIXTURE_ALIAS, path: subjectPath, verbs: ['audit'], sqlFiles: [], ...build }],
    subjectsDir: subjectPath,
    env: {
      set: { [PROBE_NO_LOG_ENV]: '1', [PROBE_ECHO_ENV]: ECHOED.join(','), ...env.set },
      unset: env.unset,
    },
    prepared: {},
    outDir: where.out,
    armsRoot: where.arms,
    capturedAt: new Date().toISOString(),
  });
}

/** @returns A fresh report directory and a fresh arms root, both outside every subject */
function scratch(): { readonly out: string; readonly arms: string } {
  return { out: tempDir('lab-verdict-out-'), arms: tempDir('lab-verdict-arms-') };
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
  it('gives the child its own store, tmp and home under <arms root>/<alias> — never --out — no inherited VAT_*, and the caller’s own --env', async () => {
    // The parent really does carry both, so "the child saw ours" is the
    // overlay's doing and not an empty inheritance.
    vi.stubEnv(CLAUDE_ENV, tempDir('lab-verdict-claude-'));
    vi.stubEnv(PLANTED_ENV, 'leak');
    const where = scratch();

    vi.stubEnv(CALLER_VAT_ENV, 'inherited');
    const result = await capture({ set: { [CALLER_ENV]: 'kept', [CALLER_VAT_ENV]: 'walk' }, unset: [] }, fixtureSubject(), where);
    const seen = echoed(result);

    // The tail, not the whole path: the normalizer may rewrite an absolute
    // prefix (a temp dir under $HOME on Windows reads as <HOME>/…).
    const under = `${basename(where.arms)}/${FIXTURE_ALIAS}`;
    expect(seen[STORE_ENV]?.endsWith(`${under}/store`)).toBe(true);
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) expect(seen[name]?.endsWith(`${under}/tmp`), name).toBe(true);
    // The child's home IS the arm home, so the normalizer must read it as <HOME> — never the operator's.
    for (const name of [CLAUDE_ENV, 'HOME']) expect(seen[name], name).toBe('<HOME>');
    expect(seen[PLANTED_ENV]).toBeNull();
    expect(seen[CALLER_ENV]).toBe('kept');
    expect(seen[CALLER_VAT_ENV]).toBe('walk');
    // …and the envelope says which inherited names the verbs went without.
    expect(result.ok && result.envelopes[0]?.removedEnv).toContain(PLANTED_ENV);
    // --out holds the reports and nothing else.
    expect(existsSync(safePath.join(where.out, FIXTURE_ALIAS))).toBe(false);
  });

  // POSIX modes only: Windows has no owner-only bits to read back.
  it.skipIf(process.platform === 'win32')('has <arms root>/<alias>/ and its tmp/ at 0700 when the verb STARTS, and leaves store/ to VAT', async () => {
    const where = scratch();

    // The verb itself stats its TMPDIR (<arms root>/<alias>/tmp) and that dir's
    // parent (<arms root>/<alias>) as it starts: a directory made after the verbs
    // reads `null` here even though a stat taken afterwards would pass.
    const seen = echoed(await capture({ set: { [PROBE_STAT_ENV]: 'TMPDIR' }, unset: [] }, fixtureSubject(), where)) as Record<
      string,
      unknown
    >;

    expect(seen['TMPDIR']).toMatch(/\/tmp$/u);
    expect(seen['mode:TMPDIR']).toBe(0o700);
    expect(seen['mode:TMPDIR/..']).toBe(0o700);
    expect(seen[STORE_ENV]).not.toBeNull();
    expect(existsSync(safePath.join(where.arms, FIXTURE_ALIAS, 'store'))).toBe(false);
  });
});

describe('verdict capture — refusals', () => {
  it('refuses an --out inside a subject', async () => {
    const subjectPath = fixtureSubject();

    const result = await capture({ set: {}, unset: [] }, subjectPath, { out: safePath.join(subjectPath, 'lab-out'), arms: tempDir('lab-verdict-arms-') });

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('lies inside the subject') });
  });

  it('refuses an --arms-dir whose alias directory IS a subject, and neither chmods nor empties it', async () => {
    // The operator's real mistake: --arms-dir ~/work with an alias equal to a checkout under it.
    const parent = tempDir('lab-verdict-parent-');
    const subjectPath = safePath.join(parent, FIXTURE_ALIAS);
    mkdirSyncReal(safePath.join(subjectPath, 'home'), { recursive: true, mode: 0o755 });
    writeFileSync(safePath.join(subjectPath, 'home', 'keep.txt'), 'the subject’s');

    const result = await capture({ set: {}, unset: [] }, subjectPath, { out: tempDir('lab-verdict-out-'), arms: parent });

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('is the subject') });
    expect(readFileSync(safePath.join(subjectPath, 'home', 'keep.txt'), 'utf-8')).toBe('the subject’s');
    if (process.platform !== 'win32') expect(statSync(subjectPath).mode & 0o777).not.toBe(0o700);
  });

  it('refuses a caller that names VAT_PROJECTION_STORE_DIR', async () => {
    const result = await capture(
      { set: { [STORE_ENV]: tempDir('lab-verdict-store-') }, unset: [] },
      fixtureSubject(),
      scratch(),
    );

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining(`${STORE_ENV} is set by the lab itself`) });
  });

  it('refuses a caller that names TMPDIR', async () => {
    const result = await capture({ set: { TMPDIR: tempDir('lab-verdict-tmp-') }, unset: [] }, fixtureSubject(), scratch());

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('TMPDIR is set by the lab itself') });
  });

  it('refuses a caller that names CLAUDE_CONFIG_DIR', async () => {
    const result = await capture({ set: {}, unset: [CLAUDE_ENV] }, fixtureSubject(), scratch());

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining(`${CLAUDE_ENV} is set by the lab itself`) });
  });

  it.for([
    ['whose private store an earlier capture already made', ['store']],
    ['whose tmp an earlier capture left, even with no store — a parse cache is warm state too', ['tmp', '.vat-cache']],
  ] as const)('refuses an --arms-dir %s, and leaves it as it was', async ([, segments]) => {
    const where = scratch();
    const leftover = safePath.join(where.arms, FIXTURE_ALIAS, ...segments);
    mkdirSyncReal(leftover, { recursive: true });

    const result = await capture({ set: {}, unset: [] }, fixtureSubject(), where);

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('Capture into a fresh --arms-dir') });
    expect(existsSync(leftover)).toBe(true);
  });
});

describe('verdict capture — a build verb the subject cannot complete', () => {
  const reason = 'the subject needs a build artifact it has not produced';

  // The build verbs run in an APFS clone (`cp -c`), so this path exists on macOS only. CI runs
  // ubuntu and Windows, so a green CI says nothing about it: run this file on a Mac after touching it.
  it.runIf(process.platform === 'darwin')('still runs it — last — and records the exclusion beside its row', async () => {
    const result = await capture({ set: {}, unset: [] }, fixtureSubject(), scratch(), {
      buildVerbs: true,
      unmeasurableBuildVerbs: { build: reason },
    });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
    const body = result.envelopes[0]?.body;

    // Never dropped: a verb that is not run cannot be caught becoming measurable.
    // Last: a build that stops half-way must not be what `verify` measures.
    expect(body?.rows.map((row) => row.name)).toEqual(['audit', 'verify', 'marketplace-publish-dry-run', 'build']);
    expect(body?.rows.every((row) => row.outcome === 'exited')).toBe(true);
    expect(body?.excluded).toEqual([{ name: 'build', reason }]);
    expect(VerdictBodySchema.safeParse(body).success).toBe(true);
  });
});
