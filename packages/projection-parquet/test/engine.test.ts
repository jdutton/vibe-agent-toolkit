/**
 * The two parent-side guards that decide whether the engine child can be
 * killed and where it will look for its extension cache.
 *
 * Neither needs DuckDB, and both encode a trap that a system test would only
 * catch by hanging: a zero timeout means "no timeout" to `spawnSync`, and a
 * home directory that fails to override on Windows silently sends DuckDB at
 * the user's own `~/.duckdb`.
 */

import { describe, expect, it } from 'vitest';

import { effectiveEngineTimeout, engineChildEnv } from '../src/engine.js';

/** The VAT-owned home every case hands the child. */
const ENGINE_HOME = '/vat/cache/parquet';

describe('effectiveEngineTimeout', () => {
  it('keeps a positive request', () => {
    expect(effectiveEngineTimeout(5000)).toBe(5000);
  });

  it('refuses 0 — to spawnSync that means NO timeout, i.e. an unbounded hang', () => {
    expect(effectiveEngineTimeout(0)).toBeGreaterThan(0);
  });

  it('refuses the value an unset environment variable produces', () => {
    // `Number('')` is 0, and `Number(undefined)` is NaN; neither may disarm the guard.
    expect(effectiveEngineTimeout(Number(''))).toBeGreaterThan(0);
    expect(effectiveEngineTimeout(Number.NaN)).toBeGreaterThan(0);
  });

  it('refuses a negative request', () => {
    expect(effectiveEngineTimeout(-1)).toBeGreaterThan(0);
  });

  it('falls back for an absent request', () => {
    expect(effectiveEngineTimeout(undefined)).toBeGreaterThan(0);
  });
});

describe('engineChildEnv', () => {
  it('sets HOME and USERPROFILE together, never one per platform', () => {
    const env = engineChildEnv(ENGINE_HOME, {});

    // Node reads $HOME on POSIX and USERPROFILE on Windows (ignoring HOME
    // entirely there), so both are the only portable answer.
    expect(env['HOME']).toBe(ENGINE_HOME);
    expect(env['USERPROFILE']).toBe(ENGINE_HOME);
  });

  it('drops an inherited home under ANY casing, so the override cannot lose', () => {
    const env = engineChildEnv(ENGINE_HOME, {
      Home: '/home/user',
      userprofile: String.raw`C:\Users\user`,
      PATH: '/usr/bin',
    });

    // Windows environment names are case-insensitive; two spellings reaching
    // CreateProcess have undefined precedence, and the inherited one often wins.
    const homeKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'HOME');
    const profileKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'USERPROFILE');
    expect(homeKeys).toEqual(['HOME']);
    expect(profileKeys).toEqual(['USERPROFILE']);
    expect(env['HOME']).toBe(ENGINE_HOME);
  });

  it('passes everything else through untouched', () => {
    const env = engineChildEnv(ENGINE_HOME, { PATH: '/usr/bin', LANG: 'C' });

    expect(env['PATH']).toBe('/usr/bin');
    expect(env['LANG']).toBe('C');
  });
});
