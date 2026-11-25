/**
 * What the lab writes is owner-only, and a run's arms end with it:
 *
 * - `vat-lab perf arms` creates an absent `--out` and `--arms-dir` at 0700,
 *   writes `arms-report.json` 0600 in the shape its judges read back, and
 *   prepares the clone under the arms root.
 *   An `--out` that IS the subject (`--out .` from its root) is refused before
 *   anything runs, and the subject is neither written into nor chmodded.
 * - `vat-lab perf run` removes its default run directory of arms when the
 *   capture ends, and keeps it under `--keep-arms`, saying which.
 *
 * A default `perf arms` run directory is `perf-arms-default-run-dir.system.test.ts`:
 * each successful `perf arms` run is five cold rounds, so the two live in separate
 * files that run in parallel.
 *
 * System-tier: real git, the built vat.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/bin/vat-lab.js';
import { readArmsReportFile } from '../../src/facets/perf/arms-report-file.js';
import { builtLabProgram } from '../integration/probe-fixtures.js';
import { tempDir } from '../integration/verdict-fixtures.js';

import { candidate, modeOf, POSIX, restoreAfterEachArmsTest, sandboxed, written } from './arms-sandbox.js';
import { cleanSubject } from './candidate-subject.js';

restoreAfterEachArmsTest();

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
      edits: [],
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

describe('vat-lab perf run — the default run directory of arms ends with the capture', () => {
  it.for([
    { keep: false, said: 'Removed arms under', left: 0 },
    { keep: true, said: 'Kept arms under', left: 1 },
  ])('keep-arms=$keep: says "$said" and leaves $left run directories', async ({ keep, said, left }) => {
    const sandbox = sandboxed();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const subject = cleanSubject();
    const out = mkdirSyncReal(safePath.join(tempDir('lab-arms-cleanup-out-'), 'out'));

    // The built CLI: `perf run` loads the emitted probe, which exists only beside the built capture.
    await (await builtLabProgram()).parseAsync([
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
