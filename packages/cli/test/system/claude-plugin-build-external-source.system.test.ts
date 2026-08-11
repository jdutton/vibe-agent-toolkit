/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
import { existsSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSkillsThenPlugin,
  createSkillMarkdown,
  createTempDirTracker,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const binPath = getBinPath(import.meta.url);
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-ext-');

const MP_DIR = ['dist', '.claude', 'plugins', 'marketplaces', 'mp1'] as const;

/**
 * A marketplace with one locally-built plugin (a single pool skill) and one
 * externalSource plugin referencing another repo. Mirrors the "cherry-pick a
 * plugin from another marketplace" pattern documented in
 * docs/guides/marketplace-distribution.md.
 */
function buildFixture(tempDir: string): void {
  writeTestFile(
    safePath.join(tempDir, 'package.json'),
    JSON.stringify({ name: 't', version: '1.0.0' }),
  );
  writeTestFile(
    safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1
skills:
  include: ["skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test Org
        email: ops@test.example
      plugins:
        - name: local-plugin
          description: Built locally from the pool
          skills: ["skill-a"]
        - name: upstream-plugin
          description: Referenced from another marketplace, never built here
          skills: []
          externalSource:
            source: github
            repo: example-org/upstream-repo
            ref: claude-marketplace
`,
  );
  const skillDir = safePath.join(tempDir, 'skills', 'skill-a');
  mkdirSyncReal(skillDir, { recursive: true });
  writeTestFile(safePath.join(skillDir, 'SKILL.md'), createSkillMarkdown('skill-a'));
}

describe('vat claude plugin build (externalSource)', () => {
  afterEach(() => cleanupTempDirs());

  it('references an external plugin verbatim in marketplace.json without building it locally', async () => {
    const tempDir = createTempDir();
    buildFixture(tempDir);

    const pb = await buildSkillsThenPlugin(binPath, tempDir);

    const mpDir = safePath.join(tempDir, ...MP_DIR);

    // The local plugin was actually built.
    expect(existsSync(safePath.join(mpDir, 'plugins', 'local-plugin', '.claude-plugin', 'plugin.json'))).toBe(true);

    // The external plugin has NO output directory at all — nothing was built or copied.
    expect(existsSync(safePath.join(mpDir, 'plugins', 'upstream-plugin'))).toBe(false);

    const marketplaceJson = JSON.parse(
      readFileSync(safePath.join(mpDir, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    );
    const entries = marketplaceJson.plugins as Array<Record<string, unknown>>;
    const local = entries.find((e) => e['name'] === 'local-plugin');
    const upstream = entries.find((e) => e['name'] === 'upstream-plugin');

    expect(local).toMatchObject({ source: './plugins/local-plugin' });
    expect(local?.['author']).toBeDefined();

    // The external entry's source is the config's externalSource object, verbatim —
    // not a local path, and it carries no fabricated author.
    expect(upstream).toEqual({
      name: 'upstream-plugin',
      description: 'Referenced from another marketplace, never built here',
      source: { source: 'github', repo: 'example-org/upstream-repo', ref: 'claude-marketplace' },
    });
    expect(upstream?.['author']).toBeUndefined();

    // The YAML report distinguishes "built" from "referenced".
    expect(pb.parsed['pluginsBuilt']).toBe(1);
    expect(pb.parsed['pluginsReferenced']).toBe(1);
    const mps = pb.parsed['marketplaces'] as Array<Record<string, unknown>>;
    const externalPlugins = mps[0]?.['externalPlugins'] as Array<Record<string, unknown>>;
    expect(externalPlugins).toEqual([
      {
        name: 'upstream-plugin',
        source: { source: 'github', repo: 'example-org/upstream-repo', ref: 'claude-marketplace' },
      },
    ]);
  });

  it('rejects externalSource combined with a non-empty skills selector', async () => {
    const tempDir = createTempDir();
    writeTestFile(
      safePath.join(tempDir, 'package.json'),
      JSON.stringify({ name: 't', version: '1.0.0' }),
    );
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      `version: 1
claude:
  marketplaces:
    mp1:
      owner:
        name: Test Org
      plugins:
        - name: upstream-plugin
          skills: "*"
          externalSource:
            source: github
            repo: example-org/upstream-repo
`,
    );

    const result = await executeCli(binPath, ['claude', 'plugin', 'build'], { cwd: tempDir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('skills must be []');
  });
});
