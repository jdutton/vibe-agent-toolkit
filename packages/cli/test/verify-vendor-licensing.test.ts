import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertVendoredLicensingShipped } from '../src/commands/consistency-check.js';

// The two vendored copies in VAT's own repository, as paths relative to the project root
const SKILL_CREATOR_PACKAGE = 'packages/agent-skills';
const SKILL_CREATOR_DIR = `${SKILL_CREATOR_PACKAGE}/vendor/skill-creator`;
const TYPESCRIPT_PACKAGE = 'packages/resources';
const TYPESCRIPT_DIR = `${TYPESCRIPT_PACKAGE}/src/vendor`;

// Minimal stub content for test fixtures
const STUB_LICENSE = 'Apache License 2.0\n';
const STUB_ATTRIBUTION = '# Attribution\n';

/** Write a fixture file under the project root, creating its directory. */
function writeFixture(projectRoot: string, relative: string, content: string): void {
  const path = safePath.join(projectRoot, relative);
  mkdirSyncReal(safePath.join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** Declare `files` in the package's `package.json`. */
function writeFilesAllowlist(projectRoot: string, packagePath: string, files: string[]): void {
  writeFixture(projectRoot, `${packagePath}/package.json`, JSON.stringify({ name: 'fixture', files }));
}

/** Seed the skill-creator copy: both licensing artifacts and a `files` array that ships `vendor/`. */
function seedSkillCreator(projectRoot: string, files: string[] = ['dist', 'vendor/', 'README.md']): void {
  writeFixture(projectRoot, `${SKILL_CREATOR_DIR}/LICENSE.txt`, STUB_LICENSE);
  writeFixture(projectRoot, `${SKILL_CREATOR_DIR}/ATTRIBUTION.md`, STUB_ATTRIBUTION);
  writeFilesAllowlist(projectRoot, SKILL_CREATOR_PACKAGE, files);
}

/**
 * Seed the TypeScript copy as a clean checkout holds it: only the committed ATTRIBUTION.md (its
 * LICENSE.txt is written by the package's build and gitignored), and a `files` array that ships `dist`.
 */
function seedTypescript(projectRoot: string, files: string[] = ['dist', 'src', '!src/vendor/typescript.cjs']): void {
  writeFixture(projectRoot, `${TYPESCRIPT_DIR}/ATTRIBUTION.md`, STUB_ATTRIBUTION);
  writeFilesAllowlist(projectRoot, TYPESCRIPT_PACKAGE, files);
}

/** The messages of the issues the check reports for the project. */
function problemsIn(projectRoot: string): string[] {
  return assertVendoredLicensingShipped(projectRoot).map((issue) => issue.message);
}

describe('assertVendoredLicensingShipped', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-vendor-lic-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns no problems when neither vendoring package is present (not VAT\'s repository)', () => {
    expect(problemsIn(projectRoot)).toEqual([]);
  });

  it('returns no problems when both copies carry their licensing and ship it', () => {
    seedSkillCreator(projectRoot);
    seedTypescript(projectRoot);

    expect(problemsIn(projectRoot)).toEqual([]);
  });

  it('returns a problem mentioning LICENSE when skill-creator LICENSE.txt is missing', () => {
    seedSkillCreator(projectRoot);
    rmSync(safePath.join(projectRoot, SKILL_CREATOR_DIR, 'LICENSE.txt'));

    const licenseProblem = problemsIn(projectRoot).find((p) => p.includes(`${SKILL_CREATOR_DIR}/LICENSE.txt`));
    expect(licenseProblem).toBeDefined();
  });

  it('returns a problem mentioning the files allowlist when vendor/ is absent from it', () => {
    seedSkillCreator(projectRoot, ['dist', 'README.md']);

    const allowlistProblem = problemsIn(projectRoot).find((p) => p.includes('"vendor/"') && p.includes('files'));
    expect(allowlistProblem).toBeDefined();
  });

  it('returns a problem naming the TypeScript copy when its ATTRIBUTION.md is missing', () => {
    seedSkillCreator(projectRoot);
    writeFilesAllowlist(projectRoot, TYPESCRIPT_PACKAGE, ['dist']);
    mkdirSyncReal(safePath.join(projectRoot, TYPESCRIPT_DIR), { recursive: true });

    const issues = assertVendoredLicensingShipped(projectRoot);
    expect(issues.map((issue) => issue.message)).toEqual([expect.stringContaining(`${TYPESCRIPT_DIR}/ATTRIBUTION.md is missing`)]);
    expect(issues[0]?.fix).toContain(`${TYPESCRIPT_PACKAGE}/package.json`);
  });

  it('does not require the TypeScript LICENSE.txt in src/vendor, which its build writes', () => {
    seedTypescript(projectRoot);

    expect(problemsIn(projectRoot)).toEqual([]);
  });

  it('returns a problem when the TypeScript package does not ship dist', () => {
    seedTypescript(projectRoot, ['src', 'README.md']);

    const allowlistProblem = problemsIn(projectRoot).find((p) => p.includes('"dist"') && p.includes(`${TYPESCRIPT_PACKAGE}/package.json`));
    expect(allowlistProblem).toBeDefined();
  });
});
