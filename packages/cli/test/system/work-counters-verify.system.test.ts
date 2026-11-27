/**
 * `vat verify` reads each file once per run: a plugin-local SKILL.md, which the
 * run's skill discovery and the plugin-local name lookup both parse, is read
 * exactly once at the `node:fs` boundary with the projection store off. With the
 * store on it is a git member, keyed by its object and served from the store the
 * build filled, so the boundary sees it opened once, for its readability probe (an
 * open and a close, no bytes read), and never read.
 *
 * The companion of `work-counters-validate.system.test.ts` for `vat verify`,
 * whose in-process phases share one run (rule 4 of "Decision: content identity
 * is per source", docs/architecture/content-keying-and-git.md). The fixture is
 * built first, without the probe, so the counts are `vat verify`'s alone.
 */

import { VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_ENV, PROJECTION_STORE_OFF } from '../../src/utils/projection-store.js';
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

/** Run verify in `root` under the read probe, the store on or off; its probed reads. */
async function probedVerify(root: string, env: Readonly<Record<string, string>>, storeOff: boolean): Promise<ReadonlyMap<string, number>> {
  const probeDir = context.createTempDir();
  const storeEnv = storeOff ? { [PROJECTION_STORE_ENV]: PROJECTION_STORE_OFF } : {};
  const result = await executeCli(context.binPath, ['verify'], { cwd: root, env: { ...env, ...storeEnv, ...readProbeEnv(probeDir, root) } });
  // Positive controls: verify finished its job, and the probe ran and saw a read.
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const { reads, dumps } = probedReads(probeDir);
  expect(dumps).toBeGreaterThan(0);
  expect(reads.get('package.json'), 'the consistency phase read package.json').toBeGreaterThan(0);
  return reads;
}

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
    expect((await probedVerify(root, env, true)).get(PLUGIN_SKILL), 'store off: plugin-local SKILL.md read exactly once').toBe(1);
  });

  it('opens the plugin-local SKILL.md only for its readability probe with the store on: a git member is keyed by its object and served', async () => {
    // The one open is the probe's (an open and a close, no bytes read: the fs probe counts a
    // read-only open), which reports an unreadable member as store off would; its bytes come from git.
    expect((await probedVerify(root, env, false)).get(PLUGIN_SKILL)).toBe(1);
  });
});
