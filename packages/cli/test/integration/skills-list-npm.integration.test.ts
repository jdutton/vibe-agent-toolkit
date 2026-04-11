/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listCommand, type SkillsListCommandOptions } from '../../src/commands/skills/list.js';
import { captureStdout } from '../helpers/stdout-capture.js';

/**
 * Run listCommand with mocked process.exit and captured stdout.
 * Returns the captured output string.
 */
async function runListCommand(
  pathArg: string,
  options: SkillsListCommandOptions = {},
): Promise<string> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const captured: string[] = [];
  const restore = captureStdout(captured);

  try {
    await listCommand(pathArg, options);
  } finally {
    restore();
    exitSpy.mockRestore();
  }

  return captured.join('');
}

/**
 * Build a minimal fake npm tarball that contains one SKILL.md under
 * package/dist/skills/<skillName>/SKILL.md inside the given tempDir.
 */
async function buildFakeTarball(
  tempDir: string,
  skillName: string,
  subdirName: string,
): Promise<string> {
  const pkgDir = safePath.join(tempDir, subdirName, 'package');
  const skillDir = safePath.join(pkgDir, 'dist', 'skills', skillName);
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Listed from tgz.\n---\n\n# ${skillName}\n`,
    'utf-8',
  );
  writeFileSync(
    safePath.join(pkgDir, 'package.json'),
    JSON.stringify({ name: subdirName, version: '1.0.0' }),
    'utf-8',
  );

  const tarModule = await import('tar');
  const tarballPath = safePath.join(tempDir, `${subdirName}-1.0.0.tgz`);
  await tarModule.create(
    { file: tarballPath, cwd: safePath.join(tempDir, subdirName), gzip: true },
    ['package'],
  );

  return tarballPath;
}

describe('vat skills list — npm source', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-skills-list-npm-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists skills from a local .tgz package without installing', async () => {
    const tarballPath = await buildFakeTarball(tempDir, 'listed-skill', 'fake-listed');

    const output = await runListCommand(tarballPath);

    expect(output).toContain('listed-skill');
    expect(output).toContain('context: npm');
  });

  it('reports zero skills when tgz dist/skills/ is empty', async () => {
    // Build a fake npm package with empty dist/skills/
    const pkgDir = safePath.join(tempDir, 'empty-pkg', 'package');
    const distSkillsDir = safePath.join(pkgDir, 'dist', 'skills');
    mkdirSyncReal(distSkillsDir, { recursive: true });
    writeFileSync(
      safePath.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'empty-pkg', version: '1.0.0' }),
      'utf-8',
    );

    const tarModule = await import('tar');
    const tarballPath = safePath.join(tempDir, 'empty-pkg-1.0.0.tgz');
    await tarModule.create(
      { file: tarballPath, cwd: safePath.join(tempDir, 'empty-pkg'), gzip: true },
      ['package'],
    );

    const output = await runListCommand(tarballPath);

    expect(output).toContain('skillsFound: 0');
    expect(output).toContain('context: npm');
  });
});
