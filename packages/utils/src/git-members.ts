/**
 * A tree key's members: the files whose content key is their git object name, read from git's object
 * store rather than from disk.
 *
 * A member is an entry of a {@link GitTreeKey} with mode `100644` or `100755`, except:
 * - symlinks (`120000`) and submodules (`160000`): no blob of file bytes;
 * - absent skip-worktree entries ({@link GitTreeKey.absent}): no file is there;
 * - every Git LFS pointer path ({@link GitTreeKey.lfs}): a pulled file's bytes are not the
 *   pointer's object, so it stays keyed from disk.
 *
 * Its key kind follows the object name's length: 40 hex is `git-sha1`, 64 is `git-sha256`. A path
 * is a member only at the absolute spelling the snapshot gives it; any other spelling misses and is
 * keyed from disk, which is always sound, never shared.
 *
 * A partial clone on a git that cannot refuse a lazy fetch (before 2.45) has no members: a read
 * could otherwise download. So has one whose partial-clone probe gave no answer: it may be one. The
 * run then keys every file from disk, and says so once per repository.
 */

import { isPartialClone } from './git-changed-files.js';
import { GitObjectMissingError, type GitObjectReaders } from './git-object-reader.js';
import type { GitTreeKey } from './git-snapshot.js';
import { shownName } from './shown-text.js';

/** The kind of content key a member carries, by its object name's length. */
export type GitMemberKeyKind = 'git-sha1' | 'git-sha256';

/** One member: its object name and the key kind that name is. */
export interface GitMember {
  readonly oid: string;
  readonly keyKind: GitMemberKeyKind;
}

/** A tree key's members; see the module header. Data only: bytes are read through the reader it was given. */
export interface GitMembers {
  readonly repositoryRoot: string;
  /** The member at this absolute spelling, or undefined (then the path is keyed from disk). */
  memberAt(absolutePath: string): GitMember | undefined;
  /**
   * The member's size, from one `cat-file --batch-check` over every member on the first ask.
   *
   * @returns The size; rejects with that member's `GitObjectMissingError` when git does not hold it
   */
  sizeOf(member: GitMember): Promise<number>;
  /** The member's bytes, from git's object store. */
  bytesOf(member: GitMember): Promise<Uint8Array>;
}

/** The modes of a file whose bytes are one blob. */
const REGULAR_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

/** Key kind by object-name length. */
const KEY_KIND_BY_LENGTH: ReadonlyMap<number, GitMemberKeyKind> = new Map([
  [40, 'git-sha1'],
  [64, 'git-sha256'],
]);

/** The repository roots this process has said key from disk as a (possible) partial clone. */
const noticed = new Set<string>();

/**
 * Say once per repository that a partial clone's files key from disk.
 *
 * @param partial - true for a partial clone, undefined when git could not say whether it is one
 */
function noticePartialClone(repositoryRoot: string, partial: true | undefined): void {
  if (noticed.has(repositoryRoot)) return;
  noticed.add(repositoryRoot);
  const is = partial === true ? 'is a partial clone' : 'may be a partial clone (git could not say whether it is one)';
  process.emitWarning(
    `${shownName(repositoryRoot)} ${is}, and this git (before 2.45) has no --no-lazy-fetch, so reading`
      + ' its objects could fetch them: VAT keys its files from disk instead. Git 2.45 or later reads them from git.',
    { type: 'VatNotice', code: 'VAT_GIT_MEMBERS_PARTIAL_CLONE' },
  );
}

/** The key kind of `oid`, the one every member before it shares. */
function keyKindOf(repositoryRoot: string, oid: string, shared: GitMemberKeyKind | undefined): GitMemberKeyKind {
  const kind = KEY_KIND_BY_LENGTH.get(oid.length);
  if (kind === undefined) throw new Error(`the snapshot of ${shownName(repositoryRoot)} holds an object name ${JSON.stringify(oid)} of neither 40 nor 64 hex`);
  if (shared !== undefined && kind !== shared) {
    throw new Error(`the snapshot of ${shownName(repositoryRoot)} holds both ${shared} and ${kind} object names`);
  }
  return kind;
}

class MemberSet implements GitMembers {
  private sized: Promise<ReadonlyMap<string, number>> | undefined;
  private readonly oids: ReadonlySet<string>;

  constructor(
    readonly repositoryRoot: string,
    private readonly members: ReadonlyMap<string, GitMember>,
    private readonly objects: GitObjectReaders,
  ) {
    this.oids = new Set([...members.values()].map(({ oid }) => oid));
  }

  memberAt(absolutePath: string): GitMember | undefined {
    return this.members.get(absolutePath);
  }

  async sizeOf(member: GitMember): Promise<number> {
    if (!this.oids.has(member.oid)) throw new Error(`${member.oid} is not a member of ${shownName(this.repositoryRoot)}`);
    this.sized ??= this.objects.sizes(this.repositoryRoot, [...this.oids]);
    const size = (await this.sized).get(member.oid);
    if (size === undefined) throw new GitObjectMissingError(this.repositoryRoot, member.oid);
    return size;
  }

  bytesOf(member: GitMember): Promise<Uint8Array> {
    return this.objects.read(this.repositoryRoot, member.oid);
  }
}

/**
 * The members of a tree key; see the module header.
 *
 * @param key - The tree's key
 * @param objects - The run's object readers, which every size and read goes through
 * @returns The members, or null for a partial clone (or a repository git cannot say is not one) on a
 *   git before 2.45
 * @throws {Error} For an object name of neither length, or of both lengths in one snapshot
 */
export function gitMembersOf(key: GitTreeKey, objects: GitObjectReaders): GitMembers | null {
  if (!objects.guardsLazyFetch()) {
    const partial = isPartialClone(key.repositoryRoot);
    if (partial !== false) {
      noticePartialClone(key.repositoryRoot, partial);
      return null;
    }
  }
  const excluded = new Set([...key.absent, ...key.lfs.pointers.map(({ absolutePath }) => absolutePath)]);
  const members = new Map<string, GitMember>();
  let shared: GitMemberKeyKind | undefined;
  for (const entry of key.entries) {
    if (!REGULAR_MODES.has(entry.mode) || excluded.has(entry.absolutePath)) continue;
    shared = keyKindOf(key.repositoryRoot, entry.oid, shared);
    members.set(entry.absolutePath, { oid: entry.oid, keyKind: shared });
  }
  return new MemberSet(key.repositoryRoot, members, objects);
}
