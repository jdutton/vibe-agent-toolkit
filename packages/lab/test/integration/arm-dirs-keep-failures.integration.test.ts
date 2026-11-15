/**
 * Keeping `perf arms`' prepared clone when a step of the keep itself fails —
 * the rename into the fresh `clone-*` holder, or removing that holder once it
 * is empty again (a Windows `EBUSY`, say). The report is the primary output: a
 * failed move still hands `write` the clone's place in the run directory, and
 * a failure to tidy the empty holder is said, never thrown in the report's way.
 *
 * The two tree primitives are wrapped so one call can be made to fail; every
 * other call goes to the real implementation, against scratch directories
 * under a stubbed OS temp directory.
 *
 * Integration-tier: real directories under the OS temp directory.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type * as Utils from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ArmsRootHandle, underArmsRoot } from '../../src/harness/arm-dirs.js';

const { renameFileAtomic, applyTreePlan } = vi.hoisted(() => ({ renameFileAtomic: vi.fn(), applyTreePlan: vi.fn() }));
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
  const real = await importOriginal<typeof Utils>();
  renameFileAtomic.mockImplementation(real.renameFileAtomic);
  applyTreePlan.mockImplementation(real.applyTreePlan);
  return { ...real, renameFileAtomic, applyTreePlan };
});

let out: string;
let real: { readonly rename: typeof Utils.renameFileAtomic; readonly apply: typeof Utils.applyTreePlan };

beforeEach(() => {
  out = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-arm-keep-failures-'));
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, out);
  real = { rename: renameFileAtomic.getMockImplementation() as typeof Utils.renameFileAtomic, apply: applyTreePlan.getMockImplementation() as typeof Utils.applyTreePlan };
});

afterEach(() => {
  renameFileAtomic.mockImplementation(real.rename);
  applyTreePlan.mockImplementation(real.apply);
  vi.unstubAllEnvs();
  rmSync(out, { recursive: true, force: true });
});

/** An `EBUSY`, as Windows reports a directory something still holds open. */
function busy(): Error {
  return Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
}

/** The holder removal is the only plan whose one change is labelled `clone holder`. */
function failHolderRemoval(): void {
  applyTreePlan.mockImplementation((plan: Parameters<typeof Utils.applyTreePlan>[0], ...rest: unknown[]) =>
    plan.changes.some((planned) => planned.change.label === 'clone holder') ? Promise.reject(busy()) : (real.apply as (...args: unknown[]) => ReturnType<typeof Utils.applyTreePlan>)(plan, ...rest),
  );
}

/**
 * Run a body under a default run directory holding a clone, recording what is said.
 *
 * @param keep - What the body does with the handle once the clone is laid out
 * @returns What was said, the run directory, and how the run ended
 */
async function underRun(keep: (root: ArmsRootHandle) => Promise<void>): Promise<{ readonly said: string[]; readonly run: string; readonly thrown: unknown }> {
  const said: string[] = [];
  let run = '';
  const thrown = await underArmsRoot({ override: null, subjects: [] }, false, (line) => said.push(line), async (root) => {
    run = root.path;
    writeFileSync(safePath.join(mkdirSyncReal(safePath.join(root.path, 'clone')), 'README.md'), 'cloned');
    await keep(root);
  }).then(
    () => null,
    (error: unknown) => error,
  );
  return { said, run, thrown };
}

describe('keepChild — a failure in the keep never costs the report', () => {
  it('writes the report naming the clone in the run directory when the rename fails and the empty holder cannot be removed either, and says both', async () => {
    renameFileAtomic.mockRejectedValueOnce(busy());
    failHolderRemoval();
    const handed: string[] = [];

    const { said, run, thrown } = await underRun((root) => root.keepChild('clone', (kept) => handed.push(kept)));

    expect(thrown).toBeNull();
    const inside = safePath.join(run, 'clone');
    expect(handed).toStrictEqual([inside]);
    const unmoved = said.find((line) => line.startsWith(`Could not move the prepared clone out of ${run}: `)) ?? '';
    expect(unmoved).toContain('EBUSY');
    expect(unmoved).toMatch(/the empty '.+clone-.{6}' could not be removed: EBUSY/u);
    expect(said.slice(-2)).toStrictEqual([`Prepared clone kept at ${inside}; remove it when done`, `Kept arms under ${run}`]);
    expect(readFileSync(safePath.join(inside, 'README.md'), 'utf-8')).toBe('cloned');
  });

  it('names the holder removal, not the move back, when the clone went back but its empty holder could not be removed', async () => {
    failHolderRemoval();

    const { thrown } = await underRun((root) =>
      root.keepChild('clone', () => {
        throw new Error('the report write failed');
      }),
    );

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message.startsWith('the report write failed\n')).toBe(true);
    expect(message).toMatch(/removing the empty '.+clone-.{6}' after moving the clone back failed too: EBUSY/u);
    expect(message).not.toContain('back into the run directory failed');
  });
});
