/**
 * What `packageSkill` writes BESIDE and INTO its output — the ZIP, the npm
 * `package.json`, the marketplace manifest — and the output plan a dry run
 * shares with the real run. A write the OS refuses is the run not finishing
 * (a classified `destination` fault, `RUN_INCOMPLETE`), never an uncoded errno, and
 * nothing of the package lands: the output and every archive are one plan; an
 * occupied output is refused naming `--force`.
 */

import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { FS_FAULT_CODE, safePath, TREE_DEST_HOLDS_SOURCE_CODE, TREE_DEST_NOT_OWNED_CODE } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, installFaultFs, withSyncFsRefused } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { packageSkill } from '../src/skill-packager.js';

import { createFrontmatter, setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('package-output-unit-');

const SKILL_NAME = 'output-skill';
const DIRECTORY = 'directory' as const;
/** A write of the package's output the OS refused: the run did not finish (`RUN_INCOMPLETE`). */
const OUTPUT_FAULT = { code: FS_FAULT_CODE, side: 'destination' };

async function writeSkill(dir: string): Promise<string> {
  const skillPath = safePath.join(dir, 'SKILL.md');
  await writeFile(skillPath, `${createFrontmatter({ name: SKILL_NAME })}\n\n# Output Skill\n\nContent.`);
  return skillPath;
}

/** A skill in a fresh temp dir beside an output directory `keep/` already holding `file`. */
async function occupiedOutput(file: string, content: string): Promise<{ tmp: string; sp: string; out: string }> {
  const tmp = getTempDir();
  const sp = await writeSkill(tmp);
  const out = safePath.join(tmp, 'keep');
  await mkdir(out, { recursive: true });
  await writeFile(safePath.join(out, file), content);
  return { tmp, sp, out };
}

/** Run `body` while a write of the staged entry the plan makes for `dest` (`.<base>.vat-staged-…` beside it) rejects with `errno`. */
async function withStagedWriteRefused<T>(dir: string, dest: string, errno: 'ENOSPC' | 'EACCES', body: () => Promise<T>): Promise<T> {
  const base = dest.slice(dest.lastIndexOf('/') + 1);
  const session = installFaultFs({ within: dir, faults: [{ family: 'write', path: (path) => path.includes(`/.${base}.vat-staged-`), errno }] });
  try {
    return await body();
  } finally {
    session.restore();
  }
}

/** Nothing of a refused package is left in `tmp`: no output, no archive, no staged entry. */
function expectNothingLanded(tmp: string, skillFile: string): void {
  expect(readdirSync(tmp).filter((name) => name !== skillFile)).toEqual([]);
}

describe('packageSkill - artifacts the OS will not let it write', () => {
  it('codes a refused marketplace manifest as an unfinished run, and lands nothing', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);
    const manifest = safePath.join(tmp, `${SKILL_NAME}.marketplace.json`);

    await withStagedWriteRefused(tmp, manifest, 'ENOSPC', async () => {
      await expect(packageSkill(sp, { outputPath: safePath.join(tmp, 'pkg'), formats: [DIRECTORY, 'marketplace'] }))
        .rejects.toMatchObject(OUTPUT_FAULT);
    });
    expectNothingLanded(tmp, 'SKILL.md');
  });

  it('codes a refused npm package.json as an unfinished run, and lands nothing', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);
    const session = installFaultFs({ within: tmp, faults: [{ family: 'write', path: (path) => path.endsWith('/package.json'), errno: 'EACCES' }] });
    try {
      await expect(packageSkill(sp, { outputPath: safePath.join(tmp, 'pkg'), formats: [DIRECTORY, 'npm'] }))
        .rejects.toMatchObject(OUTPUT_FAULT);
    } finally {
      session.restore();
    }
    expectNothingLanded(tmp, 'SKILL.md');
  });

  it('codes a ZIP the disk refuses as an unfinished run naming it, and lands neither the ZIP nor the bundle', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);
    const out = safePath.join(tmp, 'z');

    await withStagedWriteRefused(tmp, `${out}.zip`, 'ENOSPC', async () => {
      await expect(packageSkill(sp, { outputPath: out, formats: [DIRECTORY, 'zip'] }))
        .rejects.toMatchObject({ ...OUTPUT_FAULT, message: expect.stringContaining('z.zip') as unknown });
    });
    // Left behind, the next run would refuse it as "something VAT did not make".
    expectNothingLanded(tmp, 'SKILL.md');
  });

  it('never removes a directory standing where the archive goes, --force or not', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);
    const out = safePath.join(tmp, 'z');
    await mkdir(safePath.join(`${out}.zip`, 'inside'), { recursive: true });

    await expect(packageSkill(sp, { outputPath: out, formats: [DIRECTORY, 'zip'], replaceExistingOutput: true }))
      .rejects.toMatchObject({ code: TREE_DEST_NOT_OWNED_CODE });
    expect(existsSync(safePath.join(`${out}.zip`, 'inside'))).toBe(true);
    expect(existsSync(out)).toBe(false);
  });
});

/** The output's plan, decided by a dry run: the check the real run makes, before anything is written. */
const dryRun = (sp: string, out: string, extra: { formats?: Array<'directory' | 'zip'>; replaceExistingOutput?: boolean } = {}) =>
  packageSkill(sp, { outputPath: out, formats: extra.formats ?? [DIRECTORY], dryRun: true, ...(extra.replaceExistingOutput === true && { replaceExistingOutput: true }) });

/**
 * A listing of the output the OS refused: the project crawl meets it first (the output lies in
 * the project), and the crawl's declared outputs make it the destination's — the run stopping
 * (RUN_INCOMPLETE), never relabelled a usage error.
 */
const outputListingFault = (cause: Record<string, string>) => ({ code: FS_FAULT_CODE, cause: { side: 'destination', ...cause } });

describe('the output plan - the check a dry run shares with the real run', () => {
  // Only an absence proves the output free. One the OS will not stat or list is neither occupied
  // nor free: a destination fault, the run stopping (RUN_INCOMPLETE), never relabelled a usage error.
  it.skipIf(CANNOT_DENY_READS)('refuses an output directory the OS will not list as a destination fault, never as occupied', async () => {
    const { sp, out } = await occupiedOutput('mine.txt', 'kept');
    chmodSync(out, 0o000);
    try {
      await expect(dryRun(sp, out)).rejects.toMatchObject(outputListingFault({ faultClass: 'refused' }));
    } finally {
      chmodSync(out, 0o755);
    }
  });

  it('refuses an output directory whose listing runs out of descriptors (EMFILE) as a destination fault', async () => {
    const { sp, out } = await occupiedOutput('mine.txt', 'kept');
    await withSyncFsRefused('readdirSync', out, 'EMFILE', async () => {
      await expect(dryRun(sp, out)).rejects.toMatchObject(outputListingFault({ faultClass: 'exhausted' }));
    });
  });

  it('refuses an archive beside the output it cannot examine (EMFILE) as a destination fault, never as occupied', async () => {
    const { sp, out } = await occupiedOutput('mine.txt', 'kept');
    await withSyncFsRefused('lstatSync', `${out}.zip`, 'EMFILE', async () => {
      await expect(dryRun(sp, out, { formats: [DIRECTORY, 'zip'], replaceExistingOutput: true }))
        .rejects.toMatchObject({ ...OUTPUT_FAULT, faultClass: 'exhausted' });
    });
  });

  it('refuses an occupied output, naming --force as the way to replace a previous package', async () => {
    const { sp, out } = await occupiedOutput('mine.txt', 'precious');

    await expect(dryRun(sp, out)).rejects.toMatchObject({
      code: TREE_DEST_NOT_OWNED_CODE,
      message: expect.stringContaining('--force') as unknown,
    });
    expect(readFileSync(safePath.join(out, 'mine.txt'), 'utf-8')).toBe('precious');
  });

  it('passes an occupied output it is told to replace, and an absent one', async () => {
    const { tmp, sp, out } = await occupiedOutput('old.txt', 'old');

    expect((await dryRun(sp, out, { replaceExistingOutput: true })).plannedChanges).toEqual([`replace skill '${SKILL_NAME}' output ${out}`]);
    const fresh = safePath.join(tmp, 'new');
    expect((await dryRun(sp, fresh)).plannedChanges).toEqual([`create skill '${SKILL_NAME}' output ${fresh}`]);
  });

  it('refuses an output holding the source even when told to replace it', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);

    await expect(dryRun(sp, tmp, { replaceExistingOutput: true })).rejects.toMatchObject({ code: TREE_DEST_HOLDS_SOURCE_CODE });
  });

  // The OS will not let VAT examine the directory the output goes in: the destination's fault, naming
  // the errno — once a raw EACCES from realpath, INTERNAL_ERROR.
  it.skipIf(CANNOT_DENY_READS)('refuses an output under a directory the OS will not examine, coded, --force or not', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);
    const lockout = safePath.join(tmp, 'lockout');
    await mkdir(lockout);
    chmodSync(lockout, 0o000);
    try {
      for (const replaceExistingOutput of [false, true]) {
        await expect(dryRun(sp, safePath.join(lockout, 'out'), { replaceExistingOutput }))
          .rejects.toMatchObject(outputListingFault({ errno: 'EACCES' }));
      }
    } finally {
      chmodSync(lockout, 0o755);
    }
  });
});
