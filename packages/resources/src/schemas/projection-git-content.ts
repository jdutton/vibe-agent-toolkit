/**
 * The git content relation: which paths are git's own content under an analysis root. Derived per
 * run from the run's memoized snapshot through the one membership function the git crawl is built
 * on (`gitContentMembers`), never stored.
 */

import { z } from 'zod';

/** A row of the derived `git_content` relation: one per path git holds as content under the root. */
export const GitContentRowSchema = z.object({
  root: z.string().describe('The id of the root the path is under'),
  repository: z.string().describe('The repository the path belongs to, relative to the analysis root: `\'\'` for the repository the root is in'),
  path: z.string().describe('The path, relative to its root: a tracked file present in the worktree, or an untracked file no ignore rule covers; a symlink is one listed name, nothing beneath a directory link. Never an ignored file, a tracked file deleted from the worktree, a skip-worktree file absent from disk, or a submodule\'s gitlink'),
}).strict().describe('A row of the derived `git_content` relation');

export type GitContentRow = z.infer<typeof GitContentRowSchema>;
