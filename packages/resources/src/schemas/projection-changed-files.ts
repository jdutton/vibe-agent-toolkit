import type { GitChangeKind } from '@vibe-agent-toolkit/utils/git';
import { z } from 'zod';

/**
 * Every change kind a `changed_files` row can carry — `GitChangeKind` in
 * `@vibe-agent-toolkit/utils/git`, which produces them. `satisfies` refuses a
 * kind utils does not produce; the lens's row mapping refuses one utils
 * produces that this list lacks.
 */
const CHANGED_FILE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'type-changed',
] as const satisfies readonly GitChangeKind[];

/**
 * A row of the derived `changed_files` relation — one file under the project
 * root that differs between a base commit (`--base <ref>`) and the tree the
 * projection holds: tracked files as they stand on disk, plus untracked files
 * git does not ignore, snapshotted as one git tree and diffed once.
 *
 * ⛔ DERIVED, never materialised: it is a function of the tree AND of the base
 * the run was given, so it exists only in the run that named both.
 */
export const ChangedFileRowSchema = z.object({
  path: z.string().min(1)
    .describe('The file, relative to the project root, POSIX-spelled. For a deletion, the path that was deleted'),
  status: z.enum(CHANGED_FILE_STATUSES)
    .describe(
      'What happened to it since the base. A move is "renamed" whether or not it was `git add`ed; a copy is "added".'
      + ' A rename crossing the root\'s boundary is reported as seen from inside the root: renamed in is "added",'
      + ' renamed out is "deleted". A file removed from the index but unchanged on disk is no row',
    ),
  oldPath: z.string().min(1).nullable()
    .describe('Where a "renamed" file came from, relative to the project root; NULL for every other status'),
  similarity: z.number().int().min(0).max(100).nullable()
    .describe('git\'s similarity score (0-100) for a "renamed" file; NULL for every other status'),
}).strict().describe('A row of the derived `changed_files` relation');

export type ChangedFileRow = z.infer<typeof ChangedFileRowSchema>;
