/**
 * Where the scrub's boundary sits, and why it sits there.
 *
 * The list is not "every `GIT_*` variable that could matter" — it is the
 * variables **git sets by itself**, which nobody opted into and which therefore
 * cost nothing to remove. Measured on git 2.50.1 against real pre-commit hooks:
 * a hook is launched with `GIT_INDEX_FILE`, `GIT_PREFIX`, `GIT_AUTHOR_*`,
 * `GIT_CONFIG_PARAMETERS` and — from a linked worktree — `GIT_DIR`. It is never
 * launched with `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`,
 * `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_SYSTEM`; those appear only when an operator
 * put them there, and they are git's documented env-only configuration channel
 * (git >= 2.31) — how CI points github.com at an internal mirror, or supplies
 * credentials without writing a file.
 *
 * So the two config families pull in opposite directions and must not be
 * treated alike: stripping the git-set one closes a real hole, and stripping the
 * operator-set one makes VAT the only tool on the machine that ignores the git
 * configuration everything else honours.
 *
 * The behavioural cases below go through real git rather than asserting on the
 * key list, because the key list is the implementation. A test that only
 * compared arrays would pass for a scrub that never reached a child.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { cleanGitEnv, INHERITED_GIT_ENV } from '../src/git-env.js';
import { runGit } from '../src/git-run.js';

/** Variables this file sets on `process.env`, cleared after every test. */
const TOUCHED = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_GLOBAL',
  'GIT_SSH_COMMAND',
];

/** A plausible inherited `GIT_DIR`: some other repository entirely. */
const FOREIGN_GIT_DIR = '/somewhere/else/.git';

afterEach(() => {
  for (const name of TOUCHED) delete process.env[name];
});

describe('cleanGitEnv — what git sets for you', () => {
  it('removes the redirection variables a hook exports', () => {
    process.env.GIT_DIR = FOREIGN_GIT_DIR;
    process.env.GIT_INDEX_FILE = '.git/index';
    process.env.GIT_PREFIX = 'packages/cli/';

    const env = cleanGitEnv();

    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_PREFIX).toBeUndefined();
  });

  it('removes GIT_CONFIG_PARAMETERS, the config channel git fills in itself', () => {
    process.env.GIT_CONFIG_PARAMETERS = String.raw`'core.excludesFile'='/dev/null'`;

    expect(cleanGitEnv().GIT_CONFIG_PARAMETERS).toBeUndefined();
  });

  it('applies overrides after the strip, so a deliberate value survives', () => {
    process.env.GIT_INDEX_FILE = '/inherited/index';

    // The tree-snapshot path depends on exactly this: it strips the inherited
    // index and then names a throwaway one of its own.
    expect(cleanGitEnv({ GIT_INDEX_FILE: '/mine/index' }).GIT_INDEX_FILE).toBe('/mine/index');
  });

  it('does not mutate process.env', () => {
    process.env.GIT_DIR = FOREIGN_GIT_DIR;

    cleanGitEnv();

    expect(process.env.GIT_DIR).toBe(FOREIGN_GIT_DIR);
  });
});

describe('cleanGitEnv — what the operator sets for themselves', () => {
  it.each(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_GLOBAL'])(
    'keeps %s, which git never sets and CI routinely does',
    (name) => {
      process.env[name] = 'set-by-the-operator';

      expect(cleanGitEnv()[name]).toBe('set-by-the-operator');
    },
  );

  it('keeps transport and credential settings', () => {
    process.env.GIT_SSH_COMMAND = 'ssh -i /keys/ci';

    expect(cleanGitEnv().GIT_SSH_COMMAND).toBe('ssh -i /keys/ci');
  });

  it('lists no variable twice', () => {
    expect(new Set(INHERITED_GIT_ENV).size).toBe(INHERITED_GIT_ENV.length);
  });
});

describe('the boundary, as real git sees it', () => {
  // `git config --get` reads both channels without needing a repository, so
  // these run anywhere. Asserting through git rather than through the key list
  // is the point: it proves the scrub reaches the child at all.
  it('an operator-set env config reaches the child', () => {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'vat.probe';
    process.env.GIT_CONFIG_VALUE_0 = 'operator';

    const result = runGit(['config', '--get', 'vat.probe']);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('operator');
  });

  it('a hook-set -c flag does not', () => {
    // Spelled the way git spells it when exporting the outer invocation's `-c`.
    process.env.GIT_CONFIG_PARAMETERS = String.raw`'vat.probe'='hook'`;

    const result = runGit(['config', '--get', 'vat.probe']);

    // Nothing to report: exit 1 with empty stdout is `git config`'s "unset".
    expect(result.stdout).toBe('');
    expect(result.ok).toBe(false);
  });

  it('a hook-set -c flag DOES reach an ambient call, which is what ambient means', () => {
    // The negative control for the case above: without it, a runGit that failed
    // to pass any environment at all would look identical.
    process.env.GIT_CONFIG_PARAMETERS = String.raw`'vat.probe'='hook'`;

    const result = runGit(['config', '--get', 'vat.probe'], { ambient: true });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('hook');
  });
});
