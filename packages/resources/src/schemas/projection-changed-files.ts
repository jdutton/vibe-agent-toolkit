import type { GitChangeKind } from '@vibe-agent-toolkit/utils/git';
import { z } from 'zod';

/**
 * Every change kind a `changed_files` row can carry — `GitChangeKind` in
 * `@vibe-agent-toolkit/utils/git`, which produces them. `satisfies` refuses a
 * kind utils does not produce; the lens's row mapping refuses one utils
 * produces that this list lacks.
 */
export const CHANGED_FILE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
] as const satisfies readonly GitChangeKind[];

/**
 * A row of the derived `changed_files` relation — one file under the project
 * root that differs between a base commit (`--base <ref>`) and the tree the
 * projection holds: tracked files as they stand on disk, plus untracked files
 * git does not ignore.
 *
 * ⛔ DERIVED, never materialised: it is a function of the tree AND of the base
 * the run was given, so it exists only in the run that named both.
 *
 * 🪤 Keyed by `(path, status)`, not `path` alone: a file removed from the index
 * (`git rm --cached`) but still on disk is both `deleted` (from tracking) and
 * `added` (untracked), and that is two true rows rather than one guessed one.
 */
export const ChangedFileRowSchema = z.object({
  path: z.string().min(1)
    .describe('The file, relative to the project root, POSIX-spelled. For a deletion, the path that was deleted'),
  status: z.enum(CHANGED_FILE_STATUSES)
    .describe(
      'What happened to it since the base. A rename or copy crossing the root\'s boundary is reported as seen from inside'
      + ' the root: renamed or copied in is "added", renamed out is "deleted", copied out is no row. An untracked file'
      + ' is "added"; git pairs only paths the index knows into a rename, so an un-added move reads as deleted + added',
    ),
  oldPath: z.string().min(1).nullable()
    .describe('Where a "renamed" or "copied" file came from, relative to the project root; NULL for every other status'),
  similarity: z.number().int().min(0).max(100).nullable()
    .describe('git\'s similarity score (0-100) for a "renamed" or "copied" file; NULL for every other status'),
}).strict().describe('A row of the derived `changed_files` relation');

export type ChangedFileRow = z.infer<typeof ChangedFileRowSchema>;
