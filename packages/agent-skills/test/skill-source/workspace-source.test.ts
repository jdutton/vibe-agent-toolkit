/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveWorkspaceSource } from '../../src/skill-source/sources/workspace-source.js';

import { setupSkillSourceTestSuite } from './test-helpers.js';

const suite = setupSkillSourceTestSuite('vat-ws-');

describe('resolveWorkspaceSource', () => {
  let skillDir: string;

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  beforeEach(() => {
    skillDir = safePath.join(suite.root, 'skills', 'bar');
    mkdirSyncReal(skillDir, { recursive: true });
    writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      `---\nname: bar\ndescription: A workspace skill for resolveWorkspaceSource build-graph staging coverage.\n---\n\n# bar\n`,
    );
  });

  it('builds the workspace skill via the build graph and stages the built bundle', async () => {
    const result = await resolveWorkspaceSource('bar', suite.ctx, {
      skillPath: safePath.join(skillDir, 'SKILL.md'),
    });
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
    expect(result.identity).toMatch(/^workspace:bar:[0-9a-f]{64}$/);
  });
});
