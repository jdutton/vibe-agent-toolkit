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

import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { NO_UNSAFE_BACKLOG } from '../../../../eslint.config.js';
import { filesWithoutFinding } from '../eslint-clean-files.js';


const RULES = ['@typescript-eslint/no-unsafe-member-access', '@typescript-eslint/no-unsafe-assignment'] as const;
const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');

/** Lint the backlog with the repo config plus the pair forced on for exactly those files. */
async function cleanWithoutExemption(files: readonly string[]): Promise<string[]> {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfig: [{
      files: [...files],
      // `tsconfigRootDir` because typescript-eslint defaults it to the PROCESS cwd
      // — the package dir here. `projectService` instead of the repo config's
      // `tsconfig.eslint.json`: that config includes every `.ts` file of every
      // package, so linting even one file builds a whole-monorepo program that
      // grows with every change and crossed the integration tier's 1024MB heap
      // cap (measured 1.10GB peak). Each file's own package tsconfig answers the
      // same type question — the same 23/23 files trip the pair — at 0.77GB.
      languageOptions: { parserOptions: { tsconfigRootDir: REPO_ROOT, project: null, projectService: true } },
      rules: Object.fromEntries(RULES.map((rule) => [rule, 'error'])),
    }],
  });
  return filesWithoutFinding(
    eslint,
    REPO_ROOT,
    files,
    (m) => m.ruleId !== null && (RULES as readonly string[]).includes(m.ruleId),
  );
}

describe('NO_UNSAFE_BACKLOG only names files that still carry a no-unsafe finding', () => {
  it('is non-empty while the backlog exists', () => {
    expect(NO_UNSAFE_BACKLOG.length).toBeGreaterThan(0);
  });

  it('every listed file still trips one of the pair — remove the entry when it does not', async () => {
    expect(
      await cleanWithoutExemption(NO_UNSAFE_BACKLOG),
      'These files are clean under both no-unsafe rules. Delete their NO_UNSAFE_BACKLOG entries in '
        + 'eslint.config.js — the list may only shrink, and a stale entry hides the next offender.',
    ).toEqual([]);
  }, 60_000);
});
