/**
 * One timed arm's private directories: where they are and what an arm's VAT
 * step is told about them. Nothing here touches the filesystem — creating and
 * resetting them is pinned in `integration/arm-dirs.integration.test.ts`.
 */

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  ARM_REFUSED_CODE,
  armDirectories,
  armDirectoriesAt,
  armDirectoryEnvironment,
  armOwnedEnvRefusal,
  buildAlias,
} from '../src/harness/arm-dirs.js';

/** An arms root that is only ever joined, never created. */
const out = safePath.join(normalizedTmpdir(), 'lab-arm-dirs-unit');

describe('armDirectories', () => {
  it('lays an arm out directly under its arms root, as <build>-<arm>-<state>', () => {
    const dirs = armDirectories({ root: out, build: 'rc11', arm: 'B', state: 'cold' });
    expect(dirs.root).toBe(safePath.join(out, 'rc11-B-cold'));
    expect(dirs.owned).toStrictEqual([out, dirs.root]);
    expect(dirs.store).toBe(safePath.join(dirs.root, 'store'));
    expect(dirs.tmp).toBe(safePath.join(dirs.root, 'tmp'));
    expect(dirs.home).toBe(safePath.join(dirs.root, 'home'));
  });

  it('refuses a relative arms root, which a child running in the subject would resolve INSIDE it', () => {
    const refused = (): unknown => armDirectories({ root: '.vat-lab', build: 'rc11', arm: 'B', state: 'cold' });
    expect(refused).toThrow(/not absolute/u);
    expect(() => armDirectoriesAt('relative/root')).toThrow(expect.objectContaining({ code: ARM_REFUSED_CODE }) as Error);
  });

  it('refuses a segment that could leave the arms directory', () => {
    expect(() => armDirectories({ root: out, build: '..', arm: 'B', state: 'cold' })).toThrow(/build/);
    expect(() => armDirectories({ root: out, build: 'rc11', arm: 'a/b', state: 'warm' })).toThrow(/arm/);
  });
});

describe('buildAlias', () => {
  it('names a released build by its version, and a checkout by version and short commit', () => {
    expect(buildAlias({ version: '0.2.0-rc.11', commit: null, dirty: null, closure: null })).toBe('0.2.0-rc.11');
    expect(buildAlias({ version: '0.2.0', commit: 'abcdef0123456789', dirty: false, closure: null })).toBe('0.2.0-abcdef0');
  });

  it('gives two dist: builds of one version two aliases — the closure digest tells their bytes apart', () => {
    const one = buildAlias({ version: '0.2.0', commit: null, dirty: null, closure: 'a'.repeat(64) });
    const other = buildAlias({ version: '0.2.0', commit: null, dirty: null, closure: 'b'.repeat(64) });
    expect(one).not.toBe(other);
    expect(one).toBe(`0.2.0-${'a'.repeat(7)}`);
  });

  it('yields a usable directory segment from a version carrying path characters', () => {
    const alias = buildAlias({ version: '1.0.0+build/7', commit: null, dirty: null, closure: null });
    expect(() => armDirectories({ root: out, build: alias, arm: 'C', state: 'cold' })).not.toThrow();
  });
});

describe('armDirectoryEnvironment', () => {
  it('points the store, every temp variable, HOME, CLAUDE_CONFIG_DIR and npm’s cache at the arm', () => {
    const dirs = armDirectories({ root: out, build: 'cand', arm: 'C', state: 'cold' });
    expect(armDirectoryEnvironment(dirs, 'darwin')).toStrictEqual({
      set: {
        VAT_PROJECTION_STORE_DIR: dirs.store,
        TMPDIR: dirs.tmp,
        TEMP: dirs.tmp,
        TMP: dirs.tmp,
        HOME: dirs.home,
        CLAUDE_CONFIG_DIR: dirs.home,
        GIT_CONFIG_NOSYSTEM: '1',
        npm_config_cache: dirs.npmCache,
        npm_config_prefer_offline: 'true',
        npm_config_update_notifier: 'false',
      },
      unset: [],
    });
    // Beside the store, never under the home a sequence empties.
    expect(dirs.npmCache).toBe(safePath.join(dirs.root, 'npm-cache'));
  });

  it('also points USERPROFILE at the arm home on Windows', () => {
    const dirs = armDirectories({ root: out, build: 'cand', arm: 'C', state: 'cold' });
    expect(armDirectoryEnvironment(dirs, 'win32').set['USERPROFILE']).toBe(dirs.home);
    expect(armDirectoryEnvironment(dirs, 'linux').set['USERPROFILE']).toBeUndefined();
  });
});

describe('armDirectoryEnvironment — system git config', () => {
  it('sets GIT_CONFIG_NOSYSTEM=1 on every platform, so no system git config reaches an arm or its preparation', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(armDirectoryEnvironment(armDirectoriesAt(out), platform).set['GIT_CONFIG_NOSYSTEM'], platform).toBe('1');
    }
  });
});

describe('armOwnedEnvRefusal', () => {
  it('refuses every variable the arm sets on ANY platform, and nothing else', () => {
    const dirs = armDirectoriesAt(out);
    const owned = new Set(['linux', 'darwin', 'win32'].flatMap((platform) => Object.keys(armDirectoryEnvironment(dirs, platform as NodeJS.Platform).set)));
    expect(owned).toContain('USERPROFILE');
    for (const name of owned) {
      expect(armOwnedEnvRefusal({ set: { [name]: 'x' }, unset: [] })?.startsWith(`${name} is set by the lab`), name).toBe(true);
      expect(armOwnedEnvRefusal({ set: {}, unset: [name] }), name).not.toBeNull();
    }
    expect(armOwnedEnvRefusal({ set: { LAB_UNOWNED: 'x' }, unset: ['XDG_CONFIG_HOME'] })).toBeNull();
  });

  it('refuses an owned name in any case on Windows, and only its exact spelling elsewhere', () => {
    expect(armOwnedEnvRefusal({ set: { temp: 'x' }, unset: [] }, 'win32')).toMatch(/^temp is set by the lab/u);
    expect(armOwnedEnvRefusal({ set: {}, unset: ['Home'] }, 'win32')).toMatch(/^Home is set by the lab/u);
    expect(armOwnedEnvRefusal({ set: { temp: 'x' }, unset: [] }, 'linux')).toBeNull();
  });
});
