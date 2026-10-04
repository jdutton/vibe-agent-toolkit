import { writeFile } from 'node:fs/promises';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { refuseAsyncFs, refuseSyncFs } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parsePluginJsonFiles,
  readAuthorPluginJson,
  verifyNoCaseCollidingPluginNames,
  verifyPluginDirCaseMatch,
} from '../../../../src/commands/claude/plugin/plugin-validators.js';
import { refusalCodeOf } from '../../../../src/utils/command-refusal.js';
import { createTempDirTracker } from '../../../system/test-common.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-val-');

/** Run `body`, lift `restore` afterwards, and return what it rejected with (`undefined` when it resolved). */
async function refusedWith(restore: () => void, body: () => Promise<unknown>): Promise<unknown> {
  try {
    return await body().then(() => undefined, (error: unknown) => error);
  } finally {
    restore();
  }
}

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

  // A refusal is not an absence: each reader used to ask `existsSync`, which
  // answers false for EACCES too, so a plugin file the OS refused was skipped
  // as if it were not there.
  describe('a refused read is INPUT_UNREADABLE, never absent', () => {
    it('verifyPluginDirCaseMatch over a plugins/ dir it may not list', async () => {
      const root = createTempDir();
      mkdirSyncReal(safePath.join(root, 'plugins', 'p1'), { recursive: true });
      const error = await refusedWith(
        refuseAsyncFs('readdir', safePath.join(root, 'plugins'), 'EACCES'),
        () => verifyPluginDirCaseMatch(root, 'p1'),
      );
      expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
    });

    it('parsePluginJsonFiles over a hooks.json it may not read', async () => {
      const root = createTempDir();
      mkdirSyncReal(safePath.join(root, 'hooks'), { recursive: true });
      const hooks = safePath.join(root, 'hooks', 'hooks.json');
      await writeFile(hooks, '{}');
      const error = await refusedWith(refuseAsyncFs('readFile', hooks, 'EACCES'), () => parsePluginJsonFiles(root));
      expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
      expect((error as Error).message).toContain('EACCES');
      expect((error as Error).message).not.toContain('not valid JSON');
    });

    it('readAuthorPluginJson: absent is undefined, refused and not-JSON are INPUT_UNREADABLE', async () => {
      const root = createTempDir();
      expect(readAuthorPluginJson(root)).toBeUndefined();

      mkdirSyncReal(safePath.join(root, '.claude-plugin'), { recursive: true });
      const manifest = safePath.join(root, '.claude-plugin', 'plugin.json');
      await writeFile(manifest, '{ not json');
      expect(refusalCodeOf(await refusedWith(() => undefined, async () => readAuthorPluginJson(root)))).toBe('INPUT_UNREADABLE');

      await writeFile(manifest, '{"name":"p"}');
      expect(readAuthorPluginJson(root)).toStrictEqual({ name: 'p' });
      const error = await refusedWith(refuseSyncFs('readFileSync', manifest, 'EACCES'), async () => readAuthorPluginJson(root));
      expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
    });
  });
});
