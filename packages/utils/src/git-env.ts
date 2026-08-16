/**
 * Which `GIT_*` variables redirect a child `git` away from the directory it was
 * handed, and how to remove them.
 *
 * ## This is not hypothetical, and it is worse in a worktree
 *
 * `vat resources validate` is invoked from `vibe-validate`'s `pre-commit`, so
 * VAT's git children routinely execute two levels inside `git commit`. Measured
 * 2026-08-16 against real hooks:
 *
 * - A **plain repository's** pre-commit hook exports `GIT_INDEX_FILE=.git/index`
 *   (relative), `GIT_PREFIX`, `GIT_AUTHOR_*`, `GIT_CONFIG_PARAMETERS`,
 *   `GIT_EDITOR` and `GIT_EXEC_PATH` — but **not** `GIT_DIR`. Enumerating
 *   another tree from there happened to give the right answer.
 * - A **worktree's** pre-commit hook exports `GIT_DIR` and `GIT_INDEX_FILE` as
 *   *absolute* paths into `<main>/.git/worktrees/<name>`. Asked about an
 *   unrelated repository from inside one, `gitLsFiles` returned **the files of
 *   the repository being committed** — a well-formed answer about the wrong
 *   tree. With the environment removed, the same call was correct.
 *
 * Most VAT work happens in worktrees, so the second case is the ordinary one.
 *
 * ## The list is a deletion list, not an override list
 *
 * Removal must be by `delete`, never by setting `''`: git treats an empty
 * `GIT_DIR` as a real (empty) value and fails repository discovery outright.
 * Spreading a filtered environment back over `process.env` re-injects everything
 * it just removed, which is the same mistake wearing different clothes.
 *
 * ## Where the list came from
 *
 * The union of VAT's original list and `@vibe-validate/core`'s
 * `DANGEROUS_GIT_ENV_KEYS`, which vibe-validate accumulated the hard way. When
 * VAT takes a runtime dependency on `@vibe-validate/git` (which now exports
 * `stripGitEnv`), this module should become a re-export or disappear — the
 * hazard knowledge is worth sharing even though the commands are not.
 */

/**
 * Every variable that can retarget, rescope or reconfigure a child `git`.
 *
 * Grouped by what each one does, because the grouping is the argument for
 * membership: a variable belongs here if it changes *which repository*, *which
 * paths*, or *which config* the child sees — not merely if it starts with
 * `GIT_`. Identity, editor, SSH, credential and tracing variables are
 * deliberately absent; none of them can move the answer, and dropping them
 * breaks legitimate setups.
 */
export const INHERITED_GIT_ENV = [
  // Repository / index / worktree redirection
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  // Ref namespace redirection
  'GIT_NAMESPACE',
  // Repository discovery
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  // Pathspec rescoping: git prepends GIT_PREFIX when interpreting a pathspec,
  // so an inherited value silently re-scopes a child that runs at the root.
  'GIT_PREFIX',
  // The ONE config variable git sets by itself: it carries the outer
  // invocation's `-c` flags into every hook and every hook's children, so an
  // injected `core.excludesFile` silently changes which paths a child's
  // `--exclude-standard` reports. Nobody opted into it, so removing it takes
  // nothing away.
  //
  // Its siblings — GIT_CONFIG, GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM,
  // GIT_CONFIG_NOSYSTEM, GIT_CONFIG_COUNT and the numbered KEY_/VALUE_ groups —
  // are deliberately NOT here. Measured on git 2.50.1: git never sets any of
  // them, in a plain repository or a worktree, with or without `-c` flags. They
  // appear only when an operator put them there, and they are the documented
  // env-only channel (git >= 2.31) that CI uses to point github.com at an
  // internal mirror or to supply credentials. Stripping them defends against
  // nothing git does and makes VAT the one tool on the box that ignores the
  // operator's git configuration — silently, which is how a clone that should
  // have gone to a mirror goes to the internet instead.
  'GIT_CONFIG_PARAMETERS',
  // History view
  'GIT_NOTES_REF',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  // On-disk format of any index the child writes
  'GIT_INDEX_VERSION',
] as const;

/**
 * The ambient environment with every inherited git redirection removed.
 *
 * Call this for any `git` child that must target a **caller-supplied path**.
 * Commands that genuinely mean "the repository I am in" are correct to inherit;
 * everything VAT does is the former, because VAT is handed a project root.
 *
 * @param overrides - Variables to set *after* the strip, so a deliberate
 *   `GIT_INDEX_FILE` survives while an inherited one does not
 * @returns A fresh environment object for one git child
 */
export function cleanGitEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of INHERITED_GIT_ENV) {
    // Deleted, not set to '': git treats an empty GIT_DIR as a real (empty)
    // value and fails to discover a repository at all.
    delete env[name];
  }
  return { ...env, ...overrides };
}
