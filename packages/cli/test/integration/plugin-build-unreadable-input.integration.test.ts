/**
 * A distribution file the build may not examine refuses the build as its input
 * (`INPUT_UNREADABLE`) — it is never skipped as if it were absent. `existsSync`
 * answered `false` for a README under an `EACCES` directory, and the marketplace
 * shipped without it.
 *
 * The README sits OUTSIDE the project (`publish.readme: ../shared/README.md`), so
 * the project's own crawl never meets the locked directory: the only probe that
 * can is the distribution-file copy under test. Real permissions: the probe is a
 * sync `stat`, and what is under test is that a real refusal reaches the classifier.
 */

import { chmodSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { runClaudePluginBuild } from '../../src/commands/claude/plugin/build.js';
import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';
import { commitTestFixture, silentLogger } from '../test-helpers.js';

// Every tree below lives in a per-test scratch that is also TMPDIR/TEMP/TMP.
const scratch = useScratchTmpdir('plugin-build-unreadable-');

/** Write `content` at `path`, making its parents. */
function writeFixtureFile(path: string, content: string): void {
  mkdirSyncReal(safePath.join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** A one-plugin marketplace whose README comes from `../shared/README.md`; returns both directories. */
function writeFixture(): { root: string; shared: string } {
  const root = safePath.join(scratch(), 'project');
  const shared = safePath.join(scratch(), 'shared');
  writeFixtureFile(safePath.join(root, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  writeFixtureFile(
    safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
    `claude:
  marketplaces:
    mp:
      owner:
        name: Test Org
      publish:
        readme: ../shared/README.md
      plugins:
        - name: p
          description: A plugin with only a manifest
          skills: []
`,
  );
  writeFixtureFile(safePath.join(root, 'plugins', 'p', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  writeFixtureFile(safePath.join(shared, 'README.md'), '# mp\n');
  commitTestFixture(root);
  return { root, shared };
}

// chmod 000 does not restrict access on Windows, and root bypasses permission checks.
describe.skipIf(CANNOT_DENY_READS)('claude plugin build — an unreadable distribution file', () => {
  it('refuses the build as its input instead of shipping the marketplace without the README', async () => {
    const { root, shared } = writeFixture();
    chmodSync(shared, 0o000);
    let thrown: unknown;
    try {
      await runClaudePluginBuild(root, { logger: silentLogger, runOutputs: [] });
    } catch (error) {
      thrown = error;
    } finally {
      chmodSync(shared, 0o700);
    }
    expect(thrown).toMatchObject({ side: 'source', errno: 'EACCES', path: safePath.join(shared, 'README.md') });
    expect(refusalCodeOf(thrown)).toBe('INPUT_UNREADABLE');
  });

  // The positive control on the same fixture: readable, the build ships it.
  it('builds the same fixture when the README can be read', async () => {
    const { root } = writeFixture();
    const results = await runClaudePluginBuild(root, { logger: silentLogger, runOutputs: [] });
    expect(results.map((result) => result.plugins.map((plugin) => plugin.pluginName))).toEqual([['p']]);
  });
});
