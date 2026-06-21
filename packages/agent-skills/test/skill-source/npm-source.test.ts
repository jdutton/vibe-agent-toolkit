/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveNpmSource, splitNpmSpecVersion } from '../../src/skill-source/sources/npm-source.js';

import { setupSkillSourceTestSuite } from './test-helpers.js';

describe('splitNpmSpecVersion', () => {
  it('splits a scoped pinned specifier into name + version', () => {
    expect(splitNpmSpecVersion('@scope/pkg@1.2.3')).toEqual({ name: '@scope/pkg', version: '1.2.3' });
  });
  it('splits an unscoped pinned specifier', () => {
    expect(splitNpmSpecVersion('pkg@2.0.0')).toEqual({ name: 'pkg', version: '2.0.0' });
  });
  it('throws when the version pin is missing', () => {
    expect(() => splitNpmSpecVersion('@scope/pkg')).toThrow(/version-pinned/i);
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
});
