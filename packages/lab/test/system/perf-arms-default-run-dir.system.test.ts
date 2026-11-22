/**
 * In a default run directory, `vat-lab perf arms` keeps only the prepared clone
 * its report names, beside the run directory, which it removes whole, saying
 * both; a refused run writes no report and leaves nothing.
 *
 * System-tier: real git, the built vat.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { everywhere, pathPresent, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/bin/vat-lab.js';
import { tempDir } from '../integration/verdict-fixtures.js';

import { candidate, restoreAfterEachArmsTest, sandboxed, written } from './arms-sandbox.js';
import { cleanSubject } from './candidate-subject.js';

restoreAfterEachArmsTest();

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

