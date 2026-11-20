/**
 * The tracked links a checkout wrote as plain files.
 *
 * With `core.symlinks=false` (Git for Windows' default without Developer Mode)
 * git checks a link out as a plain file holding its target text, and keeps the
 * index mode `120000` for it whenever it restages the path (`ce_mode_from_stat`
 * in git's `read-cache.h`). A tree snapshot (`git add --all`) therefore still
 * calls it a link, so any lane that names files without staging them must ask
 * the index too, or it calls a member what the snapshot declines.
 */

import { VatError } from './errors/vat-error.js';
import { gitNoAnswerError, gitRunFailureOf } from './git-no-answer.js';
import { type GitRunResult, runGit } from './git-run.js';
import { safePath } from './path-utils.js';

/** Git's index mode for a symbolic link. */
const GIT_MODE_SYMLINK = '120000';

/** Throw the classified cause when git did not run to completion. */
function refuseUnfinished(command: string, cwd: string, result: GitRunResult): void {
  const failure = gitRunFailureOf(command, cwd, result);
  if (failure !== undefined) throw new VatError(failure.code, failure.reason);
}

/**
 * Every tracked link under `cwd` a checkout with `core.symlinks=false` writes
 * as a plain file: empty, after one `git config` read, when `core.symlinks` is
 * not `false` (git's own default is `true`), and otherwise each index entry of
 * mode `120000`.
 *
 * @param cwd - A directory inside the repository; the index is read under it
 * @returns The links' absolute, forward-slashed paths
 * @throws Coded by cause (`GIT_FAILED`, `GIT_NOT_FOUND`, `GIT_NO_ANSWER`) when
 *   git did not answer
 */
export function gitLinksCheckedOutAsFiles(cwd: string): ReadonlySet<string> {
  const config = runGit(['config', '--type=bool', '--get', 'core.symlinks'], { cwd });
  refuseUnfinished('git config', cwd, config);
  // Exit 1 is an unset key: git's default, `true`.
  if (!config.ok || config.stdout !== 'false') return new Set();

  const index = runGit(['ls-files', '-s', '-z'], { cwd, trim: false, env: { LC_ALL: 'C' } });
  refuseUnfinished('git ls-files', cwd, index);
  if (!index.ok) {
    throw gitNoAnswerError(cwd, 'Without the index, a link checked out as a plain file would be read as a member.');
  }
  const links = new Set<string>();
  // `<mode> <oid> <stage>\t<path>`, NUL-separated, the path relative to `cwd`.
  for (const record of index.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab !== -1 && record.startsWith(`${GIT_MODE_SYMLINK} `)) links.add(safePath.resolve(cwd, record.slice(tab + 1)));
  }
  return links;
}

