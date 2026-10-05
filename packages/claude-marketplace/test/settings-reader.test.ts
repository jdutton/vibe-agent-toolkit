/**
 * `readSettingsLayers` / `readEffectiveSettings` against a FAKE filesystem: each
 * case scripts what `readFile` answers per path, so the layer order, the skip of
 * an absent file, and the refusal of an unreadable or malformed one are pinned
 * with no real settings file. The real-file wiring is in
 * `integration/settings-reader.integration.test.ts`.
 */

import type * as FsPromises from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLAUDE_USER_STATE_UNREADABLE_CODE } from '../src/install/plugin-registry.js';
import { readEffectiveSettings, readSettingsLayers } from '../src/settings/settings-reader.js';

const files = vi.hoisted(() => new Map<string, string | NodeJS.ErrnoException>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const readFile = vi.fn((path: string) => {
    const answer = files.get(String(path));
    if (answer === undefined) return Promise.reject(Object.assign(new Error(`ENOENT: ${String(path)}`), { code: 'ENOENT' }));
    return typeof answer === 'string' ? Promise.resolve(answer) : Promise.reject(answer);
  });
  return { ...real, readFile, default: { ...real, readFile } };
});

vi.mock('../src/paths/managed-settings-path.js', () => ({ getManagedSettingsCandidatePaths: () => ['/sys/a.json', '/sys/b.json'] }));
vi.mock('../src/paths/claude-paths.js', () => ({
  getClaudeUserPaths: () => ({ userSettingsPath: '/home/settings.json' }),
  getClaudeProjectPaths: (dir: string) => ({
    projectSettingsPath: `${dir}/.claude/settings.json`,
    projectSettingsLocalPath: `${dir}/.claude/settings.local.json`,
  }),
}));

const USER = '/home/settings.json';
const SONNET = 'claude-sonnet-5';

function refused(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused`), { code });
}

beforeEach(() => {
  files.clear();
});

describe('readSettingsLayers', () => {
  it('reads nothing when no settings file exists', async () => {
    expect(await readSettingsLayers()).toEqual([]);
  });

  it('orders managed, project-local, project, user — and takes the FIRST managed candidate that exists', async () => {
    files.set('/sys/b.json', JSON.stringify({ model: 'managed-b' }));
    files.set('/p/.claude/settings.local.json', JSON.stringify({ model: 'local' }));
    files.set('/p/.claude/settings.json', JSON.stringify({ model: 'project' }));
    files.set(USER, JSON.stringify({ model: 'user' }));

    const layers = await readSettingsLayers({ projectDir: '/p' });

    expect(layers.map((layer) => [layer.level, layer.file])).toEqual([
      ['managed', '/sys/b.json'],
      ['project-local', '/p/.claude/settings.local.json'],
      ['project', '/p/.claude/settings.json'],
      ['user', USER],
    ]);
  });

  it('reads an explicit settings file in place of every managed candidate', async () => {
    files.set('/sys/a.json', JSON.stringify({ model: 'system' }));
    files.set('/given.json', JSON.stringify({ model: SONNET }));

    const layers = await readSettingsLayers({ settingsFile: '/given.json' });

    expect(layers).toEqual([{ level: 'managed', file: '/given.json', settings: { model: SONNET } }]);
  });

  it.each(['EACCES', 'EPERM'])('refuses a file the OS will not let it read (%s), naming the file and the errno — never skipped as absent', async (code) => {
    files.set('/p/.claude/settings.json', refused(code));
    const failure = readSettingsLayers({ projectDir: '/p' });
    await expect(failure).rejects.toMatchObject({ code: CLAUDE_USER_STATE_UNREADABLE_CODE });
    await expect(failure).rejects.toThrow(`Cannot read settings file /p/.claude/settings.json (${code})`);
  });

  it('refuses an unreadable managed candidate rather than falling through to the next one', async () => {
    files.set('/sys/a.json', refused('EACCES'));
    files.set('/sys/b.json', JSON.stringify({ model: 'managed-b' }));
    await expect(readSettingsLayers()).rejects.toThrow('Cannot read settings file /sys/a.json (EACCES)');
  });

  it('refuses a file that exists and does not parse, naming it', async () => {
    files.set(USER, '{ not json');
    await expect(readSettingsLayers()).rejects.toMatchObject({ code: CLAUDE_USER_STATE_UNREADABLE_CODE, message: expect.stringContaining(`Failed to parse settings file ${USER}`) });
  });

  it('refuses any other read failure, naming the file', async () => {
    files.set(USER, refused('EISDIR'));
    await expect(readSettingsLayers()).rejects.toThrow(`Failed to parse settings file ${USER}`);
  });

  it('refuses a file that parses and fails its level\'s schema, naming it', async () => {
    files.set(USER, JSON.stringify({ model: 42 }));
    await expect(readSettingsLayers()).rejects.toMatchObject({ code: CLAUDE_USER_STATE_UNREADABLE_CODE, message: expect.stringContaining(`Invalid settings file ${USER}`) });
  });
});

describe('readEffectiveSettings', () => {
  it('merges the layers it reads, the higher one winning', async () => {
    files.set('/sys/a.json', JSON.stringify({ model: SONNET }));
    files.set(USER, JSON.stringify({ model: 'claude-haiku-4-5' }));

    const effective = await readEffectiveSettings();

    expect(effective.model?.value).toBe(SONNET);
  });
});
