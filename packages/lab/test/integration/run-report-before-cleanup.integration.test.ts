/**
 * `<facet> run` writes its report BEFORE the arms root ends: a cleanup that
 * fails after a finished capture must not cost the measurement. The cleanup is
 * made to fail for real — the stand-in vat removes the default run
 * directory's marker, so the lab refuses to remove a root it can no longer
 * prove is its own — and the report must already be on disk.
 *
 * Every variable the lab or a child could reach of the developer's own state
 * (`TMPDIR`/`TEMP`/`TMP`, `HOME`, `CLAUDE_CONFIG_DIR`) points at this case's
 * scratch directory.
 *
 * Integration-tier: the lab in-process, spawning a stand-in `dist:` build.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, normalizePath, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { createProgram } from '../../src/bin/vat-lab.js';

/** The stand-in build: answers `--version`, and in an arm removes its arms root's marker. */
const STAND_IN = [
  "const { existsSync, rmSync } = require('node:fs');",
  "const { join } = require('node:path');",
  "if (process.argv[2] === '--version') { process.stdout.write('9.9.9'); process.exit(0); }",
  'const store = process.env.VAT_PROJECTION_STORE_DIR;',
  // `<root>/<arm>/store`: the marker is two levels up, and only ever in a lab arms root.
  "const marker = store === undefined ? undefined : join(store, '..', '..', '.vat-lab-root');",
  'if (marker !== undefined && existsSync(marker)) rmSync(marker);',
  'process.exit(0);',
  '',
].join('\n');

let scratch: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/**
 * @param spy - A stream spy
 * @returns Everything written to it
 */
function written(spy: MockInstance): string {
  return spy.mock.calls.map(([chunk]) => String(chunk)).join('');
}

describe('vat-lab <facet> run — the report is written before the arms root ends', () => {
  it('keeps the finished report when removing the default run directory then fails, and says why', async () => {
    const made = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-run-cleanup-'));
    scratch = made;
    const root = normalizePath(made, made);
    const home = mkdirSyncReal(safePath.join(root, 'home'));
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, root);
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', home);
    const build = mkdirSyncReal(safePath.join(root, 'build'));
    writeFileSync(safePath.join(build, 'package.json'), JSON.stringify({ name: 'stand-in', version: '9.9.9' }));
    const bin = safePath.join(mkdirSyncReal(safePath.join(build, 'dist')), 'bin.js');
    writeFileSync(bin, STAND_IN);
    const subject = mkdirSyncReal(safePath.join(root, 'subject'));
    const out = safePath.join(root, 'out');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await createProgram().parseAsync([
      'node', 'vat-lab', 'perf', 'run', subject, '--instrument', `dist:${bin}`,
      '--command', 'skills-list', '--runs', '1', '--cache', 'cold', '--out', out,
    ]);

    expect(written(stderr)).toMatch(/^REFUSED: .*carries no \.vat-lab-root/mu);
    expect(process.exitCode).toBe(2);
    expect(written(stdout)).toMatch(/^Wrote /mu);
    expect(readdirSync(out).length).toBeGreaterThan(0);
  });
});
