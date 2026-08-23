/**
 * The `CLAUDE.md` chain for one directory — the launch-time half of the answer.
 *
 * ## This is a lens evaluation, not a table
 *
 * Ruling B declined to materialise `lens_entry_points`: `projection.ts:85-91` and
 * `docs/architecture/zones.md:358` both state that entry points are the derived
 * output of evaluating a lens rather than rows a contributor emits. So the chain
 * is computed here, on demand, and nothing stores it. Walking up ~5 directory
 * levels against a path-keyed map is microseconds.
 *
 * ## The chain, not the closure
 *
 * Imports live in the `claude-import` extents and are joined by the query. An
 * imported file is not an ancestor: expanding them here would duplicate one
 * `README.md` across hundreds of entries and break the column's meaning. This
 * matches the vendor's own split — files ABOVE the working directory load at
 * launch, files in subdirectories BELOW load on demand when Claude reads there —
 * so the ancestry of `D` IS the launch-time set for a session started in `D`.
 *
 * ## ⛔ Exactly two basenames, and membership comes from the shipped classifier
 *
 * *"checking each directory along the way for `CLAUDE.md` and `CLAUDE.local.md`
 * files."* `classifyPath`'s {@link CLAUDE_MD_TAG} rule is precisely those two
 * spellings (`agentic-tags.ts` — `b === 'claude.md' || b === 'claude.local.md'`),
 * so membership is read off the tag rather than re-spelled here. A private glob
 * would keep matching what it always matched while the classifier moved on, and
 * the drift would be silent.
 *
 * `.claude/CLAUDE.md` is honoured at the corpus ROOT only. An earlier draft added
 * it to every ancestor, which read a documented DISJUNCTION (*"a project
 * CLAUDE.md can be stored in either `./CLAUDE.md` or `./.claude/CLAUDE.md`"*) as
 * a conjunction and promoted a project-root location into a per-directory one.
 * Neither is documented.
 *
 * ## Order is root-down, and it is decided HERE because it is decided at render
 *
 * *"Across the directory tree, content is ordered from the filesystem root down
 * to your working directory. […] Within each directory, `CLAUDE.local.md` is
 * appended after `CLAUDE.md`."* `LensEntryPointRowSchema` documents the opposite
 * — *"nearest ancestor first"* — and Ruling B left that STORED wording untouched,
 * because precedence order and render order are different consumers one
 * `.reverse()` apart. Nothing is stored here, so this returns render order.
 *
 * ⚠️ The order of `./CLAUDE.md` against `./.claude/CLAUDE.md` is an ASSUMPTION,
 * recorded in `claude-context-limits.ts`. The vendor documents the two as
 * alternative locations and never their relative order; do not cite it for this.
 */

import type {
  ResourceRealizationRow,
  ResourceTagRow,
} from '../schemas/projection-resources.js';

import { CLAUDE_MD_TAG } from './agentic-tags.js';

/** The corpus-root-only second project location, as `resource_realizations.dir` spells it. */
const ROOT_DOT_CLAUDE_DIR = '.claude';

/** The `CLAUDE.local.md` basename, lowercased the way the realization column is. */
const LOCAL_BASENAME = 'claude.local.md';

/**
 * One `CLAUDE.md`-family file in a directory's chain.
 */
export interface AncestryEntry {
  readonly resourceId: string;
  /** Root-relative, forward-slashed. */
  readonly path: string;
  /** The directory that put it in the chain — `.claude` for the root's second location. */
  readonly dir: string;
}

/**
 * Every directory from the corpus root down to `queryDir`, inclusive, in that order.
 *
 * Root-down rather than nearest-first because that is the order the answer is
 * rendered in, and reversing at the consumer would put the vendor's one
 * externally-referenced ordering behind a call nobody remembers to make.
 *
 * @param queryDir - Root-relative directory, `''` for the corpus root
 * @returns Root-relative directories, corpus root (`''`) first
 */
export function ancestorDirectories(queryDir: string): string[] {
  if (queryDir === '') return [''];
  // eslint-disable-next-line local/no-hardcoded-path-split -- queryDir is root-relative and forward-slashed, per resource_realizations.dir's own convention
  const segments = queryDir.split('/');
  const dirs = [''];
  for (let index = 0; index < segments.length; index += 1) {
    dirs.push(segments.slice(0, index + 1).join('/'));
  }
  return dirs;
}

/**
 * The `CLAUDE.md` chain a session started in `queryDir` loads at launch.
 *
 * @param realizations - Every realization the projection holds
 * @param tags - Every `resource_tags` row; membership is the {@link CLAUDE_MD_TAG} rows
 * @param queryDir - Root-relative directory, `''` for the corpus root
 * @returns The chain in vendor load order — root-down, `CLAUDE.local.md` after
 *   `CLAUDE.md` within each directory, and the root's `.claude/CLAUDE.md`
 *   between the two
 */
export function claudeAncestry(
  realizations: readonly ResourceRealizationRow[],
  tags: readonly ResourceTagRow[],
  queryDir: string,
): AncestryEntry[] {
  const claudeMd = new Set(
    tags.filter((row) => row.tag === CLAUDE_MD_TAG).map((row) => row.resourceId),
  );
  const byDir = new Map<string, ResourceRealizationRow[]>();
  for (const row of realizations) {
    if (row.isDirectory || !claudeMd.has(row.resourceId)) continue;
    const rows = byDir.get(row.dir);
    if (rows === undefined) byDir.set(row.dir, [row]); else rows.push(row);
  }

  const chain: AncestryEntry[] = [];
  // ⚠️ Deduplicated by identity, and the case is real rather than defensive: a
  // query INSIDE `.claude/` puts `.claude` in the ancestor list, so
  // `.claude/CLAUDE.md` would be admitted twice — once by the directory loop and
  // once by the corpus-root special case below. Two entries for one file would
  // then be summed twice by any consumer that trusted the array.
  const seen = new Set<string>();
  for (const dir of ancestorDirectories(queryDir)) {
    // `CLAUDE.md` first, then the root's second project location, then the
    // `.local` overlay — see the header for which third of that order is cited
    // and which two thirds are assumed.
    pushSorted(chain, seen, byDir.get(dir) ?? [], false);
    if (dir === '') pushSorted(chain, seen, byDir.get(ROOT_DOT_CLAUDE_DIR) ?? [], false);
    pushSorted(chain, seen, byDir.get(dir) ?? [], true);
  }
  return chain;
}

/**
 * Append one directory's entries of a single kind, path-ordered.
 *
 * @param chain - The chain being built, appended in place
 * @param seen - Identities already in the chain, added to in place
 * @param rows - That directory's `claude-md` realizations
 * @param local - True to take `CLAUDE.local.md`, false to take `CLAUDE.md`
 */
function pushSorted(
  chain: AncestryEntry[],
  seen: Set<string>,
  rows: readonly ResourceRealizationRow[],
  local: boolean,
): void {
  const matching = rows
    .filter((row) => (row.basenameLower === LOCAL_BASENAME) === local)
    .sort((left, right) => comparePaths(left.path, right.path));
  for (const row of matching) {
    if (seen.has(row.resourceId)) continue;
    seen.add(row.resourceId);
    chain.push({ resourceId: row.resourceId, path: row.path, dir: row.dir });
  }
}

/**
 * Order two root-relative paths by UTF-16 code point.
 *
 * ⚠️ Deliberately NOT `String.localeCompare`, which sonarjs suggests by default:
 * it is ICU- and locale-dependent, so two machines could order one directory's
 * two files differently — and this array's order IS the answer's order.
 * `claude-import-extent.ts:169-185` refuses it on the same ground.
 *
 * @param left - One root-relative path
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
