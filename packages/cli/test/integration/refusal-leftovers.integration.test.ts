/**
 * A refusal whose failure path left something behind — a temporary directory the
 * OS would not let VAT remove after the work failed — publishes the leftover as a
 * warning finding naming it. The failure itself is classified as it was thrown:
 * the leftover is recorded beside it (`suppressedFaultsOf`), never on its cause
 * chain, so it can never become the run's classification.
 */

import { disposeTempDir, normalizedTmpdir, suppressedFaultsOf, TREE_ROLLBACK_INCOMPLETE_CODE, VatError, withTempDir } from '@vibe-agent-toolkit/utils';
import { createTempDir, installFaultFs, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { NOTHING_FINISHED, refusalReport } from '../../src/utils/document-writer.js';

// ⛔ These tests fault and run a temp-dir disposal: the temp directory is a scratch tree first, so
// nothing they (or a red-proof mutation of the code under test) remove can be the user's.
let scratch: string | undefined;
beforeEach(() => {
  scratch = createTempDir('vat-cli-leftover-scratch-');
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, scratch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (scratch !== undefined) removeTempDir(scratch);
  scratch = undefined;
});

/** A `withTempDir` run whose work fails with `failure` and whose disposal the OS refuses: what it threw, and its directory. */
async function failWithLeftover(failure: Error): Promise<{ error: unknown; dir: string }> {
  const prefix = 'vat-cli-leftover-';
  const refused = { op: 'rm', path: (p: string) => p.includes(prefix), errno: 'EACCES' } as const;
  const session = installFaultFs({ within: normalizedTmpdir(), faults: [refused, { ...refused }] });
  let dir = '';
  try {
    await withTempDir(prefix, (given) => {
      dir = given;
      return Promise.reject(failure);
    });
  } catch (error: unknown) {
    return { error, dir };
  } finally {
    session.restore();
  }
  throw new Error('expected a rejection');
}

describe('refusalReport — a leftover beside the failure', () => {
  it('publishes the failure\'s own refusal, and the leftover as a TREE_CLEANUP_INCOMPLETE warning naming it', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { error, dir } = await failWithLeftover(new VatError('AGENT_MANIFEST_NOT_FOUND', 'no manifest at ./agent'));
    expect(suppressedFaultsOf(error)).toHaveLength(1);

    const code = refusalCodeOf(error);
    const report = refusalReport(code, error, { strict: false }, NOTHING_FINISHED);

    expect(code).toBe('USAGE_INVALID');
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID', message: 'no manifest at ./agent' } });
    expect(report.findings).toEqual([
      expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE', severity: 'warning', link: dir, message: expect.stringContaining(dir) as string }),
    ]);
    // Clean up what the injected refusal left.
    expect(await disposeTempDir(dir)).toBeUndefined();
  });

  it('still publishes the leftover when the failure reaches the report wrapped (a rollback-incomplete error, a verb\'s re-wrap)', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { error, dir } = await failWithLeftover(new Error('registry write failed'));
    const wrapped = new VatError(TREE_ROLLBACK_INCOMPLETE_CODE, 'registry write failed; and the change could not be undone', { cause: error });

    const report = refusalReport(refusalCodeOf(wrapped), wrapped, { strict: false }, NOTHING_FINISHED);

    expect(report).toMatchObject({ error: { code: 'RUN_INCOMPLETE' } });
    expect(report.findings).toEqual([expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE', link: dir })]);
    expect(await disposeTempDir(dir)).toBeUndefined();
  });

  it('publishes no extra finding for a failure with nothing left behind', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const report = refusalReport('USAGE_INVALID', new VatError('AGENT_MANIFEST_NOT_FOUND', 'x'), { strict: false }, NOTHING_FINISHED);
    expect(report.findings).toEqual([]);
  });
});
