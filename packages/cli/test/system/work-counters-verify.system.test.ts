/**
 * `vat verify` reads each file once per run: a plugin-local SKILL.md, which the
 * run's skill discovery and the plugin-local name lookup both parse, is read
 * exactly once at the `node:fs` boundary.
 *
 * The companion of `work-counters-validate.system.test.ts` for `vat verify`,
 * whose in-process phases share one run (rule 4 of "Decision: content identity
 * is per source", docs/architecture/content-keying-and-git.md). The fixture is
 * built first, without the probe, so the counts are `vat verify`'s alone.
 */

import { VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probedReads, readProbeEnv } from '../helpers/fs-read-probe.js';
import { commitTestFixture } from '../test-helpers.js';

import { createSkillMarkdown, createSuiteContext, executeCli, join, writeFileTree } from './test-common.js';

const context = createSuiteContext('vat-work-verify-', import.meta.url);

const PLUGIN_SKILL = 'plugins/one-plugin/skills/one-skill/SKILL.md';

const FILES: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': `skills:
  include:
    - "plugins/one-plugin/skills/**/SKILL.md"
claude:
  marketplaces:
    one-market:
      owner:
        name: Test Org
      plugins:
        - name: one-plugin
          description: A plugin whose one skill is plugin-local
          skills: "*"
`,
  'package.json': JSON.stringify({ name: 'one-corpus', version: '1.0.0' }),
  'README.md': '# Corpus\n',
  [PLUGIN_SKILL]: `${createSkillMarkdown('one-skill')}\nSee [the readme](../../../../README.md).\n`,
};

describe('vat verify reads a plugin-local SKILL.md once per run', () => {
  let root: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    context.setup();
    root = join(context.createTempDir(), 'corpus');
    writeFileTree(root, FILES);
    commitTestFixture(root);
    const tmp = context.createTempDir();
    env = { [VAT_CACHE_DIR_ENV]: context.createTempDir(), TMPDIR: tmp, TEMP: tmp, TMP: tmp };
    const build = await executeCli(context.binPath, ['build'], { cwd: root, env });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    // Marketplace validation requires a LICENSE in the built marketplace root.
    writeFileTree(join(root, 'dist/.claude/plugins/marketplaces/one-market'), { LICENSE: 'MIT License - Test' });
  });

  afterAll(() => context.cleanup());

  it('reads the plugin-local SKILL.md exactly once', async () => {
    const probeDir = context.createTempDir();
    const result = await executeCli(context.binPath, ['verify'], { cwd: root, env: { ...env, ...readProbeEnv(probeDir, root) } });

    // Positive controls: verify finished its job, and the probe ran.
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const { reads, dumps } = probedReads(probeDir);
    expect(dumps).toBeGreaterThan(0);

    expect(reads.get(PLUGIN_SKILL), 'plugin-local SKILL.md read exactly once').toBe(1);
  });
});
