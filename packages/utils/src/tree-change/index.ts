/** The plan/apply tree-change primitive: entry identity, the readable-tree proof and the copy, the planner, the applier and the file helpers. */
export { entryIdentities, isInsideByIdentity, sameEntry } from './identity.js';
export type { EntryContainment, EntrySameness, Identity } from './identity-compare.js';
export {
  COPY_LINK_ESCAPES_SOURCE_CODE,
  CopyLinkEscapesSourceError,
  DIRECTORY_WALK_REVISITED_CODE,
  DirectoryWalkRevisitedError,
  FollowedWalk,
} from './followed-walk.js';
export { proveTreeReadable, readRegularFile } from './readable-tree.js';
export type { ProveTreeReadableOptions } from './readable-tree.js';
export { copyRegularFile, copyTree } from './copy-tree.js';
export type { CopyRegularFileOptions, CopyTreeOptions } from './copy-tree.js';
export type { CopyOnto } from './copy-decisions.js';
export type { LinkPolicy, TreeWalkOptions } from './tree-walk.js';
export {
  planTreeChanges,
  TREE_DEST_HOLDS_SOURCE_CODE,
  TREE_DEST_NOT_OWNED_CODE,
  TREE_DEST_OCCUPIED_CODE,
  TREE_DESTS_OVERLAP_CODE,
  TREE_SOURCE_HOLDS_DEST_CODE,
} from './plan.js';
export type { EntryKind, FileContents, Ownership, OwnershipVerdict, PlannedAction, PlannedChange, TreeChange, TreeFill, TreePlan } from './plan.js';
export { applyTreePlan, applyTreePlanOrLeftover, TREE_CLEANUP_INCOMPLETE_CODE } from './apply.js';
export { TREE_ROLLBACK_INCOMPLETE_CODE, TreeRollbackIncompleteError } from './rollback-error.js';
export type { TreeRollbackStranded } from './rollback-error.js';
export type { ApplyOptions, ApplyOutcome, ApplyResult, TreeChangeWarning } from './apply.js';
export type { TempDirOutcome } from './files.js';
export { disposeTempDir, disposeTempDirAfterFailure, makeDirectoryUnder, renameFileAtomic, replaceFile, TEMP_DIR_OUTSIDE_TMPDIR_CODE, withTempDir, writeFileUnder } from './files.js';
export { isParkedTreeEntry, isTreeChangeResidue } from './staging-names.js';
