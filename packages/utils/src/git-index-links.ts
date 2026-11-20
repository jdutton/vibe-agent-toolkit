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

import { GIT_MODE_SYMLINK } from '@vibe-validate/git';

import { VatError } from './errors/vat-error.js';
import { gitNoAnswerError, gitRunFailureOf } from './git-no-answer.js';
import { type GitRunResult, runGit } from './git-run.js';
import { safePath } from './path-utils.js';

/**
 * The stage git reads a path's mode from, best first: stage 0 is a merged
 * entry; for a conflicted path git prefers "ours" (2), then the base (1), then
 * "theirs" (3), as `ce_mode_from_stat`'s caller finds the entry to compare.
 */
const STAGE_PREFERENCE: readonly string[] = ['0', '2', '1', '3'];

/** `git config --get` exits 1 for a key that is not set. */
const CONFIG_KEY_UNSET_STATUS = 1;

/** Throw the classified cause when git did not run to completion. */
function refuseUnfinished(command: string, cwd: string, result: GitRunResult): void {
  const failure = gitRunFailureOf(command, cwd, result);
  if (failure !== undefined) throw new VatError(failure.code, failure.reason);
}

/**
 * Whether `core.symlinks` is false for the repository at `cwd`.
 *
 * Unset is the platform's default, which is not the same everywhere: git's own
 * default is `true`, but Git for Windows starts with `has_symlinks = 0` and
 * turns it on only when `core.symlinks` says so, so an unset key on win32 is
 * `false`.
 */
function symlinksOff(cwd: string): boolean {
  const config = runGit(['config', '--type=bool', '--get', 'core.symlinks'], { cwd });
  refuseUnfinished('git config', cwd, config);
  if (config.ok) return config.stdout === 'false';
  if (config.status === CONFIG_KEY_UNSET_STATUS) return process.platform === 'win32';
  throw gitNoAnswerError(cwd, 'Without core.symlinks, a link checked out as a plain file could be read as a member.');
}

/**
 * Every tracked link under `cwd` a checkout with `core.symlinks=false` writes
 * as a plain file: empty, after one `git config` read, when `core.symlinks` is
 * not false (see {@link symlinksOff}), and otherwise each index entry under
 * `cwd` whose mode, at the stage git reads ({@link STAGE_PREFERENCE}), is a link.
 *
 * @param cwd - The listed root: the index is read under it alone, so a small
 *   root in a large repository reads only its own entries
 * @returns The links' absolute, forward-slashed paths
 * @throws Coded by cause (`GIT_FAILED`, `GIT_NOT_FOUND`, `GIT_NO_ANSWER`) when
 *   git did not answer
 */
export function gitLinksCheckedOutAsFiles(cwd: string): ReadonlySet<string> {
  if (!symlinksOff(cwd)) return new Set();

  const index = runGit(['ls-files', '-s', '-z'], { cwd, trim: false, env: { LC_ALL: 'C' } });
  refuseUnfinished('git ls-files', cwd, index);
  if (!index.ok) {
    throw gitNoAnswerError(cwd, 'Without the index, a link checked out as a plain file would be read as a member.');
  }
  // `<mode> <oid> <stage>\t<path>`, NUL-separated, the path relative to `cwd`.
  const modes = new Map<string, Map<string, string>>();
  for (const record of index.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, , stage] = record.slice(0, tab).split(' ');
    if (mode === undefined || stage === undefined) continue;
    const path = record.slice(tab + 1);
    const stages = modes.get(path) ?? new Map<string, string>();
    stages.set(stage, mode);
    modes.set(path, stages);
  }
  const links = new Set<string>();
  for (const [path, stages] of modes) {
    const stage = STAGE_PREFERENCE.find((candidate) => stages.has(candidate));
    if (stage !== undefined && stages.get(stage) === GIT_MODE_SYMLINK) links.add(safePath.resolve(cwd, path));
  }
  return links;
}
