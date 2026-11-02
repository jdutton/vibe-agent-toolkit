/**
 * Post-build validation sees the output it validates, for EVERY skill of a run.
 *
 * The project crawl is memoized on the root, so the crawl made for the first
 * skill's post-build check is served to every later one. A build writing its
 * output INSIDE the root and outside `dist/` (`<root>/out/<skill>`) — where a
 * crawl of the root does admit it — therefore validated the second skill's built
 * SKILL.md against a registry crawled before that skill was written: the
 * registry did not hold it, the walk started from nothing, and a defect in a
 * bundled file passed silently. Measured: the FIRST skill failed too — the check
 * validates the bundle at its staged name (`.<name>.vat-staged-*`), which the
 * crawl excludes as residue — so both skills are the subject, not one the control.
 *
 * The defect is one only the walk can see: a non-portable command in the bundled
 * reference (`NON_PORTABLE_COMMAND`), which the scans of `bundledFiles` report.
 * Run twice: plainly, and in a git repository that ignores `out/` — the bundle is
 * the build's own output, so no ignore rule may hide it from the check.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SkillPackageChecksFailedError } from '../../src/packaging-errors.js';
import { packageSkill, type PackageSkillResult } from '../../src/skill-packager.js';
import { resetPackagingRegistryCache } from '../../src/validators/packaging-validator.js';

const SKILLS = ['first-skill', 'second-skill'] as const;

/** A skill bundling one reference that runs a non-portable command. */
function writeSkill(root: string, name: string): string {
  const dir = safePath.join(root, 'skills', name);
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Use when exercising post-build validation of a bundled reference.\n---\n\n# ${name}\n\nConsult the [reference](reference.md).\n`,
    'utf-8',
  );
  writeFileSync(safePath.join(dir, 'reference.md'), '# Reference\n\nRun `timeout 30 ./setup.sh` first.\n', 'utf-8');
  return safePath.join(dir, 'SKILL.md');
}

/** The package's result, whether it landed or its own checks refused it. */
async function packagedOrRefused(skillPath: string, outputPath: string): Promise<PackageSkillResult> {
  try {
    return await packageSkill(skillPath, { outputPath });
  } catch (error) {
    if (error instanceof SkillPackageChecksFailedError) return error.result;
    throw error;
  }
}

describe.each([
  ['a plain directory', false],
  ['a git repository that ignores out/', true],
])('post-build validation of output inside the root, outside dist/, in %s', (_label, gitIgnoresOut) => {
  let root: string;
  const results = new Map<string, PackageSkillResult>();

  beforeAll(async () => {
    resetPackagingRegistryCache();
    root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-post-build-own-output-')));
    writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), '{}\n', 'utf-8');
    if (gitIgnoresOut) {
      spawnSync(gitExecutable(), ['init', '-q', root], { stdio: 'ignore' });
      writeFileSync(safePath.join(root, '.gitignore'), 'out/\n', 'utf-8');
    }
    const paths = SKILLS.map((name) => writeSkill(root, name));
    // In order, one process, one memo: the second skill is written after the first's check crawled the root.
    for (const [index, name] of SKILLS.entries()) {
      results.set(name, await packagedOrRefused(paths[index] ?? '', safePath.join(root, 'out', name)));
    }
  });

  afterAll(() => {
    resetPackagingRegistryCache();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(SKILLS)('%s: the check walks the built bundle and catches the bundled reference\'s defect', (name) => {
    const validation = results.get(name)?.postBuildValidation;

    expect(validation?.metadata.fileCount).toBe(2);
    expect(validation?.allErrors.map((issue) => issue.code)).not.toContain('LINK_TO_GITIGNORED_FILE');
    expect(validation?.allErrors.filter((issue) => issue.code === 'NON_PORTABLE_COMMAND').map((issue) => issue.location)).toEqual([
      expect.stringMatching(/reference\.md$/),
    ]);
  });
});
