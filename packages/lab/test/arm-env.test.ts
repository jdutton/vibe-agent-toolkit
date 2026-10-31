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

import { INHERITED_GIT_ENV, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
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
import { compareByCodeUnit } from '../src/harness/fingerprint.js';

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
    const cleared = clearedEnvironment(DEVELOPER, 'vat', { set: { HOME: '/arm/home' }, unset: [] }, 'linux');
    const env = buildArmEnv(DEVELOPER, cleared.env);
    for (const name of [...CLEARED_ENV_NAMES, 'VAT_PROJECTION_STORE', 'VAT_RESOURCES_CRAWL']) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env['HOME']).toBe('/arm/home'); // the arm's own wins
    expect(env['PATH']).toBe('/bin'); // positive control: ordinary inheritance survives
    expect(cleared.removed).toStrictEqual(
      [...CLEARED_ENV_NAMES.filter((name) => Object.hasOwn(DEVELOPER, name)), 'VAT_PROJECTION_STORE', 'VAT_RESOURCES_CRAWL'].toSorted(byName),
    );
  });

  it('removes only VAT_* names from a non-VAT step, keeping the real home and temp', () => {
    const cleared = clearedEnvironment(DEVELOPER, 'tool', { set: {}, unset: [] }, 'linux');
    const env = buildArmEnv(DEVELOPER, cleared.env);
    expect(env['VAT_PROJECTION_STORE']).toBeUndefined();
    expect(env['XDG_CONFIG_HOME']).toBe('/home/dev/.config');
    expect(env['TMPDIR']).toBe('/var/dev-tmp');
    expect(cleared.removed).toStrictEqual(['VAT_PROJECTION_STORE', 'VAT_RESOURCES_CRAWL']);
  });

  /**
   * Every inherited npm setting that is not a network one: identity and config
   * files, and anything that changes what npm does — what a VAT step must never
   * carry, in any case npm reads.
   */
  const NPM_OTHER: NodeJS.ProcessEnv = {
    npm_config_userconfig: '/home/dev/.npmrc',
    NPM_CONFIG_GLOBALCONFIG: '/etc/npmrc',
    'npm_config_//registry.example/:_authToken': 'secret',
    npm_config__auth: 'dXNlcjpwYXNz',
    npm_config_always_auth: 'true',
    'npm_config_always-auth': 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_offline: 'true',
    npm_config_prefer_offline: 'false',
    npm_config_cert: 'PEM',
    npm_config_key: 'PEM',
    npm_config_certfile: '/home/dev/client.pem',
    npm_config_keyfile: '/home/dev/client.key',
    npm_config_node_options: '--require /home/dev/hook.js',
    'npm_config_script-shell': '/bin/zsh',
    npm_config_registry_extra: 'not a network key',
  };

  /** The developer's npm network settings, in both spellings: what a VAT step keeps, so an npx arm can reach its registry. */
  const NPM_NETWORK: NodeJS.ProcessEnv = {
    NPM_CONFIG_REGISTRY: 'https://registry.example/',
    'npm_config_@scope:registry': 'https://scope.example/',
    npm_config_proxy: 'http://proxy.example:3128',
    'npm_config_https-proxy': 'http://proxy.example:3128',
    npm_config_https_proxy: 'http://proxy.example:3128',
    npm_config_noproxy: 'localhost',
    'npm_config_no-proxy': 'localhost',
    npm_config_no_proxy: 'localhost',
    npm_config_ca: 'PEM',
    npm_config_cafile: '/etc/ssl/corp.pem',
    'npm_config_strict-ssl': 'true',
    npm_config_strict_ssl: 'true',
  };

  it('removes every inherited npm setting but the network ones from a VAT step, in any case, and keeps them for a tool step', () => {
    const npm: NodeJS.ProcessEnv = { PATH: '/bin', ...NPM_OTHER, npm_config_cache: '/home/dev/.npm' };
    const arm = { set: { npm_config_cache: '/arm/npm-cache', npm_config_prefer_offline: 'true' }, unset: [] };

    const vat = clearedEnvironment(npm, 'vat', arm, 'linux');
    const env = buildArmEnv(npm, vat.env);
    const pointed = new Set(['npm_config_prefer_offline']);
    expect(new Set(vat.removed)).toStrictEqual(new Set(Object.keys(NPM_OTHER).filter((name) => !pointed.has(name))));
    expect(env['npm_config_cache']).toBe('/arm/npm-cache');
    expect(env['npm_config_prefer_offline']).toBe('true');
    expect(env['PATH']).toBe('/bin');
    expect(vat.npmNetwork).toStrictEqual([]);
    expect(clearedEnvironment(npm, 'tool', arm, 'linux').removed).toStrictEqual([]);
  });

  it("keeps the developer's npm network settings in a VAT step, and records their names, never their values", () => {
    const npm: NodeJS.ProcessEnv = { PATH: '/bin', ...NPM_NETWORK };

    const vat = clearedEnvironment(npm, 'vat', { set: {}, unset: [] }, 'linux');
    const env = buildArmEnv(npm, vat.env);
    expect(vat.removed).toStrictEqual([]);
    for (const [name, value] of Object.entries(NPM_NETWORK)) expect(env[name], name).toBe(value);
    expect(vat.npmNetwork).toStrictEqual(Object.keys(NPM_NETWORK).toSorted(compareByCodeUnit));
    expect(clearedEnvironment(npm, 'tool', { set: {}, unset: [] }, 'linux').npmNetwork).toStrictEqual(vat.npmNetwork);
  });

  it('judges npm names whatever their case on Windows too', () => {
    const npm: NodeJS.ProcessEnv = { Npm_Config_Registry: 'https://registry.example/', Npm_Config_Ignore_Scripts: 'true' };

    const vat = clearedEnvironment(npm, 'vat', { set: {}, unset: [] }, 'win32');
    expect(vat.removed).toStrictEqual(['Npm_Config_Ignore_Scripts']);
    expect(vat.npmNetwork).toStrictEqual(['Npm_Config_Registry']);
  });

  it('lets the arm set a cleared name, which is then not recorded as removed', () => {
    const cleared = clearedEnvironment(DEVELOPER, 'vat', { set: { TMPDIR: '/arm/tmp' }, unset: [] }, 'linux');
    expect(buildArmEnv(DEVELOPER, cleared.env)['TMPDIR']).toBe('/arm/tmp');
    expect(cleared.removed).not.toContain('TMPDIR');
  });

  /** git state a shell can carry beyond the global config file. */
  const GIT_STATE: NodeJS.ProcessEnv = {
    PATH: '/bin',
    GIT_CONFIG: '/home/dev/other.gitconfig',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: '/home/dev/ignore',
    GIT_CONFIG_PARAMETERS: "'core.autocrlf'='true'",
    GIT_CONFIG_SYSTEM: '/etc/dev-gitconfig',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '0',
    GIT_EXEC_PATH: '/home/dev/git-core',
    GIT_TEMPLATE_DIR: '/home/dev/git-templates',
    GIT_DIR: '/elsewhere/.git',
    GIT_WORK_TREE: '/elsewhere',
    GIT_INDEX_FILE: '/elsewhere/.git/index',
    GIT_COMMON_DIR: '/elsewhere/.git',
    GIT_OBJECT_DIRECTORY: '/elsewhere/.git/objects',
    GIT_SHALLOW_FILE: '/elsewhere/.git/shallow',
    GIT_GRAFT_FILE: '/elsewhere/.git/info/grafts',
    GIT_CEILING_DIRECTORIES: '/elsewhere',
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
    GIT_NOTES_REF: 'refs/notes/elsewhere',
    GIT_INDEX_VERSION: '4',
    GIT_AUTHOR_NAME: 'kept',
  };
  /** The developer's own config channel: cleared from a VAT step, kept for a tool step. */
  const CONFIG = [
    'GIT_ATTR_NOSYSTEM',
    'GIT_CONFIG',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_VALUE_0',
    'GIT_EXEC_PATH',
    'GIT_TEMPLATE_DIR',
  ];
  /** What git exports into a hook ({@link INHERITED_GIT_ENV}): cleared from both kinds. */
  const LOCATING = [
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_CONFIG_PARAMETERS',
    'GIT_DIR',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_GRAFT_FILE',
    'GIT_INDEX_FILE',
    'GIT_INDEX_VERSION',
    'GIT_NOTES_REF',
    'GIT_OBJECT_DIRECTORY',
    'GIT_SHALLOW_FILE',
    'GIT_WORK_TREE',
  ];

  it('removes every git config override from a VAT step, and every repo-locating git name from both kinds', () => {
    expect(clearedEnvironment(GIT_STATE, 'vat', { set: {}, unset: [] }, 'linux').removed).toStrictEqual(
      [...CONFIG, ...LOCATING].toSorted(byName),
    );
    const tool = clearedEnvironment(GIT_STATE, 'tool', { set: {}, unset: [] }, 'linux');
    expect(tool.removed).toStrictEqual(LOCATING.toSorted(byName));
    // Positive controls: a tool keeps the developer's git config, and identity survives both.
    const toolEnv = buildArmEnv(GIT_STATE, tool.env);
    expect(toolEnv['GIT_CONFIG_COUNT']).toBe('1');
    expect(toolEnv['GIT_AUTHOR_NAME']).toBe('kept');
  });

  it('clears every name git exports into a hook — the one list utils owns — from both kinds', () => {
    const hook = Object.fromEntries(INHERITED_GIT_ENV.map((name) => [name, 'x']));
    expect(clearedEnvironment(hook, 'tool', { set: {}, unset: [] }, 'linux').removed).toStrictEqual([...INHERITED_GIT_ENV].toSorted(byName));
    expect(clearedEnvironment(hook, 'vat', { set: {}, unset: [] }, 'linux').removed).toStrictEqual([...INHERITED_GIT_ENV].toSorted(byName));
  });

  it('matches names case-insensitively on Windows, where Temp and TEMP are one variable', () => {
    const mixed: NodeJS.ProcessEnv = { Path: 'C:/bin', Temp: 'C:/dev-tmp', Vat_Bin: 'C:/dev/vat', Git_Dir: 'C:/x/.git' };
    const cleared = clearedEnvironment(mixed, 'vat', { set: { TEMP: 'C:/arm/tmp' }, unset: [] }, 'win32');
    // Temp is re-pointed (the arm sets TEMP), not removed: the report must not say it went without it…
    expect(cleared.removed).toStrictEqual(['Git_Dir', 'Vat_Bin']);
    // …yet the inherited spelling is still dropped, so the child sees ONE value, the arm's.
    expect(cleared.env.unset).toContain('Temp');
    expect(cleared.env.set['TEMP']).toBe('C:/arm/tmp');
    // POSIX names are case-sensitive: Temp is not TEMP there.
    expect(clearedEnvironment(mixed, 'vat', { set: {}, unset: [] }, 'linux').removed).toStrictEqual([]);
  });
});
