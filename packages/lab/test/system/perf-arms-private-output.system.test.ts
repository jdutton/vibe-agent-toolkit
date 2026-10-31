/**
 * What the lab writes is owner-only, and it touches only what it made:
 *
 * - `vat-lab perf arms` creates an absent `--out` and `--arms-dir` at 0700,
 *   writes `arms-report.json` 0600 in the shape its judges read back, and
 *   prepares the clone under the arms root.
 *   An `--out` that IS the subject (`--out .` from its root) is refused before
 *   anything runs, and the subject is neither written into nor chmodded.
 *   In a default run directory it keeps only the prepared clone its report
 *   names, beside the run directory, which it removes whole, saying both; a
 *   refused run writes no report and leaves nothing.
 * - `vat-lab perf run` removes its default run directory of arms when the
 *   capture ends, and keeps it under `--keep-arms`, saying which.
 *
 * POSIX modes only where a mode is asserted: a Windows host has no group or other bits.
 *
 * System-tier: real git, the built vat.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { everywhere, mkdirSyncReal, pathPresent, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { createProgram } from '../../src/bin/vat-lab.js';
import { readArmsReportFile } from '../../src/facets/perf/arms-report-file.js';
import { cleanupVerdictFixtures, tempDir } from '../integration/verdict-fixtures.js';

import { CANDIDATE_SOURCE, cleanSubject } from './candidate-subject.js';

const POSIX = process.platform !== 'win32';

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

/**
 * Point everything the lab or vat could reach of the developer's own state at a sandbox.
 *
 * @returns The sandbox, which is also the OS temp directory for the run
 */
function sandboxed(): string {
  const sandbox = tempDir('lab-arms-private-env-');
  vi.stubEnv('HOME', safePath.join(sandbox, 'home'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', safePath.join(sandbox, 'claude'));
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, sandbox);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  return sandbox;
}

/** @returns The candidate's `dist:` specifier */
function candidate(): string {
  if (CANDIDATE_SOURCE.kind !== 'dist') throw new Error('the candidate is a dist: build');
  return `dist:${CANDIDATE_SOURCE.path}`;
}

/**
 * @param spy - The stderr spy
 * @returns Everything written to it
 */
function written(spy: MockInstance): string {
  return spy.mock.calls.map(([chunk]) => String(chunk)).join('');
}

describe('vat-lab perf arms — what it writes is owner-only', () => {
  it('creates --out and --arms-dir at 0700, writes the report 0600, and prepares the clone under the arms root', async () => {
    sandboxed();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const subject = cleanSubject();
    const out = safePath.join(tempDir('lab-arms-private-out-'), 'out');
    const armsDir = safePath.join(tempDir('lab-arms-private-arms-'), 'arms');

    await createProgram().parseAsync([
      'node', 'vat-lab', 'perf', 'arms', subject,
      '--build', `cand=${candidate()}`, '--arm', 'cand:ci-c:cold', '--out', out, '--arms-dir', armsDir,
    ]);

    expect(process.exitCode).toBeUndefined();
    const report = safePath.join(out, 'arms-report.json');
    if (POSIX) {
      expect(modeOf(out)).toBe(0o700);
      expect(modeOf(report)).toBe(0o600);
      expect(modeOf(armsDir)).toBe(0o700);
    }
    const parsed = JSON.parse(readFileSync(report, 'utf-8')) as { readonly prepared: { readonly path: string } };
    expect(parsed.prepared.path).toBe(safePath.join(armsDir, 'clone'));
    expect(statSync(parsed.prepared.path).isDirectory()).toBe(true);
    // What `perf arms` writes is what `perf bars` and `verdict union` read, inputs included.
    const read = readArmsReportFile(report);
    expect(read.ok ? read.report.inputs : read.refusal).toStrictEqual({
      env: { set: {}, unset: [] },
      expectedExits: [],
      prerequisites: [],
      timeoutMs: null,
    });
  });

  it('refuses an --out that IS the subject, before anything runs, and leaves the subject as it was', async () => {
    sandboxed();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const subject = cleanSubject();
    const before = { entries: readdirSync(subject).sort((a, b) => a.localeCompare(b)), mode: modeOf(subject) };

    await createProgram().parseAsync([
      'node', 'vat-lab', 'perf', 'arms', subject, '--build', `cand=${candidate()}`, '--arm', 'cand:ci-c:cold', '--out', subject,
    ]);

    expect(process.exitCode).toBe(2);
    expect(written(stderr)).toMatch(/^REFUSED: --out .* is the subject/mu);
    expect({ entries: readdirSync(subject).sort((a, b) => a.localeCompare(b)), mode: modeOf(subject) }).toStrictEqual(before);
  });
});

/**
 * @param sandbox - The run's OS temp directory
 * @returns Every entry of the lab's default arms base under it, sorted
 */
function armsBaseEntries(sandbox: string): string[] {
  const base = readdirSync(sandbox).find((name) => name.startsWith('vat-lab-arms-'));
  if (base === undefined) throw new Error(`no vat-lab-arms-* base under '${sandbox}'`);
  return readdirSync(safePath.join(sandbox, base)).sort((a, b) => a.localeCompare(b));
}

/**
 * Run `perf arms` over a fresh clean subject into a default run directory.
 *
 * @param extra - Further flags
 * @returns The sandbox, the stderr written, and the report path
 */
async function defaultArmsRun(extra: readonly string[]): Promise<{ readonly sandbox: string; readonly said: string; readonly report: string }> {
  const sandbox = sandboxed();
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const subject = cleanSubject();
  const out = safePath.join(tempDir('lab-arms-default-out-'), 'out');
  await createProgram().parseAsync([
    'node', 'vat-lab', 'perf', 'arms', subject, '--build', `cand=${candidate()}`, '--arm', 'cand:ci-c:cold', '--out', out, ...extra,
  ]);
  return { sandbox, said: written(stderr), report: safePath.join(out, 'arms-report.json') };
}

describe('vat-lab perf arms — a default run directory leaves only the clone its report names', () => {
  it('on success: removes the run directory whole, keeps the clone beside it, and says both', async () => {
    const { sandbox, said, report } = await defaultArmsRun([]);

    expect(process.exitCode, said).toBeUndefined();
    const parsed = JSON.parse(readFileSync(report, 'utf-8')) as { readonly prepared: { readonly path: string } };
    expect(statSync(parsed.prepared.path).isDirectory()).toBe(true);
    const run = /^Arms under (.+)$/mu.exec(said)?.[1] ?? '';
    expect(said).toContain(`Prepared clone kept at ${parsed.prepared.path}; remove it when done\nRemoved arms under ${run}\n`);
    const holder = dirname(parsed.prepared.path);
    expect(basename(parsed.prepared.path)).toBe('clone');
    expect(dirname(holder)).toBe(dirname(run));
    expect(armsBaseEntries(sandbox)).toStrictEqual([basename(holder)]);
  });

  it.for([
    { refused: 'a commit the subject does not have', extra: ['--commit', 'no-such-ref'] },
    { refused: 'a failing prerequisite', extra: ['--prerequisite', 'node -e process.exit(3)'] },
  ])('refusing $refused: writes no report, removes the run directory whole, and keeps no clone', async ({ extra }) => {
    const { sandbox, said, report } = await defaultArmsRun(extra);

    expect(process.exitCode).toBe(2);
    expect(said).toMatch(/^REFUSED: /mu);
    expect(pathPresent(report, 'entry', everywhere('destination'), 'confirmed')).toBe(false);
    expect(said).toMatch(/^Removed arms under .+$/mu);
    expect(said).not.toContain('Prepared clone kept');
    expect(armsBaseEntries(sandbox)).toStrictEqual([]);
  });
});

describe('vat-lab perf run — the default run directory of arms ends with the capture', () => {
  it.for([
    { keep: false, said: 'Removed arms under', left: 0 },
    { keep: true, said: 'Kept arms under', left: 1 },
  ])('keep-arms=$keep: says "$said" and leaves $left run directories', async ({ keep, said, left }) => {
    const sandbox = sandboxed();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const subject = cleanSubject();
    const out = mkdirSyncReal(safePath.join(tempDir('lab-arms-cleanup-out-'), 'out'));

    await createProgram().parseAsync([
      'node', 'vat-lab', 'perf', 'run', subject, '--instrument', candidate(),
      '--command', 'resources-scan', '--runs', '1', '--cache', 'cold', '--out', out,
      ...(keep ? ['--keep-arms'] : []),
    ]);

    expect(written(stderr)).toContain(said);
    const base = readdirSync(sandbox).find((name) => name.startsWith('vat-lab-arms-'));
    expect(base).toBeDefined();
    expect(readdirSync(safePath.join(sandbox, base ?? '')).filter((name) => name.startsWith('run-'))).toHaveLength(left);
  });
});
