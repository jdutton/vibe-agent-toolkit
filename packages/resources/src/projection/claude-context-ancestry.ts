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
 * ## ⛔ Membership comes from the shipped classifier
 *
 * `classifyPath`'s {@link CLAUDE_MD_TAG} rule is `CLAUDE.md` and `CLAUDE.local.md`
 * (`agentic-tags.ts`), so membership is read off the tag rather than re-spelled
 * here. A private glob would keep matching what it always matched while the
 * classifier moved on, and the drift would be silent.
 *
 * ## ⭐ Which files, in which order — the binary, not the prose
 *
 * The launch walk (`$yn`, transcribed in
 * [`docs/external/claude-code-memory-loader.md`](../../../../docs/external/claude-code-memory-loader.md))
 * visits every directory from the root down to the working directory and, in each,
 * reads `CLAUDE.md`, then `.claude/CLAUDE.md`, then that directory's
 * `.claude/rules`, then `CLAUDE.local.md`. So `.claude/CLAUDE.md` is honoured in
 * EVERY directory on the walk — an earlier reading kept it to the corpus root —
 * and a `.claude/CLAUDE.local.md` is never read for the directory above it. Each
 * entry carries the directory whose walk step reads it (`holder`) and whether it
 * is the `.local` overlay, so the query can slot that directory's rules between
 * the two halves without re-deriving either.
 *
 * `LensEntryPointRowSchema` documents *"nearest ancestor first"*; that stored
 * wording is precedence order, one `.reverse()` from this render order.
 */

import type {
  ResourceRealizationRow,
  ResourceTagRow,
} from '../schemas/projection-resources.js';

import { CLAUDE_MD_TAG } from './agentic-tags.js';

/** The second project location's directory segment. */
const DOT_CLAUDE = '.claude';

/** The `CLAUDE.local.md` basename, lowercased the way the realization column is. */
const LOCAL_BASENAME = 'claude.local.md';

/**
 * One `CLAUDE.md`-family file in a directory's chain.
 */
export interface AncestryEntry {
  readonly resourceId: string;
  /** Root-relative, forward-slashed. */
  readonly path: string;
  /** The file's own directory — `X/.claude` for `X`'s second project location. */
  readonly dir: string;
  /** The directory whose launch-walk step reads this file. */
  readonly holder: string;
  /** True for `CLAUDE.local.md`, which the walk reads after that directory's rules. */
  readonly local: boolean;
}

/**
 * The directory whose launch-walk step reads a `CLAUDE.md` in `dir` as its
 * SECOND project location — `X` for `X/.claude` — or null when `dir` is not a
 * `.claude` directory.
 *
 * @param dir - A `CLAUDE.md`'s own directory, root-relative
 * @returns The holder, `''` for the corpus root, or null
 */
export function secondLocationHolder(dir: string): string | null {
  if (dir === DOT_CLAUDE) return '';
  return dir.endsWith(`/${DOT_CLAUDE}`) ? dir.slice(0, -DOT_CLAUDE.length - 1) : null;
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
 * @returns The chain in launch-walk order — root-down, and within each
 *   directory `CLAUDE.md`, then `.claude/CLAUDE.md`, then `CLAUDE.local.md`
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
  // query INSIDE `.claude/` visits `.claude` as a directory of its own, so
  // `.claude/CLAUDE.md` is reachable as the root's second location AND as
  // `.claude`'s own `CLAUDE.md`. The harness reads it once (`processedPaths`).
  const seen = new Set<string>();
  for (const holder of ancestorDirectories(queryDir)) {
    const dotClaude = holder === '' ? DOT_CLAUDE : `${holder}/${DOT_CLAUDE}`;
    pushSorted(chain, seen, byDir.get(holder) ?? [], holder, false);
    pushSorted(chain, seen, byDir.get(dotClaude) ?? [], holder, false);
    pushSorted(chain, seen, byDir.get(holder) ?? [], holder, true);
  }
  return chain;
}

/**
 * Append one directory's entries of a single kind, path-ordered.
 *
 * @param chain - The chain being built, appended in place
 * @param seen - Identities already in the chain, added to in place
 * @param rows - One directory's `claude-md` realizations
 * @param holder - The directory whose walk step reads them
 * @param local - True to take `CLAUDE.local.md`, false to take `CLAUDE.md`
 */
function pushSorted(
  chain: AncestryEntry[],
  seen: Set<string>,
  rows: readonly ResourceRealizationRow[],
  holder: string,
  local: boolean,
): void {
  const matching = rows
    .filter((row) => (row.basenameLower === LOCAL_BASENAME) === local)
    .sort((left, right) => comparePaths(left.path, right.path));
  for (const row of matching) {
    if (seen.has(row.resourceId)) continue;
    seen.add(row.resourceId);
    chain.push({ resourceId: row.resourceId, path: row.path, dir: row.dir, holder, local });
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
