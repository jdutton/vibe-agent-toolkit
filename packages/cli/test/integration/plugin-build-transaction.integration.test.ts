/**
 * `vat claude plugin build` replaces each marketplace as ONE tree-change plan: the whole
 * build is written into a staged tree beside `dist/.claude/plugins/marketplaces/<mp>`,
 * swapped in only when every plugin passed the gate.
 *
 * Registered defect: "a failed vat claude plugin build destroys the previous marketplace
 * tree" — the build used to `rm -rf` the previous marketplace before building the new one
 * in place, so any failure after that left it gone or half-built. A failure now leaves the
 * previous marketplace byte-equal, and nothing beside it.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { diffSnapshots, installFaultFs, snapshotTree } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { runClaudePluginBuild } from '../../src/commands/claude/plugin/build.js';
import { cleanupTestTempDir, createTestTempDir } from '../system/test-common.js';
import { commitTestFixture, silentLogger } from '../test-helpers.js';

const MP = 'mp';
const PLUGIN = 'p1';

/** Write `content` at `path`, making its directory. */
function put(path: string, content: string): void {
  mkdirSyncReal(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A project with one marketplace whose plugin ships a command, and (optionally) a plugin-local skill the gate fails. */
function writeProject(tempDir: string, gated = false): void {
  put(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  put(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), `skills:
  include: ["plugins/*/skills/**/SKILL.md"]
  defaults:
    validation:
      severity:
        LINK_OUTSIDE_SKILL_DIR: error
claude:
  marketplaces:
    ${MP}:
      owner:
        name: Test
      plugins:
        - name: ${PLUGIN}
          skills: []
`);
  put(safePath.join(tempDir, 'plugins', PLUGIN, 'commands', 'hello.md'), '# hello\n');
  if (gated) {
    const skills = safePath.join(tempDir, 'plugins', PLUGIN, 'skills');
    put(safePath.join(skills, 'shared.md'), '# Shared notes\n');
    put(
      safePath.join(skills, 'strict', 'SKILL.md'),
      '---\nname: strict\ndescription: Plugin-local skill whose SKILL.md links a file outside its own directory.\n---\n\n# strict\n\nSee [shared notes](../shared.md).\n',
    );
  }
  put(safePath.join(tempDir, '.gitignore'), 'dist/\n');
  commitTestFixture(tempDir);
}

/** What a previous build left: a marketplace with an orphaned plugin the next build no longer ships. */
function writePreviousMarketplace(tempDir: string): string {
  const marketplace = safePath.join(tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MP);
  put(safePath.join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: MP, plugins: [{ name: 'orphan' }] }));
  put(safePath.join(marketplace, 'plugins', 'orphan', 'commands', 'old.md'), '# old\n');
  return marketplace;
}

describe('plugin build — one plan per marketplace (integration)', () => {
  let tempDir: string;

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('a failed build leaves the previous marketplace byte-equal, and nothing beside it', async () => {
    tempDir = createTestTempDir('vat-plugin-build-txn-');
    writeProject(tempDir);
    writePreviousMarketplace(tempDir);
    const dist = safePath.join(tempDir, 'dist');
    const before = snapshotTree(dist);

    // The new marketplace.json — the build's last write but the distribution files — is refused.
    const session = installFaultFs({
      within: tempDir,
      faults: [{ family: 'write', path: (path) => path.includes(`/.${MP}.vat-staged-`) && path.endsWith('/marketplace.json'), errno: 'ENOSPC' }],
    });
    try {
      await expect(runClaudePluginBuild(tempDir, { logger: silentLogger, runOutputs: [] }))
        .rejects.toMatchObject({ code: 'FS_FAULT', side: 'destination' });
    } finally {
      session.restore();
    }

    expect(diffSnapshots(before, snapshotTree(dist))).toEqual([]);
  });

  it('a plugin the gate stops leaves the previous marketplace byte-equal', async () => {
    tempDir = createTestTempDir('vat-plugin-build-txn-gated-');
    writeProject(tempDir, true);
    writePreviousMarketplace(tempDir);
    const dist = safePath.join(tempDir, 'dist');
    const before = snapshotTree(dist);

    await expect(runClaudePluginBuild(tempDir, { logger: silentLogger, runOutputs: [] }))
      .rejects.toThrow(/post-build validation errors: strict/);

    expect(diffSnapshots(before, snapshotTree(dist))).toEqual([]);
  });

  it('a build that finishes replaces the previous marketplace whole: no orphan, no staged or parked tree', async () => {
    tempDir = createTestTempDir('vat-plugin-build-txn-ok-');
    writeProject(tempDir);
    const marketplace = writePreviousMarketplace(tempDir);

    const [built] = await runClaudePluginBuild(tempDir, { logger: silentLogger, runOutputs: [] });

    expect(readdirSync(safePath.join(marketplace, 'plugins'))).toEqual([PLUGIN]);
    expect(readdirSync(safePath.join(tempDir, 'dist', '.claude', 'plugins', 'marketplaces'))).toEqual([MP]);
    expect(built?.plugins[0]?.pluginDir).toBe(safePath.join(marketplace, 'plugins', PLUGIN));
    expect(built?.residue).toEqual([]);
  });
});
