/**
 * The producer `.claude/rules` files lacked: their SCOPE, read off frontmatter.
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
 * strata, so no base-stratum contributor can read `blobs.frontmatter` — the
 * table does not exist yet when base runs. That is precisely why
 * `agentic-convention.ts` is `base` + `readsBlobs: false` while
 * `ClosureExtentContributor` is `closure` + `readsBlobs: true`.
 *
 * ⚠️ `populateBlobs` runs **twice**, not once, when the closure stratum promotes
 * a `deferred` realization, and the fixpoint needs ≥2 passes — so this
 * classifier re-reads frontmatter at least twice per population. A cost, not a
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
 * strata**: the path classifier in `base`, and this frontmatter classifier in
 * `closure`. That is legal — `ExtentContribution` carries `tags`, and
 * `walkClosure` already returns `tags: []` — but it must be stated, because a
 * reader who assumes tags come from one place will not find this one.
 */

import type {
  ResourceExtentRow,
  ResourceTagRow,
} from '../../schemas/projection-resources.js';
import type { JsonValue } from '../../schemas/projection-shared.js';
import type { ResolutionContextRow } from '../../schemas/projection-zones.js';
import { RULES_FILE_TAG, classifyPath, pluginRootsFrom } from '../agentic-tags.js';
import type { ContributorStratum, ExtentContribution, ExtentContributor } from '../contributor.js';
import type { ProjectionBase } from '../projection.js';

import { extentContextId } from './context-id.js';

/** This contributor's `resolution_contexts.kind`, and its id. */
export const CLAUDE_RULES_SCOPE_KIND = 'claude-rules-scope';

/** The tag whose value carries a rules file's {@link RuleScope}. */
export const RULE_SCOPE_TAG = 'rule-scope';

/**
 * How broadly a `.claude/rules` file applies.
 *
 * - `root` — no `paths:`, and under the PROJECT-ROOT `.claude/rules/`. Loads at
 *   launch with the same priority as `.claude/CLAUDE.md`.
 * - `nested` — no `paths:`, but under a `.claude/rules/` somewhere below the
 *   project root. The vendor puts these in the on-demand class.
 * - `path-scoped` — carries `paths:`. Its predicate needs a path, and this
 *   classifier has none, so the class is the same wherever the file lives.
 *
 * Deliberately NOT a `loading` class — see the module header for why a second
 * `loading` producer would end an invariant `strongestLoading` exists to hold.
 */
export type RuleScope = 'root' | 'nested' | 'path-scoped';

/** The frontmatter key whose presence makes a rule path-scoped. */
const PATHS_KEY = 'paths';

/** The PROJECT-ROOT rules directory — the only location that is `root`-scoped. */
const ROOT_RULES_DIR = '.claude/rules/';

/**
 * Classify one rules file.
 *
 * ⚠️ **An empty or non-array `paths:` reads as paths-LESS**, deliberately.
 * `paths: []` selects no files, so a rule carrying it has no predicate to be
 * scoped by, and a non-list value is malformed rather than informative. Reading
 * either as `path-scoped` would silently drop a rule that actually loads — the
 * under-report direction, which is the one a budget check cannot tolerate.
 *
 * A path *deeper* under the root rules directory (`.claude/rules/lang/ts.md`) is
 * still `root`: "nested" means a second `.claude/` further down the TREE, not a
 * subdirectory of the project's own rules folder.
 *
 * @param path - Root-relative, forward-slashed path of the rules file
 * @param frontmatter - The blob's parsed frontmatter, or null when it has none
 *   or was never keyed
 * @returns The rule's scope
 */
export function ruleScopeFor(
  path: string,
  frontmatter: Readonly<Record<string, JsonValue>> | null,
): RuleScope {
  const paths = frontmatter?.[PATHS_KEY];
  if (Array.isArray(paths) && paths.length > 0) return 'path-scoped';
  // eslint-disable-next-line local/no-path-startswith -- `resource_realizations.path` is forward-slashed and root-relative by `relativize()` before any consumer sees it, which is the precondition this rule enforces
  return path.startsWith(ROOT_RULES_DIR) ? 'root' : 'nested';
}

/**
 * Tags every `.claude/rules` file with the scope its frontmatter implies.
 *
 * `closure` stratum and `readsBlobs: true` — see the header for both, and for
 * what `readsBlobs` does and does not buy.
 */
export class ClaudeRulesScopeContributor implements ExtentContributor {
  readonly id = CLAUDE_RULES_SCOPE_KIND;

  readonly kind = CLAUDE_RULES_SCOPE_KIND;

  readonly stratum: ContributorStratum = 'closure';

  /** Frontmatter lives on `blobs`, which does not exist until after the base stratum. */
  readonly readsBlobs = true;

  /**
   * Classify every realized rules file.
   *
   * @param base - Read-only projection view; `resourceRealizations` and `blobs`
   *   are the inputs
   * @param _parameters - Unused. A tree's rules are the same question however
   *   the caller narrowed the crawl
   * @returns One extent, its members, and their `rule-scope` tags
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

    const frontmatterByKey = new Map(
      base.blobs.map((blob) => [blob.contentKey, blob.frontmatter] as const),
    );
    // Derived from the whole path set before any path is classified: a plugin
    // root is a fact about the TREE, and asking it per-path would make the
    // answer depend on iteration order. Same reasoning as `agentic-convention.ts`.
    const pluginRoots = pluginRootsFrom(base.resourceRealizations.map((row) => row.path));

    const tags: ResourceTagRow[] = [];
    const memberships: ResourceExtentRow[] = [];
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
      seen.add(row.resourceId);

      const frontmatter = row.contentKey === null
        ? null
        : frontmatterByKey.get(row.contentKey) ?? null;
      memberships.push({ resourceId: row.resourceId, extentId });
      tags.push({
        resourceId: row.resourceId,
        tag: RULE_SCOPE_TAG,
        value: ruleScopeFor(row.path, frontmatter),
        source: this.id,
      });
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
    });
  }
}
