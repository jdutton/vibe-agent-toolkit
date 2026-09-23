/**
 * `isUnderRoot` — the containment question a SINK asks.
 *
 * A delete, a copy, an uninstall: each takes a path that somebody else spelled
 * (a manifest's `name:`, a `flatSkills` entry, a positional the user typed) and
 * is about to act on `join(root, that)`. The question is whether the action
 * lands inside the root, and the only honest answer comes from the
 * filesystem: `startsWith('..')` on a lexical `relative()` misses a symlink
 * inside the root that points out, refuses a member named `..cache`, and is
 * blind to a drive letter — the sweep behind this module watched all three
 * happen at exit 0.
 *
 * Both sides are canonicalized the same way, through the deepest existing
 * ancestor, so a root reached through a symlink (macOS `/tmp`, a linked
 * `~/.claude`) still contains its members, and a candidate that does not exist
 * yet is judged by where creating it would land. Absence is reported as its
 * own answer rather than folded into either side, because a delete sink and a
 * create sink want opposite things from it.
 *
 * Lexical classification of an already-relative path — a projection identity,
 * a report relativizer — is a different question with a different helper:
 * `relativeEscapesRoot` in `path-core.ts`, which touches no filesystem.
 */

import { lstatSync } from 'node:fs';
import path from 'node:path';

import { isPathAbsentError } from './errors/errno.js';
import { normalizePath, safePath, toForwardSlash } from './path-utils.js';

/**
 * Where a candidate stands relative to a root, as the filesystem sees it.
 *
 * - `inside` — the candidate exists and its realpath is a STRICT descendant of
 *   the root's realpath. A delete or copy may proceed.
 * - `outside` — its realpath (or, when it does not exist, the realpath of its
 *   deepest existing ancestor with the missing remainder re-appended) is not
 *   under the root. The root itself is `outside` too: nothing is under itself,
 *   and a sink that could delete its own root has no business here.
 * - `absent` — nothing exists at the candidate, and creating it would land
 *   inside the root. A create sink proceeds; a delete sink has nothing to do.
 */
export type Containment = 'inside' | 'outside' | 'absent';

/**
 * The canonical spelling of `target`, from its deepest existing ancestor.
 *
 * Walks up until `lstat` answers, canonicalizes THAT with the same realpath
 * every path helper uses, and re-appends the missing tail. A refusal is not
 * an absence: `EACCES` on an ancestor, `ELOOP` on a cycle, an invalid name —
 * the OS is saying it cannot examine the path, and a containment verdict
 * built on the spelling it refused is the bug this module exists to remove.
 * Those stay loud.
 *
 * `lstat` rather than `stat`, so a dangling symlink counts as existing: it is
 * an entry the sink can act on (a delete removes the link), and its realpath
 * failing is answered by {@link normalizePath} with the lexical spelling, which
 * is where the entry is.
 */
function canonicalFromAncestor(target: string): { canonical: string; exists: boolean } {
  const absolute = safePath.resolve(target);
  const missing: string[] = [];
  let candidate = absolute;
  for (;;) {
    if (entryExists(candidate)) {
      return {
        canonical: safePath.join(toForwardSlash(normalizePath(candidate)), ...missing),
        exists: missing.length === 0,
      };
    }
    const parent = toForwardSlash(path.dirname(candidate));
    // Fixpoint at a filesystem root: `dirname` returns its own input, nothing
    // on the path resolved, and the lexical form is the only answer there is.
    if (parent === candidate) {
      return { canonical: absolute, exists: false };
    }
    missing.unshift(path.basename(candidate));
    candidate = parent;
  }
}

/**
 * The canonical (realpath) spelling of `target`, whether or not it exists.
 *
 * The same canonicalization {@link isUnderRoot} applies to both of its sides,
 * exposed for a caller that must COMPARE two spellings rather than ask a
 * containment question — a root discovered from the physical `process.cwd()`
 * against a path the operator typed through a symlink (macOS `/tmp` →
 * `/private/tmp`). A missing target is canonicalized from its deepest existing
 * ancestor with the missing tail re-appended.
 *
 * @param target - Absolute, or relative to cwd; either separator
 * @returns The canonical spelling, forward-slashed
 * @throws When the OS refuses to examine the path for any reason but absence
 */
export function canonicalPath(target: string): string {
  return canonicalFromAncestor(target).canonical;
}

/** Whether an entry (a file, a directory, or a link — dangling or not) is at `p`. */
function entryExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw error;
  }
}

/**
 * Is `candidate` strictly under `root`, as the filesystem judges it?
 *
 * Both paths may be relative (resolved from cwd) or absolute, in either
 * separator; neither has to exist. See {@link Containment} for the three
 * answers and which sinks accept which.
 *
 * ⚠️ Costs one `lstat` per missing component plus two `realpath`s. That is
 * nothing for a sink — a delete or a copy dwarfs it — and too much for a loop
 * over every link in a corpus, which is why the projection and link lanes
 * classify lexically with `relativeEscapesRoot` and never call this.
 *
 * @param root - The directory the action must stay inside
 * @param candidate - The path the action is about to touch
 * @returns `'inside'`, `'outside'`, or `'absent'`
 * @throws When the OS refuses to examine either path for any reason but
 *   absence — a refusal is reported, never read as "not there"
 *
 * @example
 * // A delete sink: only an existing, contained target may go.
 * if (isUnderRoot(skillsDir, target) !== 'inside') throw new Error(`refusing to remove ${target}: not inside ${skillsDir}`);
 * await rm(target, { recursive: true, force: true });
 *
 * // A create sink: absent-but-contained is exactly the happy path.
 * if (isUnderRoot(skillsDir, dest) === 'outside') throw new Error(`refusing to install to ${dest}: not inside ${skillsDir}`);
 */
export function isUnderRoot(root: string, candidate: string): Containment {
  const rootReal = canonicalFromAncestor(root).canonical;
  const target = canonicalFromAncestor(candidate);
  const prefix = rootReal.endsWith('/') ? rootReal : `${rootReal}/`;
  if (!target.canonical.startsWith(prefix)) {
    return 'outside';
  }
  return target.exists ? 'inside' : 'absent';
}
