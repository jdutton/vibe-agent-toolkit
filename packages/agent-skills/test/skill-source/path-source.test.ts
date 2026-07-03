/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePathSource } from '../../src/skill-source/sources/path-source.js';

import { setupSkillSourceTestSuite } from './test-helpers.js';

const suite = setupSkillSourceTestSuite('vat-path-');

describe('resolvePathSource', () => {
  const skillMdFilename = 'SKILL.md';
  const localPluginPath = './local-plugin';
  let local: string;

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  beforeEach(() => {
    local = safePath.join(suite.root, 'local-plugin');
    mkdirSyncReal(local);
    writeFileSync(safePath.join(local, skillMdFilename), '# local');
  });

  it('stages a relative local dir and returns a content-hash identity', async () => {
    const result = await resolvePathSource(localPluginPath, suite.ctx);
    expect(statSync(safePath.join(result.stagedDir, skillMdFilename)).isFile()).toBe(true);
    expect(result.identity).toMatch(/^path:[0-9a-f]{64}$/);
  });

  it('identity changes when the source content changes', async () => {
    const before = await resolvePathSource(localPluginPath, suite.ctx);
    writeFileSync(safePath.join(local, skillMdFilename), '# local v2');
    const after = await resolvePathSource(localPluginPath, suite.ctx);
    expect(before.identity).not.toBe(after.identity);
  });
});
