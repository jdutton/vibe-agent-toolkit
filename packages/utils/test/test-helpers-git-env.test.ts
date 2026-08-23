/**
 * `detachGitEnv()`'s key list is a deliberate copy of the shipped scrub's, kept
 * local so the `./testing` subpath stays importable with zero dependencies
 * installed (`subpath-purity.test.ts` pins that). This file is what makes the
 * copy safe: a key added to `@vibe-validate/git`'s scrub and not here would
 * otherwise leave every hook-fabricating fixture inheriting it silently, and the
 * fixture would then pass or fail for reasons it never set up.
 *
 * The test lives here rather than in `src/` because a test file may import the
 * dependency freely — only the published entry may not.
 */

import { stripGitEnv } from '@vibe-validate/git';
import { afterEach, describe, expect, it } from 'vitest';

import { INHERITED_GIT_ENV, detachGitEnv } from '../src/test-helpers.js';

/** A value no real environment would hold, so a survivor is unambiguous. */
const SENTINEL = 'set-by-this-test';

/**
 * Every `GIT_*` variable either side might have an opinion about — a deliberate
 * SUPERSET of both lists, and the reason this test can fail at all.
 *
 * Setting only `INHERITED_GIT_ENV` and asking the scrub what it removed compares
 * the list against itself: a key dropped from `INHERITED_GIT_ENV` is then never
 * set, so the scrub has nothing to remove for it and both sides shrink together.
 * Verified — with that shape, deleting `GIT_NOTES_REF` from the source list left
 * all three tests green.
 *
 * When git gains a variable, add it HERE first; the assertions below then decide
 * whether it belongs in the scrub, in `detachGitEnv`, or in neither.
 */
const CANDIDATE_GIT_ENV = [
  ...INHERITED_GIT_ENV,
  // Scrub-side keys, listed independently so removing one from the source list
  // is detected rather than mirrored.
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_INDEX_VERSION',
  'GIT_NAMESPACE',
  'GIT_NOTES_REF',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
  // The operator's own channel: present so the assertions below prove it is
  // left alone, rather than proving nothing because it was never set.
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_VALUE_0',
  // Credential/transport vars neither side touches.
  'GIT_ASKPASS',
  'GIT_SSH_COMMAND',
  'GIT_TERMINAL_PROMPT',
];

const saved = new Map<string, string | undefined>();

function setAll(names: readonly string[]): void {
  for (const name of names) {
    saved.set(name, process.env[name]);
    process.env[name] = SENTINEL;
  }
}

afterEach(() => {
  for (const [name, value] of saved) {
    delete process.env[name];
    if (value !== undefined) process.env[name] = value;
  }
  saved.clear();
});

describe('detachGitEnv covers exactly what the shipped scrub removes', () => {
  it('drops every key stripGitEnv() drops, and no others', () => {
    // Set the SUPERSET, then ask the shipped scrub which of them it removes.
    // The answer is independent of `INHERITED_GIT_ENV`, so the comparison below
    // is against the real scrub rather than against itself.
    setAll(CANDIDATE_GIT_ENV);

    const scrubbed = stripGitEnv(process.env);
    const removedByScrub = Object.keys(process.env)
      .filter((name) => !(name in scrubbed))
      .sort((a, b) => a.localeCompare(b));

    expect([...INHERITED_GIT_ENV].sort((a, b) => a.localeCompare(b))).toEqual(removedByScrub);

    // The candidate list has to be a strict superset or the assertion above can
    // silently weaken back into comparing one list with itself.
    expect(CANDIDATE_GIT_ENV.length).toBeGreaterThan(INHERITED_GIT_ENV.length);
    // And the operator's channel must have survived, which is the half of the
    // boundary that is NOT symmetric with the hazard list.
    expect(scrubbed.GIT_CONFIG_COUNT).toBe(SENTINEL);
    expect(scrubbed.GIT_SSH_COMMAND).toBe(SENTINEL);
  });

  it('actually clears them, and restores what was there before', () => {
    setAll(INHERITED_GIT_ENV);

    const restore = detachGitEnv();
    for (const name of INHERITED_GIT_ENV) {
      expect(process.env[name]).toBeUndefined();
    }

    restore();
    for (const name of INHERITED_GIT_ENV) {
      expect(process.env[name]).toBe(SENTINEL);
    }
  });

  it('leaves the operator config channel alone, and restores an absent key as absent', () => {
    // The half that is NOT symmetric with the scrub's hazard list: these are
    // git's env-only configuration channel, which a test may be using on purpose
    // to keep a clone off the network. Clearing them is a measured regression.
    saved.set('GIT_CONFIG_COUNT', process.env.GIT_CONFIG_COUNT);
    process.env.GIT_CONFIG_COUNT = '1';
    delete process.env.GIT_DIR;
    saved.set('GIT_DIR', undefined);

    const restore = detachGitEnv();
    expect(process.env.GIT_CONFIG_COUNT).toBe('1');

    restore();
    // Restored as unset rather than as the string 'undefined'.
    expect('GIT_DIR' in process.env).toBe(false);
  });
});
