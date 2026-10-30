/**
 * One arm's environment: inherited, except the variables that decide WHICH vat
 * runs — those are never inherited, only ever set by the arm.
 *
 * The positive controls matter as much as the strips: an implementation that
 * handed the child an empty environment would pass every "is absent" assertion
 * below, so each test that strips something also reads back something ordinary
 * that must have survived.
 */

import { readFileSync } from 'node:fs';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  ARM_OWNED_ENV_KEYS,
  armEnvironmentClash,
  buildArmEnv,
  CLEARED_ENV_NAMES,
  clearedEnvironment,
  mergeArmEnvironments,
  sameArmEnvironment,
} from '../src/harness/arm-env.js';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '../../..');

describe('buildArmEnv', () => {
  it('strips an inherited arm-owned variable the arm did not set', () => {
    const env = buildArmEnv(
      { PATH: '/bin', VAT_BIN: '/leak/bin.js', VAT_ROOT_DIR: '/leak' },
      { set: {}, unset: [] },
    );
    expect(env['VAT_BIN']).toBeUndefined();
    expect(env['VAT_ROOT_DIR']).toBeUndefined();
    expect(env['PATH']).toBe('/bin'); // positive control: ordinary inheritance survives
  });

  it('keeps an arm-owned variable the arm SET, over the inherited one', () => {
    const env = buildArmEnv({ VAT_BIN: '/leak/bin.js' }, { set: { VAT_BIN: '/arm/bin.js' }, unset: [] });
    expect(env['VAT_BIN']).toBe('/arm/bin.js');
  });

  it('removes an explicitly unset ordinary variable', () => {
    const env = buildArmEnv(
      { CLAUDE_CONFIG_DIR: '/home/.claude', HOME: '/home' },
      { set: {}, unset: ['CLAUDE_CONFIG_DIR'] },
    );
    expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    expect(env['HOME']).toBe('/home');
  });

  it('refuses a key that is both set and unset', () => {
    expect(() => buildArmEnv({}, { set: { X: '1' }, unset: ['X'] })).toThrow(/both set and unset/);
  });

  it('names the clashing key, and nothing for an arm without one', () => {
    expect(armEnvironmentClash({ set: { X: '1', Y: '2' }, unset: ['Z', 'Y'] })).toBe('Y');
    expect(armEnvironmentClash({ set: { X: '1' }, unset: ['Z'] })).toBeUndefined();
  });

  it('owns every VAT_* variable the CLI wrapper reads or sets, except its diagnostic switch', () => {
    // Derived from the wrapper's own source, not restated: a variable the wrapper gains
    // (Task 3 adds VAT_BIN) reds this test until the lab owns it too, and a key the
    // wrapper drops reds it the other way.
    const source = readFileSync(safePath.join(REPO_ROOT, 'packages/cli/src/bin/vat.ts'), 'utf-8');
    const named = new Set([...source.matchAll(/\bVAT_[A-Z_]+\b/g)].map((m) => m[0]));
    const WRAPPER_DIAGNOSTIC_ENV = ['VAT_DEBUG'];
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect([...ARM_OWNED_ENV_KEYS, ...WRAPPER_DIAGNOSTIC_ENV].toSorted(byName)).toStrictEqual(
      [...named].toSorted(byName),
    );
  });
});

describe('sameArmEnvironment / mergeArmEnvironments', () => {
  it('treats key order and unset order as irrelevant', () => {
    expect(
      sameArmEnvironment(
        { set: { A: '1', B: '2' }, unset: ['Y', 'X'] },
        { set: { B: '2', A: '1' }, unset: ['X', 'Y'] },
      ),
    ).toBe(true);
  });

  it('distinguishes an unset from an absent', () => {
    expect(sameArmEnvironment({ set: {}, unset: ['X'] }, { set: {}, unset: [] })).toBe(false);
  });

  it('distinguishes two values for one key', () => {
    // Positive control for the order test above: equality is on values, not key sets.
    expect(sameArmEnvironment({ set: { A: '1' }, unset: [] }, { set: { A: '2' }, unset: [] })).toBe(false);
  });

  it('lets the override win a set and cancels a base unset it sets', () => {
    expect(
      mergeArmEnvironments({ set: { A: '1' }, unset: ['B'] }, { set: { A: '2', B: '3' }, unset: [] }),
    ).toStrictEqual({ set: { A: '2', B: '3' }, unset: [] });
  });

  it('lets the override unset a key the base set', () => {
    // The mirror of the case above: without it, a merged arm could be both set
    // and unset on one key, which buildArmEnv refuses.
    expect(
      mergeArmEnvironments({ set: { A: '1', B: '2' }, unset: [] }, { set: {}, unset: ['A'] }),
    ).toStrictEqual({ set: { B: '2' }, unset: ['A'] });
  });
});

describe('clearedEnvironment', () => {
  /** A developer shell carrying every kind of state an arm must not inherit. */
  const DEVELOPER: NodeJS.ProcessEnv = {
    PATH: '/bin',
    HOME: '/home/dev',
    VAT_PROJECTION_STORE: 'off',
    VAT_RESOURCES_CRAWL: 'walk',
    CLAUDE_CONFIG_DIR: '/home/dev/.claude',
    TMPDIR: '/var/dev-tmp',
    TEMP: '/var/dev-tmp',
    TMP: '/var/dev-tmp',
    XDG_CACHE_HOME: '/home/dev/.cache',
    XDG_CONFIG_HOME: '/home/dev/.config',
    GIT_CONFIG_GLOBAL: '/home/dev/.gitconfig',
  };
  const byName = (a: string, b: string): number => a.localeCompare(b);

  it('removes every VAT_* name and every cleared name from a VAT step, and records them', () => {
    const cleared = clearedEnvironment(DEVELOPER, 'vat', { set: { HOME: '/arm/home' }, unset: [] });
    const env = buildArmEnv(DEVELOPER, cleared.env);
    for (const name of [...CLEARED_ENV_NAMES, 'VAT_PROJECTION_STORE', 'VAT_RESOURCES_CRAWL']) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env['HOME']).toBe('/arm/home'); // the arm's own wins
    expect(env['PATH']).toBe('/bin'); // positive control: ordinary inheritance survives
    expect(cleared.removed).toStrictEqual(
      [...CLEARED_ENV_NAMES, 'VAT_PROJECTION_STORE', 'VAT_RESOURCES_CRAWL'].toSorted(byName),
    );
  });

  it('removes only VAT_* names from a non-VAT step, keeping the real home and temp', () => {
    const cleared = clearedEnvironment(DEVELOPER, 'tool', { set: {}, unset: [] });
    const env = buildArmEnv(DEVELOPER, cleared.env);
    expect(env['VAT_PROJECTION_STORE']).toBeUndefined();
    expect(env['XDG_CONFIG_HOME']).toBe('/home/dev/.config');
    expect(env['TMPDIR']).toBe('/var/dev-tmp');
    expect(cleared.removed).toStrictEqual(['VAT_PROJECTION_STORE', 'VAT_RESOURCES_CRAWL']);
  });

  it('lets the arm set a cleared name, which is then not recorded as removed', () => {
    const cleared = clearedEnvironment(DEVELOPER, 'vat', { set: { TMPDIR: '/arm/tmp' }, unset: [] });
    expect(buildArmEnv(DEVELOPER, cleared.env)['TMPDIR']).toBe('/arm/tmp');
    expect(cleared.removed).not.toContain('TMPDIR');
  });
});
