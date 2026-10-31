/**
 * `vat-lab perf arms` end to end leaves nothing another user can read: `--out`
 * is forced to 0700 even when it already existed wider, `arms-report.json` is
 * 0600, and the prepared clone lives under the `--arms-dir` root, itself forced
 * to 0700. The report names the clone it measured.
 *
 * POSIX modes only: a Windows host has no group or other bits to assert.
 *
 * System-tier: real git, the built vat, five rounds of one CI sequence.
 */

import { readFileSync, statSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/bin/vat-lab.js';
import { cleanupVerdictFixtures, tempDir } from '../integration/verdict-fixtures.js';

import { CANDIDATE_SOURCE, cleanSubject } from './candidate-subject.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

afterAll(cleanupVerdictFixtures);

/**
 * @param path - A file or directory
 * @returns Its permission bits
 */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('vat-lab perf arms — what it writes is owner-only', () => {
  it.skipIf(process.platform === 'win32')('forces --out to 0700, writes the report 0600, and prepares the clone under a 0700 arms root', async () => {
    // Nothing here may reach the developer's own state, even outside the arms.
    const sandbox = tempDir('lab-arms-private-env-');
    vi.stubEnv('HOME', safePath.join(sandbox, 'home'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', safePath.join(sandbox, 'claude'));
    vi.stubEnv('TMPDIR', sandbox);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const subject = cleanSubject();
    // Both exist already, world-readable: the lab must narrow them, not trust them.
    const out = safePath.join(tempDir('lab-arms-private-out-'), 'out');
    const armsDir = safePath.join(tempDir('lab-arms-private-arms-'), 'arms');
    mkdirSyncReal(out, { mode: 0o755 });
    mkdirSyncReal(armsDir, { mode: 0o755 });
    if (CANDIDATE_SOURCE.kind !== 'dist') throw new Error('the candidate is a dist: build');

    await createProgram().parseAsync([
      'node',
      'vat-lab',
      'perf',
      'arms',
      subject,
      '--build',
      `cand=dist:${CANDIDATE_SOURCE.path}`,
      '--arm',
      'cand:ci-c:cold',
      '--out',
      out,
      '--arms-dir',
      armsDir,
    ]);

    expect(process.exitCode).toBeUndefined();
    const report = safePath.join(out, 'arms-report.json');
    expect(modeOf(out)).toBe(0o700);
    expect(modeOf(report)).toBe(0o600);
    expect(modeOf(armsDir)).toBe(0o700);
    const written = JSON.parse(readFileSync(report, 'utf-8')) as { readonly prepared: { readonly path: string } };
    expect(written.prepared.path).toBe(safePath.join(armsDir, 'clone'));
    expect(statSync(written.prepared.path).isDirectory()).toBe(true);
  });
});
