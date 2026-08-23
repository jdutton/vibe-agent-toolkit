/**
 * The `@`-import closure of one `CLAUDE.md` or `.claude/rules` file, expressed
 * as the generic closure primitive plus a declaration.
 *
 * Structurally this is `agent-skills`' `skill-extent.ts` again — delegate held
 * privately, `readsBlobs` delegated rather than restated, one instance per root
 * — and the thinness is the finding: if this class needed to *do* anything, the
 * closure primitive would have been inadequate for the second real extent asked
 * of it, and `zones.md` §7.3's adequacy test would have a counter-example.
 *
 * ## What the declaration says, and why every line of it is load-bearing
 *
 * Each field below is one the schema would otherwise DEFAULT, and each default
 * is wrong here in a different direction — which is why
 * `projection-claude-import-extent.test.ts` asserts the whole object rather than
 * spot-checking it.
 *
 * - **`follow: ['at-prefixed']`.** `ExtentDeclarationSchema` defaults `follow`
 *   to the three markdown forms, and that default is wrong in the most expensive
 *   possible direction: Claude Code loads `@path`, not `[text](path)`. Following
 *   markdown links out of a `CLAUDE.md` would drag the entire linked docs tree
 *   into a budget the harness never charges.
 * - **`referenceDialect: 'claude-import'`.** The schema defaults to `href`, VAT's
 *   RFC 3986 reading, under which `@README.md` names a file literally called
 *   `@README.md`. Every import in every corpus then lands as
 *   `CLOSURE_REFERENCE_UNRESOLVED` — an under-report indistinguishable from a
 *   tree of broken links, which is exactly how it went unnoticed. See
 *   `reference-dialect.ts`.
 * - **`maxDepth: 4`.** The schema defaults to `'full'`. Four is
 *   vendor-documented (*"a maximum depth of four hops"*) and already cited at
 *   `projection-zones.ts`. `canDescend` is `depth < maxDepth` with the root
 *   seeded at depth 0, so four hops are admitted and the fifth becomes a
 *   `CLOSURE_DEPTH_EXCEEDED` row.
 * - **No refusals, no `admitPaths`.** The harness applies no exclusion cascade
 *   to imports, and inventing one here would decline files a real session loads.
 *
 * ## 🪤 `@${VAR}/path.md` is invisible to this declaration
 *
 * The lexer classifies a token carrying a variable expansion as `env-anchored`
 * whatever else it looks like (`reference-lexer.ts`'s `classify`), so
 * `follow: ['at-prefixed']` does not select it. Probably desirable — an
 * unexpanded variable cannot be resolved against anything — but it is silent,
 * and the `follow` line above is the one a reader would expect to cover it.
 * Pinned by a test rather than left as a comment.
 *
 * ## Id discrimination: the root-relative path
 *
 * Unique by construction, unlike a frontmatter `name`.
 * `ContributorRegistry.register` throws on a duplicate id, so a collision is a
 * FAILED population rather than a mild defect — the same reasoning
 * `inventory-population.ts` states for the skill case, and the same reason
 * `SkillExtentContributor` is one instance per skill rather than one per corpus.
 *
 * ## Two §10 cases this extent cannot answer, and who owns them
 *
 * - **A `CLAUDE.md` over 4 MiB is skipped ENTIRELY by the harness** — a cliff,
 *   not a truncation. The closure has no size input and no business acquiring
 *   one: it is a MEMBERSHIP primitive and the skip is an ACCOUNTING rule. The
 *   query owns it, and owes the harder half — the skipped file's import SUBTREE
 *   must be dropped with it, or a 5 MiB `CLAUDE.md` importing a 200 KB handbook
 *   still charges the handbook.
 * - **`CLAUDE.local.md` ordering relative to `CLAUDE.md`.** The vendor appends
 *   `CLAUDE.local.md` after `CLAUDE.md` within each directory. This module
 *   treats each as an independent root, which is correct — they are separate
 *   import closures — so ordering is a property of the ANCESTRY chain the query
 *   computes, not of any extent here.
 */

import { ExtentDeclarationSchema, type ExtentDeclaration } from '../../schemas/project-config.js';
import type { ResourceRealizationRow } from '../../schemas/projection-resources.js';
import type { JsonValue } from '../../schemas/projection-shared.js';
import { CLAUDE_MD_TAG, RULES_FILE_TAG, classifyPath, pluginRootsFrom } from '../agentic-tags.js';
import type { ContributorStratum, ExtentContribution, ExtentContributor } from '../contributor.js';
import type { ProjectionBase } from '../projection.js';

import { ClosureExtentContributor } from './closure-extent.js';

/** The `resolution_contexts.kind` a Claude import extent has. */
export const CLAUDE_IMPORT_KIND = 'claude-import';

/** `zone_provenance.contributorId` prefix for a Claude import extent. */
export const CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX = 'builtin:claude-import';

/**
 * The hop budget the vendor documents for `@` imports.
 *
 * *"a maximum depth of four hops"* — and `canDescend` is `depth < maxDepth` with
 * the root seeded at depth 0, so this admits four hops and refuses the fifth.
 * Pinned from BOTH sides in the test, because a bound asserted from one side
 * cannot tell an off-by-one from a correct one.
 */
const CLAUDE_IMPORT_MAX_DEPTH = 4;

/**
 * The `zone_provenance.contributorId` for one root's import extent.
 *
 * @param rootRelativePath - The root file's path relative to the corpus root
 * @returns The contributor id, unique per root
 */
export function claudeImportContributorId(rootRelativePath: string): string {
  return `${CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX}:${rootRelativePath}`;
}

/**
 * The declaration one import root gets.
 *
 * @param rootRelativePath - The root file's path relative to the corpus root,
 *   forward-slashed, the way `resource_realizations.path` spells it. The caller
 *   converts, because the caller is the one holding the root
 * @returns The declaration, schema-parsed so every default is materialized
 * @throws When the path is empty — a closure with no root closes over nothing
 */
export function claudeImportExtentDeclaration(rootRelativePath: string): ExtentDeclaration {
  return ExtentDeclarationSchema.parse({
    kind: CLAUDE_IMPORT_KIND,
    closureFrom: rootRelativePath,
    follow: ['at-prefixed'],
    referenceDialect: 'claude-import',
    maxDepth: CLAUDE_IMPORT_MAX_DEPTH,
    refusals: [],
    admitPaths: [],
  });
}

/**
 * Every path in a realization set that is an `@`-import root.
 *
 * Roots are the paths the **shipped** {@link classifyPath} tags
 * {@link CLAUDE_MD_TAG} or {@link RULES_FILE_TAG}. Deliberately not a second
 * glob: a parallel spelling of a vocabulary `agentic-tags.ts` owns would drift
 * the first time either side changed, and the drift is SILENT — a private glob
 * keeps matching what it always matched while the classifier moves on.
 *
 * ⚠️ This must run **before** `populate()`, because `ContributorRegistry` keys
 * on `id` and partitions on `kind` before any `contribute` runs. That is the
 * same constraint `buildInventoryPopulation` satisfies by taking `skillMdPaths`
 * as a parameter, and it is why this reads a realization set rather than a
 * `ProjectionBase` it could only obtain too late.
 *
 * Directories are dropped: a directory has no blob, so an extent rooted at one
 * would declare a root the base realizes and the blob stage cannot key, and the
 * closure would report a complete extent of exactly one member — a silent
 * success, which is the shape this codebase refuses everywhere else.
 *
 * @param realizations - Every realization a base enumeration produced
 * @returns Root-relative paths, de-duplicated across realizations of one
 *   identity and SORTED. Sorted because contributor ids are registered in this
 *   order, and a population whose contributor set depends on enumeration order
 *   is not reproducible
 */
export function claudeImportRootsFrom(
  realizations: readonly ResourceRealizationRow[],
): string[] {
  // Derived from the whole path set before any path is classified: a plugin root
  // is a fact about the TREE, and asking it per-path would make the answer
  // depend on iteration order. Same reasoning as `agentic-convention.ts`.
  const pluginRoots = pluginRootsFrom(realizations.map((row) => row.path));
  const roots = new Set<string>();
  for (const row of realizations) {
    if (row.isDirectory) continue;
    const tags = classifyPath(row.path, row.basenameLower, pluginRoots);
    if (tags.some((tag) => tag.tag === CLAUDE_MD_TAG || tag.tag === RULES_FILE_TAG)) {
      roots.add(row.path);
    }
  }
  return [...roots].sort(byCodePoint);
}

/**
 * Order two root-relative paths by UTF-16 code point.
 *
 * ⚠️ Deliberately **not** `String.localeCompare`, which `sonarjs` suggests by
 * default. This order decides the sequence contributor ids are registered in,
 * and `localeCompare` is ICU- and locale-dependent: two machines could register
 * the same roots in different orders, which is precisely the irreproducibility
 * sorting at all was meant to remove. Code-point order is the same everywhere.
 *
 * @param left - One root-relative path
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
function byCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * One `CLAUDE.md` or rules file's import closure.
 *
 * Delegation rather than inheritance, for the reason `SkillExtentContributor`
 * states: this class owns only the two things the registry reads before
 * `contribute` runs — a stable `id` for `zone_provenance`, and the `kind`
 * `ContributorRegistry.forKind` partitions on.
 */
export class ClaudeImportExtentContributor implements ExtentContributor {
  readonly id: string;

  readonly kind: string = CLAUDE_IMPORT_KIND;

  readonly stratum: ContributorStratum = 'closure';

  /** The generic primitive this contributor is nothing but a naming of. */
  readonly #closure: ClosureExtentContributor;

  /**
   * Delegated, never restated: this contributor's `contribute` IS the delegate's,
   * so whether it reads blob-keyed tables is the delegate's answer and a
   * hard-coded `true` here would be a second copy free to drift.
   */
  get readsBlobs(): boolean {
    return this.#closure.readsBlobs;
  }

  /**
   * @param rootRelativePath - The root file's path relative to the corpus root.
   *   Discriminates both the contributor id and, through the delegate, the
   *   extent's within-root context id — one source for both, so the two cannot
   *   drift apart
   */
  constructor(rootRelativePath: string) {
    this.id = claudeImportContributorId(rootRelativePath);
    this.#closure = new ClosureExtentContributor(rootRelativePath, CLAUDE_IMPORT_KIND);
  }

  /**
   * Produce the import extent by running the closure primitive.
   *
   * Not `async`: the delegate's promise is returned directly, so there is no
   * second microtask and no place for this method to add behaviour.
   *
   * @param base - Everything merged so far — the realizations a reference can
   *   resolve to, and the `blob_references` rows that are the edges
   * @param parameters - A {@link claudeImportExtentDeclaration} result, arriving
   *   as config data exactly as a user-declared extent would
   * @returns The extent's context, members, realizations and conditions
   */
  contribute(base: ProjectionBase, parameters: JsonValue): Promise<ExtentContribution> {
    return this.#closure.contribute(base, parameters);
  }
}
