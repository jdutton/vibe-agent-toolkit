/**
 * What an agent can REACH from a path, that the harness does not load for it.
 *
 * ## The other half of the question, and why it needs its own row shape
 *
 * `whatLoadsAt` answers what is FORCED into context: the `CLAUDE.md` ancestry,
 * the rules in scope, and the `@`-import closure. Every row there is a cost the
 * session pays whether or not the agent wants it. This answers the complement —
 * what the loaded instructions POINT AT, which the agent may open and usually
 * will not. An ordinary markdown link is a voluntary edge: it costs nothing at
 * launch, and it is the only reason a doc nobody imports is findable at all.
 *
 * ⛔ These rows are NOT `LoadedRow`s and must never be folded into that array.
 * Sharing the shape was the tempting move and it is the one that breaks: a
 * `LoadedRow` carries `loadClass`, and a voluntary link has no honest value for
 * it — `on-demand` is already spoken for by path-scoped rules and nested rules,
 * which the harness really does load on its own initiative. A link the agent
 * might follow is not in that class; nothing loads it, ever, unless a person or
 * a model decides to read it. Merging the two would also make the on-demand
 * total un-addable, because a linked doc would be counted beside files that
 * genuinely enter context, and the sum would stop meaning anything — the same
 * failure as the directory constant this lane just removed, arriving by a
 * different route.
 *
 * So: its own row, its own totals, and a hard disjointness rule — a target the
 * loaded set already contains is EXCLUDED here. The two answers partition, which
 * is what lets a reader add them and what lets either be read alone.
 *
 * ## Computed, never materialised — and that is a ruling, not an oversight
 *
 * Jeff ruled on 2026-08-22 that the discoverability lens is built computed. The
 * `edges` table `zones.md` §5.2 specifies would be its natural home and is a
 * DEFERRAL with a designed target, not a refusal: §5.2 names "a rules file
 * matching by `paths:`" as `origin: 'implicit'`, and §2 is explicit that caching
 * a lens is an optimisation with no data-model commitment. The one constraint
 * that survives for whoever builds it: `origin` cannot be added later, so all
 * three origins must be in the schema from the first row. Nothing here writes a
 * table, and nothing here should be reconciled into a `link_targets` side table
 * that would have to be merged with `edges` afterwards.
 *
 * ## ONE HOP, and the reason is the constant
 *
 * Only references authored IN the loaded set are followed. A transitive walk
 * would answer "what is reachable from this tree", and in a linked documentation
 * corpus that is the tree — a number identical for every path, which is exactly
 * the failure mode `claude-context-rules.ts` documents at length. One hop
 * answers "what do the instructions in my context point me at", which is the
 * question a person acting on the answer actually has. Published as the
 * `discovery-one-hop` limit rather than left implicit.
 *
 * ## What is followed, and what is deliberately not
 *
 * - `markdown-link` and `markdown-definition` only. `at-prefixed` is the IMPORT
 *   lane and those targets are already loaded rows — following them here would
 *   double-count the closure `whatLoadsAt` owns. `env-anchored` and `bare-token`
 *   are not links.
 * - `markdown-link-reference` is skipped ON PURPOSE, and it is not a gap: its
 *   `rawRef` is a LABEL (`[text][ref]`), not a path, so resolving it would treat
 *   a label as a filename. The URL lives on the matching `markdown-definition`,
 *   which IS followed — so a doc linked five times through one reference
 *   definition is counted ONCE, at the definition. That is the right cardinality
 *   for a discoverability answer, which asks whether a target is findable rather
 *   than how often it is mentioned.
 * - `bare-token` is excluded, which is ALSO what drops every link inside a code
 *   span or fence — and the mechanism is worth stating exactly, because the
 *   obvious guard is dead code. A draft of this module tested
 *   `inCodeSpan || inFence` and a mutation audit found the check unreachable:
 *   remark emits no link node inside code, so `[y](docs/other.md)` in a fence
 *   never becomes a `markdown-link` at all. The only row it produces is the
 *   LEXER's, `syntacticForm: 'bare-token'`, carrying `rawRef: 'y](docs/other.md'`
 *   — already refused one line up. Adding the flag test back would be a doubled
 *   mechanism of the kind `claude-context-query.ts`'s `baseAdmissions` refuses:
 *   it would keep passing after the form filter broke, and its own test would be
 *   vacuous, which is how it was caught. The form filter is the guard; the flags
 *   are the import lane's business, where a lexer token really can sit in a fence.
 * - A bare path in prose (`see docs/guide.md`) is excluded by the same rule. It
 *   is a mention, not an authored destination, and the lexer classifies it
 *   `bare-token` too.
 * - A scheme-qualified reference is dropped — see {@link hasUriScheme}.
 */

import { safePath } from '@vibe-agent-toolkit/utils';

import { resolveLocalHref } from '../utils.js';

import type { LoadedContextAnswer } from './claude-context-query.js';
import type { Projection } from './projection.js';

/**
 * How far VAT can vouch for a discoverable target.
 *
 * ⛔ `unrealized` is NOT "broken". A link into a generated directory, or into a
 * path a sibling worktree holds, resolves inside the root and is simply not in
 * this population. Calling it broken would assert a defect from an absence, and
 * `vat resources validate` is the lane that actually adjudicates link integrity.
 * This says only what this projection can see.
 */
export type DiscoveryReach = 'realized' | 'unrealized' | 'outside-root';

/**
 * `unrealized`, spelled once.
 *
 * Extracted for `sonarjs/no-duplicate-string`, and it earns the name: this is
 * the default reach for anything that resolves inside the root, so three call
 * sites agreeing on the spelling is a correctness property rather than tidiness.
 */
const UNREALIZED = 'unrealized' satisfies DiscoveryReach;

/**
 * `outside-root`, spelled once — same reason as {@link UNREALIZED}.
 *
 * ⛔ Reached by TWO different routes that must agree: a leading-slash href
 * `resolveLocalHref` refuses, and a relative href that climbs out with `..`,
 * which it cannot refuse because a relative reference has no root to escape
 * from. One spelling is what keeps the two from drifting into distinct verdicts
 * for the same situation.
 */
const OUTSIDE_ROOT = 'outside-root' satisfies DiscoveryReach;

/** One target the loaded set points at, which the harness does not load. */
export interface DiscoverableRow {
  /**
   * Root-relative path of the target, or the raw reference when it resolves
   * outside the root — where there is no root-relative form to give.
   */
  readonly path: string;
  /** The identity, or null when this projection realizes no such path. */
  readonly resourceId: string | null;
  /** `blobs.tokenEstimate`, or null when unrealized — never 0. */
  readonly tokens: number | null;
  /** `blobs.bytes`, or null when unrealized. */
  readonly bytes: number | null;
  readonly reach: DiscoveryReach;
  /** Every loaded file that points at this target, in path order. */
  readonly citedBy: readonly DiscoveryCitation[];
}

/** One place a loaded file points at a target. */
export interface DiscoveryCitation {
  /** Root-relative path of the LOADED file carrying the reference. */
  readonly fromPath: string;
  readonly line: number;
  /** Link text, or null for a bare autolink or a definition. */
  readonly text: string | null;
}

/**
 * The reachable set, with the unvouchable rows COUNTED rather than summed as zero.
 *
 * `discoverableTokens` is what the agent could pull in by following one link —
 * an upper bound on a voluntary cost, never a charge. It is deliberately NOT
 * added to either of `ContextTotals`' figures anywhere in this lane.
 */
export interface DiscoveryTotals {
  readonly discoverableTokens: number;
  readonly unknownTokenRows: number;
  readonly unrealizedRows: number;
  readonly outsideRootRows: number;
}

/** The lens's answer. */
export interface DiscoverableContext {
  readonly rows: readonly DiscoverableRow[];
  readonly totals: DiscoveryTotals;
}

/**
 * Does this reference name a scheme rather than a path?
 *
 * ⚠️ Deliberately a DIFFERENT rule from `reference-lexer.ts`'s `URL_SCHEME`,
 * which requires `://` — and the difference is load-bearing rather than a second
 * copy drifting. `mailto:someone@example.com` and `tel:+1` carry no `//`, and
 * handing either to an RFC 3986 path resolver produces a plausible relative
 * filename that would then be reported as an unrealized document. So the test
 * here is a colon before any slash, which is the general shape of a URI scheme
 * and the one this consumer needs. A Windows drive letter cannot reach this:
 * these are markdown hrefs from `blob_references`, not filesystem paths.
 *
 * @param rawRef - The reference exactly as authored
 * @returns True when the reference is scheme-qualified
 */
function hasUriScheme(rawRef: string): boolean {
  const colon = rawRef.indexOf(':');
  if (colon <= 0) return false;
  const slash = rawRef.indexOf('/');
  return slash === -1 || colon < slash;
}

/** The two syntactic forms that carry a URL an author typed as a destination. */
const FOLLOWED_FORMS = new Set(['markdown-link', 'markdown-definition']);

/**
 * What is reachable in one hop from what loads at this path, minus what loads.
 *
 * @param projection - The populated projection the answer came from
 * @param answer - `whatLoadsAt`'s answer, which is the AUTHORITY for the loaded
 *   set. Taken as an argument rather than recomputed so the two lenses can never
 *   disagree about what is already in context — a disagreement would make the
 *   disjointness this row shape depends on silently false
 * @returns The discoverable rows and their totals
 */
export function discoverableFrom(
  projection: Projection,
  answer: LoadedContextAnswer,
): DiscoverableContext {
  const root = projection.roots[0]?.path;
  if (root === undefined) {
    throw new Error(
      'discoverableFrom received a projection with no root, which violates the projection invariant'
      + ' that every population has exactly one (`merge.ts` is the sole `addRoot` caller). Markdown'
      + ' hrefs resolve against that root, so answering "nothing is discoverable" here would report'
      + ' an unlinked tree for one nobody looked at.',
    );
  }
  const loadedPaths = new Set(answer.rows.map((row) => row.path));
  const keyToPath = new Map<string, string>();
  for (const row of projection.resourceRealizations) {
    if (row.contentKey !== null && loadedPaths.has(row.path)) keyToPath.set(row.contentKey, row.path);
  }

  const targets = new Map<string, DiscoveryCitation[]>();
  const reachOf = new Map<string, DiscoveryReach>();
  for (const reference of projection.blobReferences) {
    const fromPath = keyToPath.get(reference.blob);
    if (fromPath === undefined || !isFollowable(reference)) continue;
    const target = resolveTarget(reference.rawRef, fromPath, root);
    // Already loaded ⇒ not discoverable-but-unloaded. Dropped here rather than
    // filtered at the end, so the two answers partition by construction.
    if (target === undefined || loadedPaths.has(target.path)) continue;
    reachOf.set(target.path, target.reach);
    push(targets, target.path, {
      fromPath,
      line: reference.line,
      text: reference.text,
    });
  }

  return buildResult(projection, targets, reachOf);
}

/**
 * Is this reference an authored pointer to another document in the tree?
 *
 * @param reference - One `blob_references` row
 * @returns True when it should be followed
 */
function isFollowable(reference: { syntacticForm: string; rawRef: string }): boolean {
  // ⛔ No `inCodeSpan`/`inFence` test, and its absence is load-bearing rather
  // than an omission — see the header. A link inside code never reaches this
  // function as a followed FORM, so such a test could never fire, and a check
  // that cannot fire is a check whose own test is vacuous.
  if (!FOLLOWED_FORMS.has(reference.syntacticForm)) return false;
  return !hasUriScheme(reference.rawRef);
}

/**
 * Where one reference points, root-relative, or undefined when it is not a
 * pointer at a file at all.
 *
 * An anchor-only href (`#section`) is not a target: it names a place in the
 * SOURCE, which is already loaded. `absolute_no_root` cannot occur — a root is
 * always supplied — and `absolute_escapes_root` is reported as `outside-root`
 * rather than dropped, because a link out of the tree is a real thing the agent
 * can follow and VAT simply cannot vouch for what is there.
 *
 * @param rawRef - The reference exactly as authored
 * @param fromPath - Root-relative path of the file carrying it
 * @param root - Absolute corpus root
 * @returns The target and how far VAT can vouch for it, or undefined
 */
function resolveTarget(
  rawRef: string,
  fromPath: string,
  root: string,
): { path: string; reach: DiscoveryReach } | undefined {
  const resolved = resolveLocalHref(rawRef, safePath.join(root, fromPath), root);
  if (resolved.kind === 'anchor_only') return undefined;
  if (resolved.kind !== 'resolved') return { path: rawRef, reach: OUTSIDE_ROOT };

  const relative = safePath.relative(root, resolved.resolvedPath);
  // `..` at the front means the href climbed out of the corpus by traversal
  // rather than by a leading slash, which `resolveLocalHref` does not treat as
  // an escape because a relative reference has no root to escape from. The
  // containment decision belongs to the caller that HAS the root, and this is it.
  if (relative === '' || relative.startsWith('..')) return { path: rawRef, reach: OUTSIDE_ROOT };
  return { path: relative, reach: UNREALIZED };
}

/**
 * Join the collected targets to the projection and sum what can be summed.
 *
 * Split from {@link discoverableFrom} to stay under the cognitive-complexity
 * ceiling: the reference loop plus this join plus the totals exceed it in one
 * body.
 *
 * @param projection - The populated projection
 * @param targets - Target path → every loaded file citing it
 * @param reachOf - Target path → the reach {@link resolveTarget} decided
 * @returns The rows and totals
 */
function buildResult(
  projection: Projection,
  targets: ReadonlyMap<string, readonly DiscoveryCitation[]>,
  reachOf: ReadonlyMap<string, DiscoveryReach>,
): DiscoverableContext {
  const realizationOf = new Map<string, { resourceId: string; contentKey: string | null }>();
  for (const row of projection.resourceRealizations) {
    if (!realizationOf.has(row.path)) realizationOf.set(row.path, row);
  }
  const blobByKey = new Map(projection.blobs.map((row) => [row.contentKey, row]));

  const rows: DiscoverableRow[] = [];
  for (const [path, citations] of targets) {
    const realization = realizationOf.get(path);
    const blob = realization?.contentKey == null ? undefined : blobByKey.get(realization.contentKey);
    rows.push({
      path,
      resourceId: realization?.resourceId ?? null,
      tokens: blob?.tokenEstimate ?? null,
      bytes: blob?.bytes ?? null,
      reach: realization === undefined ? (reachOf.get(path) ?? UNREALIZED) : 'realized',
      citedBy: [...citations].sort(compareCitations),
    });
  }
  rows.sort((left, right) => comparePaths(left.path, right.path));
  return { rows, totals: totalsOf(rows) };
}

/**
 * Sum the vouchable rows and count the rest.
 *
 * ⚠️ `tokens === null` is counted, never summed as zero — the same rule
 * `claude-context-accounting.ts` applies, and for the same reason: a total that
 * silently absorbed an unmeasured file would read as complete.
 *
 * @param rows - Every discoverable row
 * @returns The totals
 */
function totalsOf(rows: readonly DiscoverableRow[]): DiscoveryTotals {
  let discoverableTokens = 0;
  let unknownTokenRows = 0;
  let unrealizedRows = 0;
  let outsideRootRows = 0;

  for (const row of rows) {
    if (row.reach === OUTSIDE_ROOT) outsideRootRows += 1;
    else if (row.reach === UNREALIZED) unrealizedRows += 1;
    else if (row.tokens === null) unknownTokenRows += 1;
    else discoverableTokens += row.tokens;
  }

  return { discoverableTokens, unknownTokenRows, unrealizedRows, outsideRootRows };
}

/**
 * Order two citations by source path, then line.
 *
 * @param left - One citation
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
function compareCitations(left: DiscoveryCitation, right: DiscoveryCitation): number {
  if (left.fromPath !== right.fromPath) return comparePaths(left.fromPath, right.fromPath);
  return left.line - right.line;
}

/**
 * Order two root-relative paths by UTF-16 code point.
 *
 * ⚠️ Deliberately NOT `String.localeCompare` — ICU- and locale-dependent, so two
 * machines could order this answer differently, and this array's order IS the
 * answer's order. The same refusal `claude-context-query.ts`,
 * `claude-context-ancestry.ts` and `claude-import-extent.ts` each make.
 *
 * @param left - One root-relative path
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Append one citation under a target path.
 *
 * @param map - The citation map, mutated in place
 * @param path - The target
 * @param citation - Where it was cited
 */
function push(map: Map<string, DiscoveryCitation[]>, path: string, citation: DiscoveryCitation): void {
  const list = map.get(path);
  if (list === undefined) map.set(path, [citation]); else list.push(citation);
}
