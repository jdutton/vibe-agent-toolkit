/**
 * The producer `.claude/rules` files lacked: their SCOPE, read off the harness's own `paths:` (`harness_blob_facts.paths`).
 *
 * `agentic-tags.ts` gives `rules-file` `loading: null` and says why — a path
 * classifier cannot read frontmatter, and `paths:` frontmatter is what decides
 * whether a rule loads at launch or on demand. This contributor supplies the
 * missing input.
 *
 * ## ⚠️ It emits `rule-scope`, NOT a second `loading` row
 *
 * The obvious design — tag a paths-less rule `loading: 'always'` — is wrong in
 * two ways that turn out to be the same way.
 *
 * 1. **A paths-less rule is ROOT-scoped, not tree-global.** `agentic-tags.ts`
 *    matches `underDirectory(p, '.claude/rules')` at ANY depth, so a
 *    `.claude/rules/` inside a package, a test fixture, a vendored dependency or
 *    a nested worktree would be charged `always` to every directory query in the
 *    corpus — and `resource_tags` has **no location column by design**, so no
 *    consumer could filter it back out. The vendor classifies nested rules
 *    directories in the on-demand class, alongside path-scoped rules.
 * 2. **Two `loading` producers have no arbiter.** `resource_tags`' composite key
 *    is `(resourceId, tag, value, source)` — **`value` is IN the key** — so
 *    `loading='always'` and `loading='selected'` for one resource coexist
 *    without collision, and a `GROUP BY resourceId` double-counts.
 *    `agentic-tags.ts` exports `strongestLoading()` specifically to hold
 *    "exactly one loading row per identity"; a second producer in another
 *    stratum silently ends that invariant.
 *
 * Emitting a NON-`loading` tag fixes both at once, which is the tell that they
 * were one problem. `agentic-convention` stays the only `loading` producer in
 * the projection, and the loading CLASS of a root-scoped rule is decided by the
 * query — where the entry point that makes "root" mean anything is in hand.
 *
 * ## Why `closure`, and what that costs
 *
 * ⚠️ **It cannot be a `base` contributor.** `populateBlobs` runs BETWEEN the
 * strata, so no base-stratum contributor can read `harness_blob_facts.paths` —
 * the table does not exist yet when base runs. That is precisely why
 * `agentic-convention.ts` is `base` + `readsBlobs: false` while
 * `ClosureExtentContributor` is `closure` + `readsBlobs: true`.
 *
 * ⚠️ `populateBlobs` runs **twice**, not once, when the closure stratum promotes
 * a `deferred` realization, and the fixpoint needs ≥2 passes — so this
 * classifier re-reads the stored `paths` at least twice per population. A cost, not a
 * correctness problem: the read is a map lookup over an already-derived table.
 *
 * ⚠️ **`readsBlobs: true` does not scope what gets PARSED.** It decides only
 * whether the blob stage may be SKIPPED. The stage has no extension allowlist,
 * so a contributor that wants the seven rules files in this repo pays for every
 * keyed blob in the tree. "Bound the blob demand by making the contributor
 * small" does not work, and it is stated here because it is exactly what a
 * reader would otherwise assume from how small this contributor is.
 *
 * ⇒ The repo therefore has **two `resource_tags` producers in different
 * strata**: the path classifier in `base`, and this `paths:` classifier in
 * `closure`. That is legal — `ExtentContribution` carries `tags`, and
 * `walkClosure` already returns `tags: []` — but it must be stated, because a
 * reader who assumes tags come from one place will not find this one.
 *
 * ## It also produces `claude_rule_patterns`, and that half is per-GLOB
 *
 * The `rule-scope` tag says a rule is path-scoped; it does not say *which* of
 * its globs reach anything, which is the question an adopter has. So each
 * declared glob also gets one row through {@link evaluateRulePatterns}.
 *
 * ⚠️ **Tree-wide, and evaluated ONCE per sweep** — the corpus file list is built
 * lazily and shared across every rule in the contribution
 * ({@link lazyCorpusFiles}). `selectRules`' per-query short-circuit is a
 * different question and is deliberately untouched by this.
 *
 * ⚠️ **The corpus holds no gitignored file, the harness reads them all.** A glob
 * that matches nothing here but whose territory is ignored is `gitignored`, not
 * `inert`; the ignore question goes to {@link ProjectionBase.gitTracker}
 * through {@link treeIgnores}, and only for would-be `inert` globs.
 *
 * ⛔ Emitted under the same identity dedup as the tag, and for a stronger
 * reason: `claude_rule_patterns` is keyed `(resourceId, ordinal)`, so a
 * re-realized rules file's second and third emission would be silently
 * collapsed by the builder while still costing a full glob sweep apiece.
 */

import { relativeEscapesRoot, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { gitFindRoot, gitLsOthers } from '@vibe-agent-toolkit/utils/git';

import type { ClaudeRulePatternRow } from '../../schemas/projection-claude-rules.js';
import type { HarnessBlobFactsRow } from '../../schemas/projection-harness.js';
import type {
  ResourceExtentRow,
  ResourceTagRow,
} from '../../schemas/projection-resources.js';
import type { JsonValue } from '../../schemas/projection-shared.js';
import type { ResolutionContextRow } from '../../schemas/projection-zones.js';
import {
  RULES_FILE_TAG,
  RULE_SCOPE_TAG,
  type RuleScope,
  classifyPath,
  pluginRootsFrom,
} from '../agentic-tags.js';
import {
  corpusFiles,
  declaredPatterns,
  evaluateRulePatterns,
  type TreeIgnores,
} from '../claude-context-rules.js';
import type { ContributorStratum, ExtentContribution, ExtentContributor } from '../contributor.js';
import { CLAUDE_CODE_ENTRY_NAMES } from '../harness/claude-code-entry-names.js';
import { harnessFactsIndex, type HarnessFactsIndex } from '../harness/facts-index.js';
import type { HarnessId } from '../harness/profile.js';
import type { ProjectionBase } from '../projection.js';
import { isAtOrBelow } from '../root-relative-path.js';

import { extentContextId } from './context-id.js';

/** This contributor's `resolution_contexts.kind`, and its id. */
export const CLAUDE_RULES_SCOPE_KIND = 'claude-rules-scope';

/** The PROJECT-ROOT rules directory — the only location that is `root`-scoped. */
const ROOT_RULES_DIR = CLAUDE_CODE_ENTRY_NAMES.rulesDirectory;

/**
 * Classify one rules file.
 *
 * ⚠️ **A `paths:` that normalises to nothing reads as paths-LESS**, and so does
 * one whose surviving patterns are every one `**` — the harness's own rule,
 * held by `harnessPaths` (`claude-context-rules.ts`), which stores null in
 * `harness_blob_facts.paths` for all of them. `paths: []`, a blank string, `paths: [42]`,
 * `paths: "/**"` and `paths: "**"` all leave the rule loading on every turn.
 * Reading any of them as `path-scoped` silently drops a rule that actually
 * loads — the under-report direction, which is the one a budget check cannot
 * tolerate.
 *
 * ⭐ **A SCALAR string counts, and so does a NESTED list.** The harness
 * normalises `paths:` through one function that comma-splits a string and
 * recurses into an array (see `harnessPaths`; the transcription and
 * its re-verification clock are in
 * `docs/external/claude-code-rules-paths-behaviour.md`), so both `paths: src/**`
 * and `paths: [["src/**"]]` are path-scoped there. Classified as paths-less —
 * which is what an array-of-strings-only read produced — such a rule was
 * charged to every query as always-loaded and none of its globs reached
 * `claude_rule_patterns`.
 *
 * A path *deeper* under the root rules directory (`.claude/rules/lang/ts.md`) is
 * still `root`: "nested" means a second `.claude/` further down the TREE, not a
 * subdirectory of the project's own rules folder.
 *
 * ⛔ Decided from `harness_blob_facts.paths` — the harness's own read of the file's
 * `paths:` — never from `blobs.frontmatter`, VAT's parser's answer. Two
 * readers of one declaration is how the walk and this tag disagreed.
 *
 * @param path - Root-relative, forward-slashed path of the rules file
 * @param paths - The blob's stored `paths`, or null when it has none or was
 *   never keyed
 * @returns The rule's scope
 */
export function ruleScopeFor(path: string, paths: HarnessBlobFactsRow['paths']): RuleScope {
  if (paths !== null) return 'path-scoped';
  return isAtOrBelow(path, ROOT_RULES_DIR) ? 'root' : 'nested';
}

/**
 * The harness whose `paths:` this contributor reads — spelled as the literal,
 * typed through {@link HarnessId}, because this module sits on the
 * `claude-code.ts → claude-memory.ts → claude-context-rules.ts` chain and must
 * not import the profile itself.
 */
const CLAUDE_CODE_HARNESS: HarnessId = 'claude-code';

/** A rules file whose facts are not derived YET — see {@link rulePathsOf}. */
const FRONTIER = Symbol('frontier');

/**
 * One rules file's stored `paths`, or {@link FRONTIER} when its blob has not
 * had its facts derived yet.
 *
 * ⚠️ This is the ONE place an absent facts row is legitimately "not yet"
 * rather than a bug: this contributor runs INSIDE the closure fixpoint, where
 * a blob the stratum has only just reached is frontier whose facts a later
 * pass derives before the fixpoint settles. So it contributes nothing for that
 * file this pass — never a scope guessed from the absence. Every reader outside
 * the fixpoint uses `requireFacts`, which throws.
 *
 * A key with no `blobs` row at all (unreadable, or refused as not text) has no
 * content to have facts OF, and reads as declaring no `paths:`, as it always did.
 *
 * @param contentKey - The rules file's content key, or null when unkeyed
 * @param derivedBlobs - Every content key with a `blobs` row
 * @param facts - Claude Code's facts index over the base
 * @returns The stored `paths`, null, or {@link FRONTIER}
 */
function rulePathsOf(
  contentKey: string | null,
  derivedBlobs: ReadonlySet<string>,
  facts: HarnessFactsIndex,
): HarnessBlobFactsRow['paths'] | typeof FRONTIER {
  if (contentKey === null || !derivedBlobs.has(contentKey)) return null;
  const row = facts.factsOf(contentKey);
  return row === undefined ? FRONTIER : row.paths;
}

/**
 * The tree's file list, built at most ONCE per contribution and only when a
 * path-scoped rule actually asks for it.
 *
 * `corpusFiles` walks and sorts every realization and {@link evaluateRulePatterns}
 * binary-searches the result, so it must be SHARED across a sweep (per-rule
 * construction is 245 walks of one realization table on the adopter this lane was
 * measured against) and LAZY, so a tree with no path-scoped rule never pays.
 *
 * @param base - The projection so far
 * @returns A memoized accessor for the sorted, deduplicated corpus file list
 */
function lazyCorpusFiles(base: ProjectionBase): () => readonly string[] {
  let files: readonly string[] | undefined;
  return () => {
    files ??= corpusFiles(base.resourceRealizations);
    return files;
  };
}

/**
 * Tags every `.claude/rules` file with the scope its `paths:` imply, and
 * records what each of its declared `paths:` globs reaches in this tree.
 *
 * `closure` stratum and `readsBlobs: true` — see the header for both, and for
 * what `readsBlobs` does and does not buy.
 */
export class ClaudeRulesScopeContributor implements ExtentContributor {
  readonly id = CLAUDE_RULES_SCOPE_KIND;

  readonly kind = CLAUDE_RULES_SCOPE_KIND;

  readonly stratum: ContributorStratum = 'closure';

  /** `paths` lives on `harness_blob_facts`, which does not exist until after the base stratum. */
  readonly readsBlobs = true;

  /**
   * Classify every realized rules file, and evaluate every glob it declares.
   *
   * @param base - Read-only projection view; `resourceRealizations`, `blobs`
   *   and `harnessBlobFacts` are the inputs
   * @param _parameters - Unused. A tree's rules are the same question however
   *   the caller narrowed the crawl
   * @returns One extent, its members, their `rule-scope` tags, and one
   *   `claude_rule_patterns` row per declared `paths:` glob
   */
  contribute(base: ProjectionBase, _parameters: JsonValue): Promise<ExtentContribution> {
    const { rootId } = base.identities;
    const extentId = extentContextId(CLAUDE_RULES_SCOPE_KIND, rootId);
    const context: ResolutionContextRow = {
      contextId: extentId,
      species: 'extent',
      kind: CLAUDE_RULES_SCOPE_KIND,
      rootId,
      extentContextId: null,
      role: null,
    };

    const facts = harnessFactsIndex(base, CLAUDE_CODE_HARNESS);
    const derivedBlobs = new Set(base.blobs.map((blob) => blob.contentKey));
    // Derived from the whole path set before any path is classified: a plugin
    // root is a fact about the TREE, and asking it per-path would make the
    // answer depend on iteration order. Same reasoning as `agentic-convention.ts`.
    const pluginRoots = pluginRootsFrom(base.resourceRealizations.map((row) => row.path));

    const tags: ResourceTagRow[] = [];
    const memberships: ResourceExtentRow[] = [];
    const claudeRulePatterns: ClaudeRulePatternRow[] = [];
    const filesOf = lazyCorpusFiles(base);
    const ignores = treeIgnores(base);
    const seen = new Set<string>();

    for (const row of base.resourceRealizations) {
      // A directory is never a rules file: the tag names a markdown file the
      // harness reads, and `.claude/rules` itself is not a rule.
      if (row.isDirectory) continue;
      const classified = classifyPath(row.path, row.basenameLower, pluginRoots);
      if (!classified.some((tag) => tag.tag === RULES_FILE_TAG)) continue;
      // One row per IDENTITY. Two realizations of one identity are the ordinary
      // state, not a corner case: `resource_realizations` is keyed
      // `(extentId, path)`, so one file realized by the filesystem extent and by
      // the git extent is two rows carrying one `resourceId`. `value` is in
      // `resource_tags`' key, so both rows would survive and a consumer reading
      // "the" scope would find two. The first realization in base order wins,
      // which is the same tie-break `resolveReference` applies when it picks a
      // row for a resolved path.
      //
      // 🪤 The earlier justification here — a symlinked `.claude/rules/` giving
      // one identity two paths that classify differently (`root` at one, `nested`
      // at the other) — is not a shape anything shipped produces. `resourceId`
      // does NOT collapse a link onto its target wherever git answers (see *"🪤 A
      // symlink and its target do NOT reliably share one identity"* in
      // `../identity.ts`), and no enumerator reports anything BENEATH a symlinked
      // directory in the first place (`crawl-source.ts`). The dedup stands on the
      // multi-extent case above, which is measured every run.
      if (seen.has(row.resourceId)) continue;

      const paths = rulePathsOf(row.contentKey, derivedBlobs, facts);
      if (paths === FRONTIER) continue;
      seen.add(row.resourceId);
      memberships.push({ resourceId: row.resourceId, extentId });
      tags.push({
        resourceId: row.resourceId,
        tag: RULE_SCOPE_TAG,
        value: ruleScopeFor(row.path, paths),
        source: this.id,
      });
      // Under the SAME identity dedup as the tag above, and for a stronger
      // reason: `claude_rule_patterns` is keyed `(resourceId, ordinal)`, so the
      // builder would silently collapse the second and third emission of an
      // identity realized under three extents — the duplicate work would stay,
      // invisible, at one tree-wide glob sweep per extra realization per pass.
      for (const evaluation of this.#patternsOf(row.path, paths, filesOf, ignores)) {
        claudeRulePatterns.push({ resourceId: row.resourceId, ...evaluation });
      }
    }

    return Promise.resolve({
      contexts: [context],
      // Empty on purpose: every identity tagged here was minted by the
      // enumerator that found its path, and re-emitting the rows would claim
      // this contributor discovered them.
      resources: [],
      realizations: [],
      memberships,
      tags,
      conditions: [],
      claudeRulePatterns,
    });
  }

  /**
   * What each glob one rules file declares reaches in this tree.
   *
   * Private and tiny, and it exists to keep the corpus file list from being
   * built for a tree that has no path-scoped rule in it: a rule declaring
   * nothing returns before `filesOf()` is ever called.
   *
   * ⛔ The pattern lane is TREE-WIDE, not query-scoped, which is the whole
   * difference between "this glob matches nothing" and "this glob matches
   * nothing HERE". That is why it is evaluated during POPULATION rather than
   * inside `selectRules`, whose short-circuit answers a different question and
   * is deliberately left untouched.
   *
   * @param rulePath - The rules file's root-relative path
   * @param paths - The rules file's stored `paths`, or null when it declares
   *   none or its blob was never keyed
   * @param filesOf - The sweep's shared, lazily-built corpus file list
   * @returns One evaluation per declared glob, in declaration order
   */
  #patternsOf(
    rulePath: string,
    paths: HarnessBlobFactsRow['paths'],
    filesOf: () => readonly string[],
    ignores: TreeIgnores,
  ): readonly Omit<ClaudeRulePatternRow, 'resourceId'>[] {
    const patterns = declaredPatterns(paths);
    if (patterns.length === 0) return [];
    return evaluateRulePatterns({ rulePath, patterns, files: filesOf(), ignores });
  }
}

/**
 * What the tree ignores, as `evaluateRulePatterns` asks it — or nothing at all
 * when there is no usable tracker.
 *
 * Two questions, one seam ({@link TreeIgnores}). `isIgnored` (below) answers a
 * probe path, existing or not. `ignoredEntries` is git's COLLAPSED ignored
 * listing, which is the only way to learn that an unanchored glob's name sits
 * ignored somewhere below the root (`dist/**` beside `packages/a/dist/`). It is
 * one `ls-files -o -i --directory` spawn, fetched lazily — only when some rule
 * has a pattern with no visible witness — and once per sweep.
 *
 * Outside a repository nothing is ignored, and a tracker git never answered for
 * is an empty shell whose "not ignored" is not a verdict — both yield the
 * non-git answer, which leaves every would-be `inert` glob `inert`.
 *
 * `isIgnoredByActiveSet` and not `isIgnored`: it answers an EXISTING ignored
 * path from the active set with no spawn, and falls back to `git check-ignore`
 * for a path that does not exist — which is every probe
 * `evaluateRulePatterns` sends for an unbuilt `dist/`. That fallback answers
 * from the ignore PATTERNS, which is the question. No `knownToExist`: these
 * paths are questions, not enumerated observations.
 *
 * A path that resolves outside the root (a `../x/**` glob) is not ignored, and
 * is answered here without asking: `git check-ignore` exits 128 on it and the
 * tracker's recovery walk then spawns once per ancestor up to the filesystem
 * root, to arrive at the same `false`.
 *
 * @param base - The projection so far
 * @returns A predicate over root-relative, forward-slashed paths
 */
function treeIgnores(base: ProjectionBase): TreeIgnores {
  const tracker = base.gitTracker;
  if (!tracker?.isUsable()) return { isIgnored: () => false, ignoredEntries: () => [] };
  let entries: readonly string[] | undefined;
  return {
    isIgnored: (path) => {
      const absolute = safePath.resolve(base.root, path);
      if (relativeEscapesRoot(safePath.relative(base.root, absolute))) return false;
      return tracker.isIgnoredByActiveSet(absolute);
    },
    ignoredEntries: () => (entries ??= ignoredListing(base.root)),
  };
}

/**
 * git's collapsed ignored listing, re-rooted at the corpus root.
 *
 * `ls-files` spells paths relative to the REPOSITORY root, which is above the
 * corpus root whenever the corpus is a subdirectory, so each entry is resolved
 * there and made corpus-relative; an entry outside the corpus is dropped. A
 * directory keeps its trailing `/`, the one signal that it stands for its
 * whole subtree.
 *
 * ⚠️ A directory git could not open is `degrade`d here without a record: the
 * crawl source runs this same listing for the same tree during population and
 * is where such a refusal is reported. A listing git did not answer at all is
 * empty, which leaves a would-be `inert` glob `inert` — the non-git answer.
 *
 * @param root - Absolute corpus root
 * @returns Root-relative entries, directories spelled with a trailing `/`
 */
function ignoredListing(root: string): string[] {
  const listing = gitLsOthers({ cwd: root, ignored: true, directory: true, unreadable: { degrade: () => undefined } });
  if (listing === null) return [];
  const repositoryRoot = gitFindRoot(root) ?? root;
  const entries: string[] = [];
  for (const entry of listing) {
    const isDirectory = entry.endsWith('/');
    const relative = toForwardSlash(safePath.relative(root, safePath.resolve(repositoryRoot, entry)));
    if (relative === '' || relativeEscapesRoot(relative)) continue;
    entries.push(isDirectory ? `${relative}/` : relative);
  }
  return entries;
}
