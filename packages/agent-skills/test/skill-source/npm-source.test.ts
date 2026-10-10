import { statSync, writeFileSync } from 'node:fs';

import { ASSET_REFERENCE_UNRESOLVED_CODE, mkdirSyncReal, normalizePath, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  locateNpmSource,
  resolveNpmSource,
  SKILL_SOURCE_SPEC_INVALID_CODE,
  splitNpmSpecVersion,
} from '../../src/skill-source/sources/npm-source.js';

import { setupSkillSourceTestSuite } from './test-helpers.js';

describe('splitNpmSpecVersion', () => {
  it('splits a scoped pinned specifier into name + version', () => {
    expect(splitNpmSpecVersion('@scope/pkg@1.2.3')).toEqual({ name: '@scope/pkg', version: '1.2.3' });
  });
  it('splits an unscoped pinned specifier', () => {
    expect(splitNpmSpecVersion('pkg@2.0.0')).toEqual({ name: 'pkg', version: '2.0.0' });
  });
  it('throws a coded error when the version pin is missing', () => {
    expect(() => splitNpmSpecVersion('@scope/pkg')).toThrow(
      expect.objectContaining({ code: SKILL_SOURCE_SPEC_INVALID_CODE, message: expect.stringMatching(/version-pinned/i) as unknown }),
    );
  });
});

const suite = setupSkillSourceTestSuite('vat-npm-');

/** Install `@scope/<name>` (version 2.0.0) under the suite root with `manifest` merged into its package.json; its directory. */
function plantPackage(name: string, manifest: Record<string, unknown>): string {
  const pkgDir = safePath.join(suite.root, 'node_modules', '@scope', name);
  mkdirSyncReal(pkgDir, { recursive: true });
  writeFileSync(safePath.join(pkgDir, 'package.json'), JSON.stringify({ name: `@scope/${name}`, version: '2.0.0', ...manifest }));
  return pkgDir;
}

describe('resolveNpmSource', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  beforeEach(() => {
    // Build a fake installed package under root/node_modules so resolveAssetReference resolves it.
    // (suite.beforeEach already wrote package.json to root)
    const pkgDir = safePath.join(suite.root, 'node_modules', '@scope', 'some-skill');
    mkdirSyncReal(pkgDir, { recursive: true });
    writeFileSync(
      safePath.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@scope/some-skill', version: '1.2.3', exports: { './dir': './dir/SKILL.md' } }),
    );
    mkdirSyncReal(safePath.join(pkgDir, 'dir'));
    writeFileSync(safePath.join(pkgDir, 'dir', 'SKILL.md'), '# npm skill');
  });

  it('stages the resolved npm dir and records version + staged-tree hash in identity', async () => {
    const result = await resolveNpmSource('@scope/some-skill@1.2.3/dir', suite.ctx);
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
    expect(result.identity).toMatch(/^npm:@scope\/some-skill@1\.2\.3:[0-9a-f]{64}$/);
  });

  it('stages the package directory itself when the spec names no subpath', async () => {
    const plainDir = plantPackage('plain-skill', {});
    writeFileSync(safePath.join(plainDir, 'SKILL.md'), '# plain npm skill');
    const result = await resolveNpmSource('@scope/plain-skill@2.0.0', suite.ctx);
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
  });

  // `@scope/some-skill`'s `exports` map does not expose `./package.json`: the
  // package is found on disk, never through a resolution the map can refuse.
  it('stages a package whose exports map hides its package.json', async () => {
    const result = await resolveNpmSource('@scope/some-skill@1.2.3', suite.ctx);
    expect(statSync(safePath.join(result.stagedDir, 'dir', 'SKILL.md')).isFile()).toBe(true);
  });

  it.each([
    ['with no exports map', {}],
    ['whose exports pattern names the directory', { exports: { './skills/*': './skills/*' } }],
  ])('stages a subpath naming a directory, in a package %s', async (_label, manifest) => {
    const pkgDir = plantPackage('dir-skill', manifest);
    mkdirSyncReal(safePath.join(pkgDir, 'skills', 'x'), { recursive: true });
    writeFileSync(safePath.join(pkgDir, 'skills', 'x', 'SKILL.md'), '# x');
    expect(toForwardSlash(locateNpmSource('@scope/dir-skill@2.0.0/skills/x', suite.root))).toBe(
      toForwardSlash(safePath.join(pkgDir, 'skills', 'x')),
    );
    const result = await resolveNpmSource('@scope/dir-skill@2.0.0/skills/x', suite.ctx);
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
  });

  it('still follows an exports alias to a file kept elsewhere in the package', () => {
    const pkgDir = plantPackage('alias-skill', { exports: { './skill': './dist/real/SKILL.md' } });
    mkdirSyncReal(safePath.join(pkgDir, 'dist', 'real'), { recursive: true });
    writeFileSync(safePath.join(pkgDir, 'dist', 'real', 'SKILL.md'), '# real');
    expect(toForwardSlash(locateNpmSource('@scope/alias-skill@2.0.0/skill', suite.root))).toBe(
      toForwardSlash(normalizePath(safePath.join(pkgDir, 'dist', 'real', 'SKILL.md'))),
    );
  });

  it('refuses a subpath that climbs out of the package as SKILL_SOURCE_SPEC_INVALID', () => {
    plantPackage('climb-skill', {});
    expect(() => locateNpmSource('@scope/climb-skill@2.0.0/../some-skill', suite.root)).toThrow(
      expect.objectContaining({ code: SKILL_SOURCE_SPEC_INVALID_CODE }),
    );
  });

  it.each([
    ['a scoped package that is not installed', '@scope/absent@1.0.0/dir'],
    ['a scoped package named with no subpath', '@scope/absent@1.0.0'],
    ['an unscoped package that is not installed', 'absent-pkg@1.0.0/dir'],
  ])('refuses %s as ASSET_REFERENCE_UNRESOLVED, naming it', async (_label, spec) => {
    await expect(resolveNpmSource(spec, suite.ctx)).rejects.toMatchObject({
      code: ASSET_REFERENCE_UNRESOLVED_CODE,
      message: expect.stringContaining('absent') as unknown,
    });
  });
});
