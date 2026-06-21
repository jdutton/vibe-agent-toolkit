/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSkillSource } from '../../src/skill-source/resolve-skill-source.js';

import { setupSkillSourceTestSuite } from './test-helpers.js';

const suite = setupSkillSourceTestSuite('vat-dispatch-');

describe('resolveSkillSource dispatch', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('routes a { path } source', async () => {
    const local = safePath.join(suite.root, 'p');
    mkdirSyncReal(local);
    writeFileSync(safePath.join(local, 'SKILL.md'), '# p');
    const result = await resolveSkillSource({ path: './p' }, suite.ctx);
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
    expect(result.identity).toMatch(/^path:/);
  });

  it('routes a { vendored } source', async () => {
    const vend = safePath.join(suite.root, 'v');
    mkdirSyncReal(vend);
    writeFileSync(safePath.join(vend, 'SKILL.md'), '# v');
    const result = await resolveSkillSource({ vendored: true }, { ...suite.ctx, vendoredDir: vend });
    expect(result.identity).toMatch(/^vendored:/);
  });

  it('routes a { workspace } source via the supplied SKILL.md path map', async () => {
    const skillDir = safePath.join(suite.root, 'skills', 'bar');
    mkdirSyncReal(skillDir, { recursive: true });
    writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      `---\nname: bar\ndescription: Dispatch routing coverage skill for resolveSkillSource workspace kind.\n---\n\n# bar\n`,
    );
    const result = await resolveSkillSource({ workspace: 'bar' }, suite.ctx, {
      workspaceSkillPaths: { bar: safePath.join(skillDir, 'SKILL.md') },
    });
    expect(result.identity).toMatch(/^workspace:bar:/);
  });

  it('throws when a { workspace } source has no SKILL.md path mapping', async () => {
    await expect(resolveSkillSource({ workspace: 'missing' }, suite.ctx)).rejects.toThrow(/workspace/i);
  });
});
