import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { SKILLS_LIST_REPORT_SCHEMA, type SkillsListReport } from '../../src/commands/skills/list-schema.js';
import { listCommand } from '../../src/commands/skills/list.js';
import { captureCommand } from '../helpers/stdout-capture.js';

/** Run the list lane over `pathArg`: the report it published, validated against its registry schema, at exit 0. */
async function runListCommand(pathArg: string): Promise<SkillsListReport> {
  const { stdout, exited, stderr } = await captureCommand(() => listCommand(pathArg, {}));
  expect(exited, stderr).toBe(ExitCode.OK);
  return SKILLS_LIST_REPORT_SCHEMA.parse(yaml.parse(stdout));
}

/**
 * Build a minimal fake npm tarball that contains one SKILL.md under
 * package/dist/skills/<skillName>/SKILL.md inside the given tempDir.
 */
async function buildFakeTarball(
  tempDir: string,
  skillName: string,
  subdirName: string,
  declaredName: string = skillName,
): Promise<string> {
  const pkgDir = safePath.join(tempDir, subdirName, 'package');
  const skillDir = safePath.join(pkgDir, 'dist', 'skills', skillName);
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: ${declaredName}\ndescription: Listed from tgz.\n---\n\n# ${declaredName}\n`,
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

    const report = await runListCommand(tarballPath);

    expect(report.data?.skills.map((skill) => skill.name)).toStrictEqual(['listed-skill']);
    expect(report.data?.context).toBe('npm');
  });

  it('reports the name the skill declares, which is the name install will use', async () => {
    // `vat skills list <tgz>` is the preview for `vat skills install <tgz>`.
    // Install keys on the frontmatter name, so the preview must too — otherwise
    // it names a directory the install will never create.
    const tarballPath = await buildFakeTarball(
      tempDir,
      'legacy-dir',
      'fake-renamed',
      'modern-name',
    );

    const report = await runListCommand(tarballPath);

    expect(report.data?.skills.map((skill) => skill.name)).toStrictEqual(['modern-name']);
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

    const report = await runListCommand(tarballPath);

    // Zero skills in a package that was scanned is an answer: one root examined, `ok`.
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(1);
    expect(report.data?.skills).toStrictEqual([]);
    expect(report.data?.context).toBe('npm');
  });
});
