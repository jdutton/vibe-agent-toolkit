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

/** An `--out` that is only ever joined, never created. */
const out = safePath.join(normalizedTmpdir(), 'lab-arm-dirs-unit');

describe('armDirectories', () => {
  it('lays an arm out under <out>/arms/<build>-<arm>-<state>', () => {
    const dirs = armDirectories({ out, build: 'rc11', arm: 'B', state: 'cold' });
    expect(dirs.root).toBe(safePath.join(out, 'arms', 'rc11-B-cold'));
    expect(dirs.store).toBe(safePath.join(dirs.root, 'store'));
    expect(dirs.tmp).toBe(safePath.join(dirs.root, 'tmp'));
    expect(dirs.home).toBe(safePath.join(dirs.root, 'home'));
  });

  it('refuses a relative --out, which a child running in the subject would resolve INSIDE it', () => {
    const refused = (): unknown => armDirectories({ out: '.vat-lab', build: 'rc11', arm: 'B', state: 'cold' });
    expect(refused).toThrow(/not absolute/u);
    expect(() => armDirectoriesAt('relative/root')).toThrow(expect.objectContaining({ code: ARM_REFUSED_CODE }) as Error);
  });

  it('refuses a segment that could leave the arms directory', () => {
    expect(() => armDirectories({ out, build: '..', arm: 'B', state: 'cold' })).toThrow(/build/);
    expect(() => armDirectories({ out, build: 'rc11', arm: 'a/b', state: 'warm' })).toThrow(/arm/);
  });
});

describe('buildAlias', () => {
  it('names a released build by its version, and a checkout by version and short commit', () => {
    expect(buildAlias({ version: '0.2.0-rc.11', commit: null, dirty: null, closure: null })).toBe('0.2.0-rc.11');
    expect(buildAlias({ version: '0.2.0', commit: 'abcdef0123456789', dirty: false, closure: null })).toBe('0.2.0-abcdef0');
  });

  it('yields a usable directory segment from a version carrying path characters', () => {
    const alias = buildAlias({ version: '1.0.0+build/7', commit: null, dirty: null, closure: null });
    expect(() => armDirectories({ out, build: alias, arm: 'C', state: 'cold' })).not.toThrow();
  });
});

describe('armDirectoryEnvironment', () => {
  it('points the store, every temp variable, HOME and CLAUDE_CONFIG_DIR at the arm', () => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'cold' });
    expect(armDirectoryEnvironment(dirs, 'darwin')).toStrictEqual({
      set: {
        VAT_PROJECTION_STORE_DIR: dirs.store,
        TMPDIR: dirs.tmp,
        TEMP: dirs.tmp,
        TMP: dirs.tmp,
        HOME: dirs.home,
        CLAUDE_CONFIG_DIR: dirs.home,
      },
      unset: [],
    });
  });

  it('also points USERPROFILE at the arm home on Windows', () => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'cold' });
    expect(armDirectoryEnvironment(dirs, 'win32').set['USERPROFILE']).toBe(dirs.home);
    expect(armDirectoryEnvironment(dirs, 'linux').set['USERPROFILE']).toBeUndefined();
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
});
