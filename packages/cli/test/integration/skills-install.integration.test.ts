import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import { ExitCode, type RefusalCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, installFaultFs } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { SKILLS_INSTALL_REPORT_SCHEMA, type SkillsInstallReport } from '../../src/commands/skills/install-schema.js';
import { installCommand, type InstallCommandOptions } from '../../src/commands/skills/install.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';
import { captureCommand } from '../helpers/stdout-capture.js';
import { tarballOf } from '../helpers/tarball.js';

/** Run the install lane: the report it published (validated against its registry schema) and the code it ended on. */
async function runInstall(
  source: string,
  options: InstallCommandOptions,
): Promise<{ report: SkillsInstallReport; exited: number | undefined; stdout: string; stderr: string }> {
  const captured = await captureCommand(() => installCommand(source, options));
  return { ...captured, report: SKILLS_INSTALL_REPORT_SCHEMA.parse(yaml.parse(captured.stdout)) };
}

/** A completed install at exit 0. */
async function install(source: string, options: InstallCommandOptions): Promise<SkillsInstallReport> {
  const { report, exited, stderr } = await runInstall(source, options);
  expect(exited, stderr).toBe(ExitCode.OK);
  expect(report.status).toBe('ok');
  return report;
}

/** A refusal: exit 2, the refusal code, and a message matching `message`. */
async function expectRefusal(source: string, options: InstallCommandOptions, code: RefusalCode, message: RegExp): Promise<void> {
  const { report, exited } = await runInstall(source, options);
  expect(exited).toBe(ExitCode.ERROR);
  expect(report.error?.code).toBe(code);
  expect(report.error?.message).toMatch(message);
}

/**
 * Create a skill directory whose leaf name and frontmatter `name` differ.
 * The two are separate questions; every other fixture here makes them equal,
 * which is exactly what hid the identity defect this suite now covers.
 */
function createSkillDirNamed(
  parent: string,
  dirName: string,
  declaredName: string,
  description: string,
): string {
  const dir = safePath.join(parent, dirName);
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${declaredName}\ndescription: ${description}\n---\n\n# ${declaredName}\n\nTest skill body.\n`,
    'utf-8',
  );
  return dir;
}

function createSkillDir(parent: string, name: string, description: string): string {
  return createSkillDirNamed(parent, name, name, description);
}

/**
 * Create a two-skill dist/skills/ directory in tempDir with the given subdirName.
 * Returns { distSkills, projectDir }.
 */
function createMultiSkillProject(
  tempDir: string,
  subdirName: string,
): { distSkills: string; projectDir: string } {
  const distSkills = safePath.join(tempDir, subdirName);
  mkdirSyncReal(distSkills, { recursive: true });
  createSkillDir(distSkills, 'skill-one', 'First.');
  createSkillDir(distSkills, 'skill-two', 'Second.');

  const projectDir = safePath.join(tempDir, 'project');
  mkdirSyncReal(projectDir, { recursive: true });

  return { distSkills, projectDir };
}

/**
 * Install a skill once so subsequent tests can assert duplicate/overwrite behaviour.
 * Returns { skillSrc, projectDir }.
 */
async function setupInstalledSkill(
  tempDir: string,
): Promise<{ skillSrc: string; projectDir: string }> {
  const skillSrc = createSkillDir(tempDir, 'dup-skill', 'First.');
  const projectDir = safePath.join(tempDir, 'project');
  mkdirSyncReal(projectDir, { recursive: true });
  await install(skillSrc, { target: 'claude', scope: 'project', cwd: projectDir });
  return { skillSrc, projectDir };
}

describe('vat skills install — local directory source', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-skills-install-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('installs a single skill from a local directory to the project scope', async () => {
    const skillSrc = createSkillDir(tempDir, 'hello-skill', 'Says hello to the user.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await install(skillSrc, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
    });

    const installedSkillMd = safePath.join(projectDir, '.claude/skills/hello-skill/SKILL.md');
    expect(existsSync(installedSkillMd)).toBe(true);
    const content = await readFile(installedSkillMd, 'utf-8');
    expect(content).toContain('name: hello-skill');
  });

  it('publishes a skill that fails pre-verification as its error findings, exit 1, nothing installed', async () => {
    const skillSrc = safePath.join(tempDir, 'broken-skill');
    mkdirSyncReal(skillSrc, { recursive: true });
    writeFileSync(safePath.join(skillSrc, 'SKILL.md'), '# broken\n\nNo frontmatter.\n', 'utf-8');

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    const { report, exited } = await runInstall(skillSrc, { target: 'claude', scope: 'project', cwd: projectDir });

    expect(exited).toBe(ExitCode.FINDINGS);
    expect(report.status).toBe('findings');
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(report.data?.skills).toStrictEqual([]);

    expect(existsSync(safePath.join(projectDir, '.claude/skills/broken-skill'))).toBe(false);
  });

  it('refuses to overwrite an existing skill without --force', async () => {
    const { skillSrc, projectDir } = await setupInstalledSkill(tempDir);

    await expectRefusal(skillSrc, { target: 'claude', scope: 'project', cwd: projectDir }, 'USAGE_INVALID', /already holds something.*Use --force to overwrite/s);
  });

  it('overwrites with --force', async () => {
    const { skillSrc, projectDir } = await setupInstalledSkill(tempDir);

    writeFileSync(
      safePath.join(skillSrc, 'SKILL.md'),
      `---\nname: dup-skill\ndescription: Second.\n---\n\n# dup-skill\n\nUpdated.\n`,
      'utf-8',
    );

    await install(skillSrc, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
      force: true,
    });

    const content = await readFile(
      safePath.join(projectDir, '.claude/skills/dup-skill/SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('Updated');
  });

  it('dry-run writes nothing to the filesystem', async () => {
    const skillSrc = createSkillDir(tempDir, 'preview-skill', 'Preview.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await install(skillSrc, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
      dryRun: true,
    });

    expect(existsSync(safePath.join(projectDir, '.claude/skills/preview-skill'))).toBe(false);
  });

  it('install --dry-run publishes dryRun: true', async () => {
    const { skillSrc, projectDir } = await setupInstalledSkill(tempDir);

    const report = await install(skillSrc, { target: 'claude', scope: 'project', cwd: projectDir, dryRun: true, force: true });

    expect(report.examined).toBe(1);
    expect(report.data).toMatchObject({ dryRun: true, target: 'claude', scope: 'project' });
    // The plan says the skill is already there: --force replaces it.
    expect(report.data?.skills).toStrictEqual([
      { name: 'dup-skill', installPath: expect.stringMatching(/\.claude\/skills\/dup-skill$/), alreadyInstalled: true },
    ]);
  });

  it('installs from a local ZIP file', async () => {
    const skillSrc = createSkillDir(tempDir, 'zipped-skill', 'From a zip.');
    const zipPath = safePath.join(tempDir, 'zipped-skill.zip');

    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addLocalFolder(skillSrc, 'zipped-skill');
    zip.writeZip(zipPath);

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await install(zipPath, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
    });

    expect(existsSync(safePath.join(projectDir, '.claude/skills/zipped-skill/SKILL.md'))).toBe(true);
  });

  it('installs from an npm tarball (simulating npm: source)', async () => {
    // Build a synthetic npm package layout: package/dist/skills/my-skill/SKILL.md
    const pkgDir = safePath.join(tempDir, 'fake-npm-pkg', 'package');
    mkdirSyncReal(safePath.join(pkgDir, 'dist', 'skills'), { recursive: true });
    createSkillDir(safePath.join(pkgDir, 'dist', 'skills'), 'npm-skill', 'From npm.');
    writeFileSync(
      safePath.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'fake-pkg', version: '1.0.0' }),
      'utf-8',
    );

    const tarModule = await import('tar');
    const tarballPath = safePath.join(tempDir, 'fake-pkg-1.0.0.tgz');
    await tarModule.create(
      { file: tarballPath, cwd: safePath.join(tempDir, 'fake-npm-pkg'), gzip: true },
      ['package'],
    );

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await install(tarballPath, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
    });

    expect(existsSync(safePath.join(projectDir, '.claude/skills/npm-skill/SKILL.md'))).toBe(true);
  });

  it('paths returned in output use forward slashes', async () => {
    const skillSrc = createSkillDir(tempDir, 'slash-skill', 'Forward slashes only.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    const { stdout: output } = await runInstall(skillSrc, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
    });
    const backslashMatches = output.match(/\\/g);
    expect(backslashMatches).toBeNull();
    expect(output).toContain('slash-skill');
  });

  it('discovers multiple skills from a dist/skills/ directory', async () => {
    const { distSkills, projectDir } = createMultiSkillProject(tempDir, 'multi-src');

    await install(distSkills, {
      target: 'claude',
      scope: 'project',
      cwd: projectDir,
    });

    expect(existsSync(safePath.join(projectDir, '.claude/skills/skill-one/SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(projectDir, '.claude/skills/skill-two/SKILL.md'))).toBe(true);
  });

  it('all-or-nothing: one broken skill in a batch blocks all installs', async () => {
    const distSkills = safePath.join(tempDir, 'mixed-src');
    mkdirSyncReal(distSkills, { recursive: true });
    createSkillDir(distSkills, 'good-skill', 'Good.');
    // broken-skill has SKILL.md with no frontmatter
    const brokenDir = safePath.join(distSkills, 'broken-skill');
    mkdirSyncReal(brokenDir, { recursive: true });
    writeFileSync(safePath.join(brokenDir, 'SKILL.md'), '# broken\n', 'utf-8');

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    const { report, exited } = await runInstall(distSkills, { target: 'claude', scope: 'project', cwd: projectDir });
    expect(exited).toBe(ExitCode.FINDINGS);
    expect(report.examined).toBe(2);

    // Neither skill should be installed
    expect(existsSync(safePath.join(projectDir, '.claude/skills/good-skill'))).toBe(false);
    expect(existsSync(safePath.join(projectDir, '.claude/skills/broken-skill'))).toBe(false);
  });

  it('rejects --name when multiple skills are discovered', async () => {
    const { distSkills, projectDir } = createMultiSkillProject(tempDir, 'multi-name-src');

    await expectRefusal(
      distSkills,
      { target: 'claude', scope: 'project', cwd: projectDir, name: 'renamed' },
      'USAGE_INVALID',
      /--name.*single-skill/,
    );
  });

  it('rejects --name with path traversal characters', async () => {
    const skillSrc = createSkillDir(tempDir, 'traversal-skill', 'Traversal test.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await expectRefusal(
      skillSrc,
      { target: 'claude', scope: 'project', cwd: projectDir, name: '../../etc' },
      'USAGE_INVALID',
      /Invalid skill name "\.\.\/\.\.\/etc" \(--name\)/,
    );
  });

  it('rejects --name containing forward slash', async () => {
    const skillSrc = createSkillDir(tempDir, 'slash-name-skill', 'Slash test.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await expectRefusal(
      skillSrc,
      { target: 'claude', scope: 'project', cwd: projectDir, name: 'foo/bar' },
      'USAGE_INVALID',
      /Invalid skill name "foo\/bar" \(--name\)/,
    );
  });
});

/** A fresh temp root holding an empty `project/` for each test of the suite, removed after it. */
function useProjectFixture(prefix: string): () => { tempDir: string; projectDir: string } {
  let dirs = { tempDir: '', projectDir: '' };
  beforeEach(async () => {
    const tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), prefix));
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });
    dirs = { tempDir, projectDir };
  });
  afterEach(async () => {
    await rm(dirs.tempDir, { recursive: true, force: true });
  });
  return () => dirs;
}

/**
 * The refusals coded where they are raised, each observed in the published
 * document: an archive the reader refuses is the input's (`INPUT_UNREADABLE`),
 * an archive that is not a skill package is the invocation's (`USAGE_INVALID`),
 * and a source file the copy could not read is the input's, found before anything is copied.
 */
describe('vat skills install — refusals coded at their cause', () => {
  let tempDir: string;
  let projectDir: string;
  const at = (): InstallCommandOptions => ({ target: 'claude', scope: 'project', cwd: projectDir });

  const fixture = useProjectFixture('vat-skills-install-refusal-');
  beforeEach(() => {
    ({ tempDir, projectDir } = fixture());
  });

  // The skill a ZIP holds is extracted into VAT's own staging: a fault reading it there is the run's
  // scratch failing, whatever the boundary can or cannot prove about where the skill sits. Here the
  // staging root itself cannot be resolved (so no containment check can place the skill under any root)
  // and the validator's walk is refused inside it.
  it('refuses a fault in the ZIP staging as RUN_INCOMPLETE even when the skill is under no provable root', async () => {
    const skill = createSkillDir(tempDir, 'zs', 'From a zip.');
    mkdirSyncReal(safePath.join(skill, 'references'), { recursive: true });
    writeFileSync(safePath.join(skill, 'references', 'a.md'), 'a');
    const zipPath = safePath.join(tempDir, 'zs.zip');
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addLocalFolder(skill, 'zs');
    zip.writeZip(zipPath);

    const session = installFaultFs({
      within: normalizedTmpdir(),
      faults: [
        { family: 'meta', op: 'realpath', path: (p) => /\/vat-skills-install-zip-[^/]+$/.test(p), errno: 'EACCES' },
        { family: 'meta', op: 'realpath', path: (p) => /\/vat-skills-install-zip-[^/]+\/zs\/references$/.test(p), errno: 'EACCES' },
      ],
    });
    let outcome: Awaited<ReturnType<typeof runInstall>>;
    try {
      outcome = await runInstall(zipPath, at());
    } finally {
      session.restore();
    }
    expect(outcome.exited).toBe(ExitCode.ERROR);
    expect(outcome.report.error?.code).toBe('RUN_INCOMPLETE');
  });

  it('refuses a ZIP the reader cannot read as INPUT_UNREADABLE', async () => {
    const zipPath = safePath.join(tempDir, 'corrupt.zip');
    writeFileSync(zipPath, 'not a zip archive', 'utf-8');

    await expectRefusal(zipPath, at(), 'INPUT_UNREADABLE', /could not be extracted/);
  });

  it('refuses a tarball the reader cannot read as INPUT_UNREADABLE', async () => {
    const tarballPath = safePath.join(tempDir, 'corrupt.tgz');
    writeFileSync(tarballPath, 'not a gzip stream', 'utf-8');

    await expectRefusal(tarballPath, at(), 'INPUT_UNREADABLE', /could not be extracted/);
  });

  // node-tar reports an entry it cannot write as a WARNING and resolves: the package
  // installed without that entry. A file `a` beside a file `a/b` is the archive's.
  it('refuses a tarball holding an entry that cannot be extracted as INPUT_UNREADABLE', async () => {
    const tarballPath = safePath.join(tempDir, 'clash.tgz');
    writeFileSync(tarballPath, tarballOf([
      ['package/package.json', JSON.stringify({ name: '@test/clash', version: '1.0.0' })],
      ['package/dist/skills/clash/SKILL.md', '---\nname: clash\ndescription: Says hello to the user.\n---\n\n# clash\n'],
      ['package/a', 'A'],
      ['package/a/b', 'B'],
    ]));

    await expectRefusal(tarballPath, at(), 'INPUT_UNREADABLE', /Could not extract /);
    expect(existsSync(safePath.join(projectDir, '.claude', 'skills', 'clash'))).toBe(false);
  });

  it('refuses a tarball with no package/ directory as USAGE_INVALID', async () => {
    const staging = safePath.join(tempDir, 'staging');
    createSkillDir(staging, 'loose-skill', 'Not packed by npm.');
    const tarballPath = safePath.join(tempDir, 'loose.tgz');
    const tarModule = await import('tar');
    await tarModule.create({ file: tarballPath, cwd: staging, gzip: true }, ['loose-skill']);

    await expectRefusal(tarballPath, at(), 'USAGE_INVALID', /does not contain a package\/ directory/);
  });

  // A file the copy could not read is found by the plan's readable-source proof, before anything is copied:
  // the batch installs nothing, and the refusal keeps the validation the run finished.
  it.skipIf(CANNOT_DENY_READS)('a source file the OS will not read refuses the whole batch as INPUT_UNREADABLE naming it, nothing installed', async () => {
    const source = safePath.join(tempDir, 'batch');
    // "This skill…" opens the description with meta-filler: a warning, not an error.
    createSkillDir(source, 'a-first', 'This skill says hello to the user.');
    const second = createSkillDir(source, 'b-second', 'Says goodbye to the user.');
    const unreadable = safePath.join(second, 'data.txt');
    writeFileSync(unreadable, 'secret', 'utf-8');
    chmodSync(unreadable, 0o000);
    try {
      const { report, exited } = await runInstall(source, at());

      expect(exited).toBe(ExitCode.ERROR);
      expect(report.error?.code).toBe('INPUT_UNREADABLE');
      expect(report.error?.message).toContain(unreadable);
      expect(report.examined).toBe(2);
      expect(report.data).toBeNull();
      expect(report.findings.map((finding) => finding.code)).toContain('SKILL_DESCRIPTION_FILLER_OPENER');
      expect(existsSync(safePath.join(projectDir, '.claude', 'skills', 'a-first'))).toBe(false);
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });
});

/**
 * Install-time identity: the frontmatter `name` is what the skill calls itself,
 * and VAT treats it as authoritative everywhere else (see
 * SKILL_CLAUDE_PLUGIN_NAME_MISMATCH's fix text). The directory leaf is an
 * incidental property of wherever the bytes happen to be sitting — and for an
 * archive source it is a random temp path.
 */
describe('vat skills install — installed name comes from the skill, not the path', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-skills-install-id-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('uses the declared name when the source directory leaf disagrees', async () => {
    const skillSrc = createSkillDirNamed(tempDir, 'checkout-wd', 'pdf-processor', 'Reads PDFs.');
    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await install(skillSrc, { target: 'claude', scope: 'project', cwd: projectDir });

    expect(existsSync(safePath.join(projectDir, '.claude/skills/pdf-processor/SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(safePath.join(projectDir, '.claude/skills/checkout-wd'))).toBe(false);
  });

  it('installs a ZIP whose SKILL.md sits at the archive root under its declared name', async () => {
    // No top-level directory inside the ZIP, so the only "directory name"
    // available at install time is the extraction temp dir.
    const skillSrc = createSkillDirNamed(tempDir, 'staging', 'root-zip-skill', 'From a flat zip.');
    const zipPath = safePath.join(tempDir, 'flat.zip');

    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addLocalFolder(skillSrc);
    zip.writeZip(zipPath);

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await install(zipPath, { target: 'claude', scope: 'project', cwd: projectDir });

    const installedDirs = readdirSync(safePath.join(projectDir, '.claude/skills'));
    expect(installedDirs).toEqual(['root-zip-skill']);
  });

  it('refuses a batch in which two skills claim the same name', async () => {
    const distSkills = safePath.join(tempDir, 'collide-src');
    mkdirSyncReal(distSkills, { recursive: true });
    createSkillDirNamed(distSkills, 'first', 'shared-name', 'One.');
    createSkillDirNamed(distSkills, 'second', 'shared-name', 'Two.');

    const projectDir = safePath.join(tempDir, 'project');
    mkdirSyncReal(projectDir, { recursive: true });

    await expectRefusal(distSkills, { target: 'claude', scope: 'project', cwd: projectDir }, 'USAGE_INVALID', /shared-name/);

    expect(existsSync(safePath.join(projectDir, '.claude/skills/shared-name'))).toBe(false);
  });
});

/** Run the install with the first write naming `name` under `.claude/skills` refused ENOSPC (faults scoped to `within`). */
async function installWithFullDiskFor(within: string, name: string, source: string, options: InstallCommandOptions): Promise<Awaited<ReturnType<typeof runInstall>>> {
  const session = installFaultFs({
    within,
    faults: [{ family: 'write', path: (p) => p.includes('/.claude/skills/') && p.includes(name), errno: 'ENOSPC' }],
  });
  try {
    return await runInstall(source, options);
  } finally {
    session.restore();
  }
}

/**
 * One plan for the whole batch: every skill is staged beside its destination and swapped in
 * together, or nothing changes. A refusal therefore installed nothing, and says so (`data: null`).
 */
describe('vat skills install — one transaction for the batch', () => {
  let tempDir: string;
  let projectDir: string;
  const at = (extra: Partial<InstallCommandOptions> = {}): InstallCommandOptions => ({ target: 'claude', scope: 'project', cwd: projectDir, ...extra });
  const installed = (name: string): string => safePath.join(projectDir, '.claude', 'skills', name);

  const fixture = useProjectFixture('vat-skills-install-tx-');
  beforeEach(() => {
    ({ tempDir, projectDir } = fixture());
  });

  // Registered after `tempDir` is made, so the scratch temp directory is beside the fixture, never around it.
  const scratchTmpdir = useScratchTmpdir('vat-skills-install-tx-tmp-');

  it('a copy that fails on the second skill installs neither, and the refusal claims nothing installed', async () => {
    const { distSkills } = createMultiSkillProject(tempDir, 'batch-src');

    const { report, exited } = await installWithFullDiskFor(tempDir, 'skill-two', distSkills, at());

    expect(exited).toBe(ExitCode.ERROR);
    expect(report.error?.code).toBe('RUN_INCOMPLETE');
    expect(report.data).toBeNull();
    expect(existsSync(installed('skill-one'))).toBe(false);
    expect(existsSync(installed('skill-two'))).toBe(false);
  });

  it('a --force install whose copy fails leaves the previous install byte-intact', async () => {
    const { skillSrc } = await setupInstalledSkill(tempDir);
    const before = await readFile(safePath.join(installed('dup-skill'), 'SKILL.md'), 'utf-8');

    const { report, exited } = await installWithFullDiskFor(tempDir, 'dup-skill', skillSrc, at({ force: true }));

    expect(exited).toBe(ExitCode.ERROR);
    expect(report.error?.code).toBe('RUN_INCOMPLETE');
    await expect(readFile(safePath.join(installed('dup-skill'), 'SKILL.md'), 'utf-8')).resolves.toBe(before);
  });

  // A `vat skills build` killed mid-swap leaves its staged tree beside the bundle, SKILL.md and all.
  it('a staged tree a build left in a dist/skills source is no skill: only the bundles install', async () => {
    const { distSkills } = createMultiSkillProject(tempDir, 'with-residue');
    createSkillDirNamed(distSkills, '.skill-one.vat-staged-abcd1234', 'skill-one', 'Half-built.');

    const report = await install(distSkills, at());

    expect(report.examined).toBe(2);
    expect(report.data?.skills.map((skill) => skill.name)).toEqual(['skill-one', 'skill-two']);
  });

  it('a --dry-run refuses an occupied destination exactly as the real run does', async () => {
    const { skillSrc } = await setupInstalledSkill(tempDir);

    await expectRefusal(skillSrc, at({ dryRun: true }), 'USAGE_INVALID', /already holds something.*--force/s);
  });

  it('a --dry-run prints the plan, line for line', async () => {
    const { skillSrc } = await setupInstalledSkill(tempDir);

    const { stderr, exited } = await runInstall(skillSrc, at({ dryRun: true, force: true }));

    expect(exited).toBe(ExitCode.OK);
    expect(stderr).toContain(`[dry-run] replace skill dup-skill ${installed('dup-skill')}`);
  });

  it('a ZIP staging directory that will not go once the install is done is a warning naming it, exit 0', async () => {
    // The staging lives under $TMPDIR, this test's scratch: the refused removal is of nothing real.
    const scratchTmp = scratchTmpdir();
    const zipPath = safePath.join(tempDir, 'zs.zip');
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addLocalFolder(createSkillDir(tempDir, 'zs', 'From a zip.'), 'zs');
    zip.writeZip(zipPath);

    const session = installFaultFs({
      within: scratchTmp,
      faults: [{ family: 'remove', path: (p) => /\/vat-skills-install-zip-[^/]+$/.test(p), errno: 'EBUSY' }],
    });
    let outcome: Awaited<ReturnType<typeof runInstall>>;
    try {
      outcome = await runInstall(zipPath, at());
    } finally {
      session.restore();
    }

    expect(outcome.exited, outcome.stderr).toBe(ExitCode.OK);
    expect(existsSync(safePath.join(installed('zs'), 'SKILL.md'))).toBe(true);
    const left = readdirSync(scratchTmp).filter((name) => name.startsWith('vat-skills-install-zip-'));
    expect(left).toHaveLength(1);
    expect(outcome.report.findings).toContainEqual(expect.objectContaining({
      code: 'TREE_CLEANUP_INCOMPLETE',
      severity: 'warning',
      link: safePath.join(scratchTmp, left[0] ?? ''),
    }));
  });
});
