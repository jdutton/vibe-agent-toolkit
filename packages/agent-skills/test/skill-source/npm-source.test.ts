import { statSync, writeFileSync } from 'node:fs';

import { ASSET_REFERENCE_UNRESOLVED_CODE, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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

  // Found through its manifest, so a package whose `exports` map hides the manifest
  // (as `@scope/some-skill` above does) is unlocatable this way; this one has no map.
  it('stages the package directory itself when the spec names no subpath', async () => {
    const plainDir = safePath.join(suite.root, 'node_modules', '@scope', 'plain-skill');
    mkdirSyncReal(plainDir, { recursive: true });
    writeFileSync(safePath.join(plainDir, 'package.json'), JSON.stringify({ name: '@scope/plain-skill', version: '2.0.0' }));
    writeFileSync(safePath.join(plainDir, 'SKILL.md'), '# plain npm skill');
    const result = await resolveNpmSource('@scope/plain-skill@2.0.0', suite.ctx);
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
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
