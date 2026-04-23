/* eslint-disable security/detect-non-literal-fs-filename */
import { writeFile } from 'node:fs/promises';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parsePluginJsonFiles,
  verifyNoCaseCollidingPluginNames,
  verifyPluginDirCaseMatch,
} from '../../../../src/commands/claude/plugin/plugin-validators.js';
import { createTempDirTracker } from '../../../system/test-common.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-val-');

describe('plugin-validators', () => {
  afterEach(() => cleanupTempDirs());

  describe('verifyPluginDirCaseMatch', () => {
    it('passes when on-disk dir name matches declared plugin name exactly', async () => {
      const root = createTempDir();
      mkdirSyncReal(safePath.join(root, 'plugins', 'foo-bar'), { recursive: true });
      await expect(verifyPluginDirCaseMatch(root, 'foo-bar')).resolves.toBeUndefined();
    });

    it('throws when declared name case does not match on-disk case', async () => {
      const root = createTempDir();
      mkdirSyncReal(safePath.join(root, 'plugins', 'Foo-Bar'), { recursive: true });
      await expect(verifyPluginDirCaseMatch(root, 'foo-bar')).rejects.toThrow(/case/i);
    });

    it('no-ops silently when plugins dir does not exist (files-only plugin)', async () => {
      const root = createTempDir();
      await expect(verifyPluginDirCaseMatch(root, 'foo-bar')).resolves.toBeUndefined();
    });
  });

  describe('verifyNoCaseCollidingPluginNames', () => {
    it('passes for fully distinct names', () => {
      expect(() => verifyNoCaseCollidingPluginNames(['alpha', 'beta'])).not.toThrow();
    });

    it('throws when two names differ only in case', () => {
      expect(() => verifyNoCaseCollidingPluginNames(['foo', 'Foo'])).toThrow();
    });

    it('throws on exact-match duplicates (e.g., same plugin name in two marketplaces)', () => {
      expect(() => verifyNoCaseCollidingPluginNames(['alpha', 'alpha'])).toThrow(
        /declared more than once/i,
      );
    });
  });

  describe('parsePluginJsonFiles (parse-only)', () => {
    it('accepts valid hooks.json and .mcp.json', async () => {
      const root = createTempDir();
      const plugin = safePath.join(root, 'plugins', 'p1');
      mkdirSyncReal(safePath.join(plugin, 'hooks'), { recursive: true });
      await writeFile(safePath.join(plugin, 'hooks', 'hooks.json'), '{"events":{}}');
      await writeFile(safePath.join(plugin, '.mcp.json'), '{"mcpServers":{}}');
      await expect(parsePluginJsonFiles(plugin)).resolves.toBeUndefined();
    });

    it('throws on malformed hooks.json', async () => {
      const root = createTempDir();
      const plugin = safePath.join(root, 'plugins', 'p1');
      mkdirSyncReal(safePath.join(plugin, 'hooks'), { recursive: true });
      await writeFile(safePath.join(plugin, 'hooks', 'hooks.json'), '{not json');
      await expect(parsePluginJsonFiles(plugin)).rejects.toThrow(/hooks\.json/);
    });

    it('throws on malformed .mcp.json', async () => {
      const root = createTempDir();
      const plugin = safePath.join(root, 'plugins', 'p1');
      mkdirSyncReal(plugin, { recursive: true });
      await writeFile(safePath.join(plugin, '.mcp.json'), 'bogus');
      await expect(parsePluginJsonFiles(plugin)).rejects.toThrow(/\.mcp\.json/);
    });

    it('no-ops silently when neither file is present', async () => {
      const root = createTempDir();
      const plugin = safePath.join(root, 'plugins', 'p1');
      mkdirSyncReal(plugin, { recursive: true });
      await expect(parsePluginJsonFiles(plugin)).resolves.toBeUndefined();
    });
  });
});
