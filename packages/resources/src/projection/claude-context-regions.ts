/**
 * The region model: every working location that inherits ONE instruction chain,
 * grouped under the directory whose chain they all pay.
 *
 * ## Why this is a primitive rather than a private helper
 *
 * `claude-context-budget-sweep.ts` needs it to answer "what does every directory
 * load at launch" from a handful of queries, and `claude-context-cost-map.ts`
 * needs it to report the always-loaded half ONCE per chain rather than once per
 * directory. Two private copies of one collapse are two models that can drift,
 * and the whole reason the collapse is allowed to exist is that it is checked
 * against `whatLoadsAt` by a differential oracle — an oracle that only guards the
 * copy it was written against. So the collapse lives here, once.
 *
 * ## The collapse, and why it is sound
 *
 * A directory's always-loaded set is every `claude-md`-tagged file in its
 * ancestors (inclusive) plus those files' one-hop `@` imports. So **a directory
 * containing no `claude-md` file of its own pays exactly what its nearest
 * instructed ancestor pays**, falling back to the corpus root. Measured on VAT's
 * own tree: 589 working locations, **9** distinct chains.
 *
 * The three things that look like they should break it — an unscoped root rule,
 * the root's second `.claude/CLAUDE.md` project location, and a gitignored
 * `CLAUDE.md` — are argued at length in `claude-context-budget-sweep.ts`'s module
 * docstring and not restated here. The short form: the first two are CONSTANTS
 * across every query directory, and a constant cannot separate two groups; the
 * third can no longer arrive, because `buildClaudeContextPopulation` declines the
 * ignored half outright.
 *
 * ⛔ **The collapse is the ALWAYS half only.** Path-scoped rules genuinely vary
 * per directory — a `paths:` glob is admitted to a directory query iff some
 * realized file under THAT directory matches — so a consumer must never borrow a
 * region-mate's on-demand total. `claude-context-cost-map.ts` queries every
 * directory for that half and says so in its own docstring; this module reports
 * the grouping and takes no position on what a caller does with it.
 *
 * ## The gitignored asymmetry is deliberate
 *
 * Representatives are derived from ALL realizations; working locations apply the
 * `gitignored` filter. Which locations are REPORTED is a separate question from
 * what the harness loads: filtering both would give the directories beneath an
 * instructed-but-ignored `CLAUDE.md` their grandparent's chain, which is a wrong
 * number rather than a missing one. Nothing the context population emits is
 * `gitignored` today, so the two sets agree — the asymmetry is kept because it is
 * the correct one, not because it currently matters, and the filter itself is
 * kept unconditionally as the backstop if the decline predicate and
 * `collectRealization`'s column ever drift.
 */

import { CLAUDE_MD_TAG } from './agentic-tags.js';
import { ancestorDirectories } from './claude-context-ancestry.js';
import type { Projection } from './projection.js';

/** One region of the tree: every working location that inherits one instruction chain. */
export interface ContextRegion {
  /** The instructed directory whose chain this region pays. `''` is the corpus root. */
  readonly representative: string;
  /** Every working location in the region, sorted by code point. Includes the representative. */
  readonly locations: readonly string[];
}

/**
 * Group every working location under the instruction chain it inherits.
 *
 * @param projection - A populated projection from `buildClaudeContextPopulation`
 * @returns One region per distinct chain, sorted by `representative` (code
 *   point), each carrying its locations in the same order. Every working
 *   location appears in exactly one region
 */
export function contextRegions(projection: Projection): readonly ContextRegion[] {
  const instructedDirs = instructedDirectories(projection, claudeMdIdentities(projection));
  const grouped = new Map<string, string[]>();

  // `workingLocations` is already code-point sorted, so each group is built in
  // that order and never needs re-sorting.
  for (const directory of workingLocations(projection)) {
    const representative = representativeFor(directory, instructedDirs);
    const locations = grouped.get(representative);
    if (locations === undefined) grouped.set(representative, [directory]);
    else locations.push(directory);
  }

  return [...grouped.entries()]
    .map(([representative, locations]) => ({ representative, locations }))
    .sort((left, right) => comparePaths(left.representative, right.representative));
}

/**
 * The `claude-md`-tagged identities.
 *
 * ⛔ Read off `resource_tags` rather than re-derived from basenames. The whole
 * point of the tag is that the 4 MiB cliff, root discovery and this model read
 * ONE vocabulary — the shipped `classifyPath`'s — and a second basename rule here
 * would be free to disagree with it the moment either changed.
 *
 * Exported because `account` takes the same set: a consumer that has already
 * built the regions must not build a second, differently-derived set to charge
 * their rows with.
 *
 * @param projection - The populated projection
 * @returns Every `resourceId` carrying {@link CLAUDE_MD_TAG}
 */
export function claudeMdIdentities(projection: Projection): ReadonlySet<string> {
  return new Set(
    projection.resourceTags
      .filter((tag) => tag.tag === CLAUDE_MD_TAG)
      .map((tag) => tag.resourceId),
  );
}

/**
 * Order two root-relative paths by UTF-16 code point.
 *
 * ⚠️ Deliberately NOT `String.localeCompare`, matching every other ordering in
 * this lane (`claude-context-ancestry.ts`, `claude-import-extent.ts`): ICU
 * collation is locale-dependent, and a whole-tree report is exactly the kind of
 * output that gets diffed between two machines. Exported so a consumer's
 * tie-break reads the same order this module's grouping does.
 *
 * @param left - One root-relative path
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
export function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Every directory holding at least one `claude-md` file — the candidate
 * representatives.
 *
 * ⚠️ Derived from ALL realizations, deliberately WITHOUT the `gitignored` filter
 * {@link workingLocations} applies — see the module docstring for why that
 * asymmetry is the correct one.
 *
 * @param projection - The populated projection
 * @param claudeMdIds - The `claude-md`-tagged identities
 * @returns The directories, as `resource_realizations.dir` spells them
 */
function instructedDirectories(
  projection: Projection,
  claudeMdIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const dirs = new Set<string>();
  for (const row of projection.resourceRealizations) {
    if (!row.isDirectory && claudeMdIds.has(row.resourceId)) dirs.add(row.dir);
  }
  return dirs;
}

/**
 * The distinct working locations, sorted by code point.
 *
 * A location is any directory something is realized IN, plus the corpus root,
 * which is a working location whether or not anything sits directly in it.
 *
 * @param projection - The populated projection
 * @returns Root-relative directories, `''` first
 */
function workingLocations(projection: Projection): readonly string[] {
  const dirs = new Set<string>(['']);
  for (const row of projection.resourceRealizations) {
    // Unconditional, and with no opt-out — see the module docstring. The context
    // population declines the ignored half, so this can only fire if that
    // decline and this column ever drift.
    if (row.gitignored) continue;
    dirs.add(row.dir);
  }
  return [...dirs].sort(comparePaths);
}

/**
 * The nearest ancestor of `directory` — itself included — that carries a
 * `claude-md` file, or the corpus root when none does.
 *
 * ⛔ Walks the SEGMENT chain `ancestorDirectories` builds rather than testing
 * string prefixes, and that is the defect this function exists to not have:
 * `'packages/cli-x'.startsWith('packages/cli')` is true, so a prefix test hands a
 * sibling package its neighbour's chain — and hands it a plausible number nobody
 * would query twice. Reusing the query's own primitive also keeps the two models
 * reading one definition of "ancestor".
 *
 * @param directory - The working location
 * @param instructedDirs - Directories holding a `claude-md` file
 * @returns The representative directory; `''` when nothing above is instructed
 */
function representativeFor(directory: string, instructedDirs: ReadonlySet<string>): string {
  const chain = ancestorDirectories(directory);
  // Deepest-first: the NEAREST instructed ancestor wins, and the walk terminates
  // at index 0, which `ancestorDirectories` guarantees is `''`.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (candidate !== undefined && instructedDirs.has(candidate)) return candidate;
  }
  return '';
}
