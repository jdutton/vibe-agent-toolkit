/**
 * The `@typescript-eslint/no-unsafe-member-access` / `no-unsafe-assignment`
 * ratchet (`NO_UNSAFE_BACKLOG` in `eslint.config.js`), asserted from the side
 * the rules cannot see.
 *
 * The block that enables the pair applies it to every `src` file NOT on the
 * list, so a listed file that becomes clean is invisible to `bun run lint` and
 * its entry never leaves. This lints each listed file type-aware with the
 * exemption lifted and requires at least one finding, so a clean file fails
 * here until its entry is deleted. Integration tier: the pair needs type
 * information, and a typed program over the 23 files costs seconds.
 *
 * The list is imported from the config module itself, so there is one owner
 * of the fact and this test cannot drift from it.
 */

import { describe, expect, it } from 'vitest';

import { importRootEslintConfig } from '../eslint-clean-files.js';

import { typedFilesWithoutFinding } from './typed-list-ratchet.js';

/** The one `eslint.config.js` export this file reads: the backlog's repo-relative paths. */
const { NO_UNSAFE_BACKLOG } = await importRootEslintConfig<{ readonly NO_UNSAFE_BACKLOG: readonly string[] }>();

const RULES = ['@typescript-eslint/no-unsafe-member-access', '@typescript-eslint/no-unsafe-assignment'] as const;

describe('NO_UNSAFE_BACKLOG only names files that still carry a no-unsafe finding', () => {
  it('is non-empty while the backlog exists', () => {
    expect(NO_UNSAFE_BACKLOG.length).toBeGreaterThan(0);
  });

  it('every listed file still trips one of the pair — remove the entry when it does not', async () => {
    expect(
      await typedFilesWithoutFinding(NO_UNSAFE_BACKLOG, Object.fromEntries(RULES.map((rule) => [rule, 'error']))),
      'These files are clean under both no-unsafe rules. Delete their NO_UNSAFE_BACKLOG entries in '
        + 'eslint.config.js — the list may only shrink, and a stale entry hides the next offender.',
    ).toEqual([]);
  });
});
