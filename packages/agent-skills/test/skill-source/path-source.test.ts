import { chmodSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SKILL_SOURCE_UNREADABLE_CODE } from '../../src/skill-source/source-unreadable.js';
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

  // An absent source is the same refusal, but its remedy is the path, not permissions.
  it('refuses a source path that does not exist, saying so rather than blaming permissions', async () => {
    await expect(resolvePathSource('./no-such-companion', suite.ctx)).rejects.toMatchObject({
      code: SKILL_SOURCE_UNREADABLE_CODE,
      message: expect.stringMatching(/no-such-companion.*does not exist/) as unknown,
    });
    await expect(resolvePathSource('./no-such-companion', suite.ctx)).rejects.not.toMatchObject({
      message: expect.stringContaining('permissions') as unknown,
    });
  });

  // `vat skill test run --with x=path:<dir>`: a file (or directory) the OS will not read is the
  // operator's input, refused naming it — once a raw EACCES from the content hash, INTERNAL_ERROR.
  it.skipIf(CANNOT_DENY_READS).each([['a file', 'locked.txt'], ['a directory', 'locked-dir']])(
    'refuses a source holding %s the OS will not read, coded as the input, naming it',
    async (_what, name) => {
      const locked = safePath.join(local, name);
      if (name.endsWith('-dir')) mkdirSyncReal(locked);
      else writeFileSync(locked, 'secret');
      chmodSync(locked, 0o000);
      try {
        await expect(resolvePathSource(localPluginPath, suite.ctx)).rejects.toMatchObject({
          code: SKILL_SOURCE_UNREADABLE_CODE,
          reason: 'preflight',
          message: expect.stringContaining(name) as unknown,
        });
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});
