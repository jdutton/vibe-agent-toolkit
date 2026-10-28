/**
 * What the flat-skill install verbs — `vat claude plugin install` (its skill lanes), `vat agent install` and
 * `vat skills install` — share about planning an install onto the tree-change primitive: the
 * one change a skill copy is, the one link policy of a tree an install copies from, the one
 * refusal an occupied destination is, and the one way an archive's `$TMPDIR` staging is disposed of.
 */

import { hostAddedToSkillZip, type SkillZipEntry, skillZipLayout } from '@vibe-agent-toolkit/agent-skills';
import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import {
  CopyLinkEscapesSourceError,
  type FsSide,
  HOST_PATH_FLAVOR,
  isVatError,
  type LinkPolicy,
  normalizePath,
  type Ownership,
  refuseEscapingLinks,
  safePath,
  toForwardSlash,
  TREE_DEST_OCCUPIED_CODE,
  type TreeChange,
  treeChain,
  treeContainment,
  withFsFaultSync,
  withTempDir,
} from '@vibe-agent-toolkit/utils';
import { ARCHIVE_LIMITS, extractArchive } from '@vibe-agent-toolkit/utils/archive';

import { CommandRefusalError, errorMessageOf } from './command-refusal.js';
import { leftoverIssue } from './document-writer.js';

/** The ownership of a skill destination: `--force` takes whatever is there; otherwise it must be free. */
export function skillOwnership(force: boolean): Ownership {
  return force ? { kind: 'force' } : { kind: 'must-be-free' };
}

/**
 * The link policy of a tree an install copies from, by the side it is on.
 *
 * - `environment` — VAT's own staging, holding what the archive module extracted: files and
 *   directories, never a link. So a link found there is `refuse`d — never followed, never
 *   copied — and an archive lane cannot install what its archive did not hold.
 * - anything else — a directory the operator named. Its links are kept as links (`preserve`),
 *   each already held inside the tree it is copied with ({@link installUnit}).
 */
export function installLinks(side: FsSide): LinkPolicy {
  return side === 'environment' ? 'refuse' : 'preserve';
}

/** Where an install reads from: the directory the operator named (or VAT's staging), and the side it is on. */
interface InstallSourceTree {
  readonly root: string;
  readonly side: FsSide;
}

/**
 * One tree an install is about to copy — a skill, a marketplace, a plugin — as the directory to
 * copy it from, refused when copying it would install something its source does not hold.
 *
 * A staged tree (`environment`) is returned as it is: it holds no link ({@link installLinks}).
 * A tree in the operator's own directory is judged twice, because a copy keeps its links as
 * links, verbatim:
 *
 * - `dir` itself may be a link (a skill directory linked into `dist/skills/`), but only to
 *   somewhere inside the directory the operator named;
 * - no link inside it may lead outside it — `keys -> ../../../secret` stays inside the package
 *   it was written in and points at the installing user's own files once it is installed.
 *
 * @param tree - The directory the operator named, and its side
 * @param dir - The tree to copy: `tree.root` or a directory found under it
 * @param what - What the tree is, for the refusal: `the skill directory`
 * @returns The directory to copy from: `dir`, or for an operator's tree its real path, so the copy's root is never a link
 * @throws VatError `COPY_LINK_ESCAPES_SOURCE` (`INPUT_UNREADABLE`) naming the link; FsFaultError on
 *   the tree's side when the OS refuses to examine it
 */
export function installUnit(tree: InstallSourceTree, dir: string, what: string): string {
  if (tree.side === 'environment') return dir;
  return withFsFaultSync({ side: tree.side, origin: 'content', action: `examine the links of ${what} ${dir}`, path: dir }, () => {
    // `dir` may itself be a link, or below one: its chain is read by text first (the one resolver),
    // so the kernel never resolves a link to a network path, or one leaving the tree, to answer this.
    if (treeChain(tree.root, dir, HOST_PATH_FLAVOR).kind === 'refused') throw new CopyLinkEscapesSourceError(dir, tree.root);
    // An absent `dir` is not this check's to name: resolving it below raises the OS's own answer.
    if (treeContainment(tree.root, dir) === 'outside') throw new CopyLinkEscapesSourceError(dir, tree.root);
    const real = toForwardSlash(normalizePath(dir));
    refuseEscapingLinks({
      root: real,
      placement: 'relocated',
      side: tree.side,
      flavor: HOST_PATH_FLAVOR,
      tree: `${what} ${dir}`,
      within: 'it',
      consequence: 'An install keeps a link as a link, so once installed this one would point at files its source does not hold',
    });
    return real;
  });
}

/**
 * One skill copied whole into place, every read of `source` classified on `side` — the
 * operator's tree (`source`) or VAT's own staging an archive was extracted into (`environment`)
 * — and its links held to that side's policy ({@link installLinks}).
 */
export function skillCopyChange(skill: { readonly name: string; readonly source: string; readonly dest: string }, side: FsSide, force: boolean): TreeChange {
  return {
    op: 'replace',
    dest: skill.dest,
    ownership: skillOwnership(force),
    fill: { from: 'copy', source: skill.source, side, links: installLinks(side) },
    label: `skill ${skill.name}`,
  };
}

/**
 * Where the skill is inside a skill ZIP, by the ONE layout rule every verb that takes one shares
 * (`skillZipLayout`: `SKILL.md` at the top level, or directly inside the archive's single
 * top-level folder) — or the refusal of an archive that is neither. The archive is the input, so
 * the refusal is `INPUT_UNREADABLE`, decided from the entry list before anything is installed or sent.
 *
 * @param zipPath - The archive the operator named, for the message
 * @param entries - Every entry of the archive, as `extractArchive` / `openArchive` list them
 * @returns The folder the skill is in, relative to the archive's top level: `''`, or the one top-level folder
 * @throws CommandRefusalError `INPUT_UNREADABLE`
 */
export function requireSkillZipLayout(zipPath: string, entries: readonly SkillZipEntry[]): string {
  const layout = skillZipLayout(entries);
  if ('refused' in layout) throw new CommandRefusalError('INPUT_UNREADABLE', `${zipPath} is not a skill ZIP, nothing was changed: ${layout.refused}.`);
  return layout.root;
}

/**
 * Extract a skill ZIP into `into`, a fresh staging directory, and answer where the skill is in it.
 * The ONE extraction of a skill ZIP, for every verb that takes one: held to the archive policy and
 * limits, to the one layout rule ({@link requireSkillZipLayout}), and written WITHOUT what the
 * host that made the archive added beside the skill (`hostAddedToSkillZip`: a top-level
 * `__MACOSX/`, a `.DS_Store`) — the layout rule does not count those, so nothing installs or
 * sends them.
 *
 * @param zipPath - The archive the operator named
 * @param into - VAT's staging directory to extract into
 * @returns The skill's directory: `into`, or the archive's one top-level folder under it
 * @throws ArchiveRefusedError or CommandRefusalError (`INPUT_UNREADABLE`) for an archive VAT does not
 *   take, with nothing written; FsFaultError as `extractArchive` raises it
 */
export async function extractSkillZip(zipPath: string, into: string): Promise<string> {
  const entries = await extractArchive({ file: zipPath, side: 'source' }, into, { format: 'zip', limits: ARCHIVE_LIMITS, omit: (entry) => hostAddedToSkillZip(entry.name) });
  return safePath.join(into, requireSkillZipLayout(zipPath, entries));
}

/** A destination taken without `--force`, as the invocation's refusal saying how to proceed; anything else as itself. */
export function occupiedRefusal(error: unknown): unknown {
  if (!isVatError(error, TREE_DEST_OCCUPIED_CODE)) return error;
  return new CommandRefusalError('USAGE_INVALID', `Something already exists where the install goes: ${error.message}. Use --force to overwrite.`, { cause: error });
}

/**
 * Run `work` in a fresh staging directory under `$TMPDIR` (`withTempDir`), disposed of after. A
 * directory that will not go once `work` finished is not a refusal of the install it outlived:
 * it is handed to `onLeftover` as the warning naming it. A failure of `work` is rethrown, the
 * staging's own leftover recorded beside it (`suppressedFaultsOf`).
 *
 * @param prefix - The `mkdtemp` prefix, so a leaked directory names its owner
 * @param work - Given the staging directory
 * @param onLeftover - Given the warning for a staging directory that outlived a finished `work`
 */
export async function inStaging(prefix: string, work: (dir: string) => Promise<void>, onLeftover: (issue: ValidationIssue) => void): Promise<void> {
  const { value: stagedIn, leftover } = await withTempDir(prefix, async (dir) => {
    await work(dir);
    return dir;
  });
  if (leftover === undefined) return;
  onLeftover(leftoverIssue(`The install is complete, but its staging directory ${stagedIn} could not be removed: ${errorMessageOf(leftover)}`, stagedIn));
}
