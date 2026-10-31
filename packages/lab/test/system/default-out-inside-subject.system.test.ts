/**
 * The invocation every lab README starts from — `vat-lab <facet> run .` from a
 * checkout's root, VAT's own included — leaves `--out` at its default
 * `.vat-lab`, INSIDE the subject. The reports may live there; the arms may not.
 * Each case spawns the BUILT lab against the BUILT vat from a neutral committed
 * subject's root and asserts the verb completes unrefused, the reports land under
 * `.vat-lab`, and every arm directory lies under the default arms root in the
 * OS temp directory — never under `--out`, never in the subject.
 *
 * Every child's `TMPDIR`/`TEMP`/`TMP`, `HOME` and `CLAUDE_CONFIG_DIR` point at
 * this file's scratch directory, so neither the default arms root nor any vat
 * config is the developer's.
 *
 * System-tier: spawns the built lab, which spawns the built vat.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

import { mkdirSyncReal, normalizePath, resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { cleanupVerdictFixtures, tempDir } from '../integration/verdict-fixtures.js';

import { cleanSubject } from './candidate-subject.js';

afterAll(cleanupVerdictFixtures);

const LAB_BIN = resolveFromImportMeta(import.meta.url, '../../dist/bin/vat-lab.js');
const CLI_DIST = resolveFromImportMeta(import.meta.url, '../../../cli/dist');

/**
 * One cheap command, one repeat or the facet's minimum: the subject of the test is WHERE the arms go.
 * `--keep-arms` keeps the default run directory so its contents can be read; its removal without the
 * flag is pinned by `perf-arms-private-output.system.test.ts`.
 */
const CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['perf run', ['perf', 'run', '.', '--instrument', `dist:${CLI_DIST}`, '--command', 'skills-list', '--runs', '1']],
  ['perf ab', ['perf', 'ab', '.', '--instrument-a', `dist:${CLI_DIST}`, '--control', '--pairs', '1', '--command', 'skills-list', '--runs', '1']],
  ['io run', ['io', 'run', '.', '--instrument', `dist:${CLI_DIST}`, '--command', 'skills-list', '--runs', '2']],
  ['population run', ['population', 'run', '.', '--instrument', `dist:${CLI_DIST}`, '--runs', '1']],
];

describe('the default --out inside the subject holds reports only', () => {
  it.for(CASES)('%s completes from the subject root, its arms under <os tmpdir>/vat-lab-arms-<user>', ([, args]) => {
    const subject = cleanSubject();
    const made = tempDir('lab-default-out-scratch-');
    const scratch = normalizePath(made, made);
    const home = safePath.join(scratch, 'home');
    mkdirSyncReal(home);

    const ran = spawnSync(NODE_EXECUTABLE, [LAB_BIN, ...args, '--keep-arms'], {
      cwd: subject,
      encoding: 'utf-8',
      env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch, HOME: home, CLAUDE_CONFIG_DIR: home },
    });

    // A one-pair control A/B may read machine noise as a change (exit 1); a refusal is 2, and none may refuse.
    expect([0, 1], `${ran.stdout}\n${ran.stderr}`).toContain(ran.status);
    expect(ran.stderr).not.toMatch(/REFUSED/u);
    const arms = /^Arms under (.+)$/mu.exec(ran.stderr)?.[1] ?? '';
    expect(toForwardSlash(arms).startsWith(`${toForwardSlash(scratch)}/vat-lab-arms-`), ran.stderr).toBe(true);
    expect(ran.stderr).toContain(`Kept arms under ${arms}`);
    expect(readdirSync(arms).length).toBeGreaterThan(0);
    const out = safePath.join(subject, '.vat-lab');
    expect(readdirSync(out).length).toBeGreaterThan(0);
    expect(existsSync(safePath.join(out, 'arms'))).toBe(false);
  }, 30_000);
});
