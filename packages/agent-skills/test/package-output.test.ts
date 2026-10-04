/**
 * What `packageSkill` writes BESIDE and INTO its output — the ZIP, the npm
 * `package.json`, the marketplace manifest — and the output check a dry run
 * shares with the real run. A write the OS refuses is the run not finishing
 * (`SKILL_PACKAGING_OUTPUT_FAILED`), never an uncoded errno, and what VAT wrote
 * of it is removed; an occupied output is refused naming `--force`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { refuseAsyncFs } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { SKILL_PACKAGING_OUTPUT_FAILED_CODE, SKILL_PACKAGING_OUTPUT_OCCUPIED_CODE } from '../src/packaging-errors.js';
import { checkPackageOutput, packageSkill } from '../src/skill-packager.js';

import { createFrontmatter, setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('package-output-unit-');

const SKILL_NAME = 'output-skill';
const DIRECTORY = 'directory' as const;

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

/** Run `body` while `fs/promises.writeFile` of exactly `path` rejects with `code`, writing nothing. */
async function withWriteRefused<T>(path: string, code: string, body: () => Promise<T>): Promise<T> {
  const restore = refuseAsyncFs('writeFile', path, code);
  try {
    return await body();
  } finally {
    restore();
  }
}

describe('packageSkill - artifacts the OS will not let it write', () => {
  it('codes a refused marketplace manifest as an unfinished run, never INTERNAL_ERROR', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);
    const manifest = safePath.join(tmp, `${SKILL_NAME}.marketplace.json`);

    await withWriteRefused(manifest, 'ENOSPC', async () => {
      await expect(packageSkill(sp, { outputPath: safePath.join(tmp, 'pkg'), formats: [DIRECTORY, 'marketplace'] }))
        .rejects.toMatchObject({ code: SKILL_PACKAGING_OUTPUT_FAILED_CODE });
    });
  });

  it('codes a refused npm package.json as an unfinished run, never INTERNAL_ERROR', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);
    const out = safePath.join(tmp, 'pkg');

    await withWriteRefused(safePath.join(out, 'package.json'), 'EACCES', async () => {
      await expect(packageSkill(sp, { outputPath: out, formats: [DIRECTORY, 'npm'] }))
        .rejects.toMatchObject({ code: SKILL_PACKAGING_OUTPUT_FAILED_CODE });
    });
  });

  it('names the ZIP forward-slashed and project-relative, and removes the partial archive it wrote', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);
    const out = safePath.join(tmp, 'z');
    const zip = `${out}.zip`;
    // A full disk: the write creates the archive, truncated, then fails.
    const restore = refuseAsyncFs('writeFile', zip, 'ENOSPC', () => writeFileSync(zip, 'partial'));
    try {
      await expect(packageSkill(sp, { outputPath: out, formats: [DIRECTORY, 'zip'] }))
        .rejects.toMatchObject({
          code: SKILL_PACKAGING_OUTPUT_FAILED_CODE,
          message: expect.stringMatching(/^ZIP archive z\.zip,/) as unknown,
        });
    } finally {
      restore();
    }
    // Left behind, the next run would refuse it as "a previous package".
    expect(existsSync(zip)).toBe(false);
  });

  it('never removes a directory standing where the archive goes', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);
    const out = safePath.join(tmp, 'z');
    await mkdir(safePath.join(`${out}.zip`, 'inside'), { recursive: true });

    await expect(packageSkill(sp, { outputPath: out, formats: [DIRECTORY, 'zip'], replaceExistingOutput: true }))
      .rejects.toMatchObject({ code: SKILL_PACKAGING_OUTPUT_FAILED_CODE });
    expect(existsSync(safePath.join(`${out}.zip`, 'inside'))).toBe(true);
  });
});

describe('checkPackageOutput - the check a dry run shares with the real run', () => {
  it('refuses an occupied output, naming --force as the way to replace a previous package', async () => {
    const { tmp, sp, out } = await occupiedOutput('mine.txt', 'precious');

    expect(() => checkPackageOutput({ outputPath: out, skillName: SKILL_NAME, formats: [DIRECTORY], sources: [sp], projectRoot: tmp }))
      .toThrow(expect.objectContaining({
        code: SKILL_PACKAGING_OUTPUT_OCCUPIED_CODE,
        message: expect.stringContaining('--force') as unknown,
      }));
    expect(readFileSync(safePath.join(out, 'mine.txt'), 'utf-8')).toBe('precious');
  });

  it('passes an occupied output it is told to replace, and an absent one', async () => {
    const { tmp, sp, out } = await occupiedOutput('old.txt', 'old');

    expect(() => checkPackageOutput({ outputPath: out, skillName: SKILL_NAME, formats: [DIRECTORY], sources: [sp], projectRoot: tmp, replaceExistingOutput: true }))
      .not.toThrow();
    expect(() => checkPackageOutput({ outputPath: safePath.join(tmp, 'new'), skillName: SKILL_NAME, formats: [DIRECTORY], sources: [sp], projectRoot: tmp }))
      .not.toThrow();
  });

  it('refuses an output holding the source even when told to replace it', async () => {
    const tmp = getTempDir();
    const sp = await writeSkill(tmp);

    expect(() => checkPackageOutput({ outputPath: tmp, skillName: SKILL_NAME, formats: [DIRECTORY], sources: [sp], projectRoot: tmp, replaceExistingOutput: true }))
      .toThrow(expect.objectContaining({ code: SKILL_PACKAGING_OUTPUT_OCCUPIED_CODE }));
  });
});
