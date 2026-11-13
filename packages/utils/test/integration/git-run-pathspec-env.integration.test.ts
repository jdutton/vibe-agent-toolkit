/**
 * `runGit` against a real git, with the operator's pathspec magic exported in the parent
 * environment: a pattern VAT hands git is read as git reads one with none set. The unit suite
 * observes the env object handed the spawn; only a real git shows the variable no longer reaches it.
 */

import { mkdtempSync, rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runGit, runGitOrThrow } from '../../src/git-run.js';
import { normalizedTmpdir, safePath } from '../../src/path-utils.js';

/** The tracked file; the pattern below differs from it only in case. */
const TRACKED = 'Docs/Guide.md';

describe('runGit reads a pathspec as git does with no pathspec variable set', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-git-pathspec-'));
    runGitOrThrow(['init', '-q'], { cwd: dir });
    // Index only: no file on disk, so a case-insensitive filesystem cannot answer for git.
    const oid = runGitOrThrow(['hash-object', '-w', '--stdin'], { cwd: dir, input: 'guide\n' }).trim();
    runGitOrThrow(['update-index', '--add', '--cacheinfo', `100644,${oid},${TRACKED}`], { cwd: dir });
    vi.stubEnv('GIT_ICASE_PATHSPECS', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('matches nothing for an ls-files pattern that differs only in case', () => {
    // The probe: git itself, handed the parent's variable, does match it case-insensitively.
    const ambient = runGit(['ls-files', '--', 'docs/guide.md'], { cwd: dir, ambient: true });
    expect(ambient.stdout, 'the parent environment carries GIT_ICASE_PATHSPECS=1').toBe(TRACKED);

    const result = runGit(['ls-files', '--', 'docs/guide.md'], { cwd: dir });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('');
  });
});
