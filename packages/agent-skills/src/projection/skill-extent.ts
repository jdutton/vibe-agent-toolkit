/**
 * The **skill** extent, expressed as the generic closure primitive plus a
 * declaration — zones.md §7.3's adequacy test, run for real.
 *
 * §7.3 requires that *a built-in extent must be expressible the way a
 * config-declared one would be*. A skill bundle is the hardest case VAT has,
 * because a privileged walker (`walk-link-graph.ts`) already computes it, so
 * this module is the falsification: it translates a `SkillPackagingConfig` into
 * an {@link ExtentDeclaration} and hands it to `ClosureExtentContributor`. There
 * is deliberately **no bespoke walker here**. A second walker that passed its
 * own tests would prove nothing about the primitive — it would only prove that
 * the skill contributor can stay privileged, which is the outcome §17 risk 3
 * asks about.
 *
 * ## What the primitive expresses, measured against the shipped walker
 *
 * The equality experiment lives in `test/projection-skill-extent.test.ts`, and
 * its result is that **membership** agrees exactly on a corpus whose every link
 * target is an ordinary reachable file, and diverges on five features the
 * primitive has no vocabulary for. Stated here rather than in a report, because
 * a reader reaching for this translation needs the boundary, not the anecdote:
 *
 * | Walker feature | Verdict |
 * |---|---|
 * | `linkFollowDepth` | **expressible** — same union, same off-by-one (`depth < maxDepth`) |
 * | `excludeReferencesFromBundle` *membership* | **expressible** — first-match-wins and any-match select the same file set, so a flat union of every rule's `patterns` is exact |
 * | `excludeReferencesFromBundle` *`template` payload* | **not expressible** — an excluded target emits no row at all, so there is nowhere for `LinkResolution.matchedRule` to land |
 * | `excludeNavigationFiles` | **expressible-with-a-primitive-extension** — a basename predicate, not a glob over a root-relative path; a recursive glob ending in `README.md` approximates it but is a different predicate (see below) |
 * | `deferredArtifacts` (`files:`) | **not expressible** — its three-way classification is keyed on filesystem existence and on gitignore, and the closure does no I/O by construction |
 * | routable vs non-routable | **not expressible** (reasoned, not measured — the corpus has no HTML) — `follow` names a reference FORM, never the parser kind of the TARGET, so wherever HTML blob references are populated the closure walks THROUGH a page `isRoutable` treats as a leaf |
 * | the other six cascade discriminators | **not expressible** — `directory-target`, `outside-project`, `agent-instruction-file`, `skill-definition`, `gitignored`, `missing-target` are each a verdict with a reason, and `exclude` returns a verdict with none |
 *
 * The `excludeNavigationFiles` row is the one worth reading twice. It is close
 * enough to look expressible and is not: `isNavigationBasename` matches a
 * **case-insensitive basename set** (`README.md`, `index.md`, …), while
 * `exclude` is picomatch over a root-relative path. A brace alternation over
 * `README` / `readme` / `Readme` enumerates spellings a case-insensitive
 * filesystem generates freely, so the approximation silently under-matches
 * exactly where the walker's comment says
 * it must not (`Claude.md` is loaded as instructions on APFS just as `CLAUDE.md`
 * is). The honest extension is a declared basename set, not a cleverer glob.
 *
 * ## `closureFrom` is stated in projection coordinates
 *
 * {@link skillExtentDeclaration} takes the SKILL.md path **relative to the
 * corpus root**, the way `resource_realizations.path` spells it, because that is
 * the only coordinate system `closureFrom` is resolved in. The packager works in
 * absolute paths; converting is the caller's job precisely because the caller is
 * the one holding the root.
 */

import {
  ClosureExtentContributor,
  ExtentDeclarationSchema,
  type ContributorStratum,
  type ExtentContribution,
  type ExtentContributor,
  type ExtentDeclaration,
  type JsonValue,
  type ProjectionBase,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/resources';

/**
 * `zone_provenance.contributorId` prefix for a skill extent.
 *
 * **Per-skill, not fixed.** The plan specced a bare `builtin:skill`, which was
 * written before anyone asked how many skills a corpus has:
 * `ContributorRegistry.register` refuses a duplicate id, so a fixed id caps a
 * population at **one** skill extent — and this repo alone ships thirteen. The
 * extent ids were already distinct (the skill name is the within-root
 * discriminator); only the contributor key space collided. Nothing schema-level
 * objects: `zone_provenance.contributorId` is an open string.
 */
export const SKILL_EXTENT_CONTRIBUTOR_ID_PREFIX = 'builtin:skill';

/**
 * The `zone_provenance.contributorId` for one skill's extent.
 *
 * @param skillName - The skill's name
 * @returns The contributor id, unique per skill
 */
export function skillExtentContributorId(skillName: string): string {
  return `${SKILL_EXTENT_CONTRIBUTOR_ID_PREFIX}:${skillName}`;
}

/** The `resolution_contexts.kind` a skill extent has. */
export const SKILL_EXTENT_KIND = 'skill';

/**
 * The hop budget a skill bundle gets when its config declares none.
 *
 * Two shipped sites spell this `?? 2` — `skill-packager.ts:580` and
 * `packaging-validator.ts:484` — so the translation must default the same way or
 * a config-less skill would project a different extent from the one it packages.
 */
const DEFAULT_LINK_FOLLOW_DEPTH = 2;

/**
 * Translate a skill's packaging config into a closure-extent declaration.
 *
 * This is the whole of the skill extent's behaviour: everything else is the
 * generic contributor. `linkFollowDepth` becomes `maxDepth` unchanged (same
 * `number | 'full'` union, same meaning of a hop), and every
 * `excludeReferencesFromBundle` rule's `patterns` flatten into one `exclude`
 * list — sound for membership because the walker's `find` and the primitive's
 * `some` select the same file set, and ordering is only observable through the
 * winning rule's `template`, which is not a membership fact.
 *
 * `follow` is left to the schema default (the three markdown forms), matching
 * the walker: it processes only `isLocalFileLink` links off the markdown AST, so
 * an `@`-prefixed or bare token is not an edge on either side.
 *
 * @param config - The skill's `skills.config.<name>` packaging block
 * @param skillPath - The SKILL.md path **relative to the corpus root**, forward-slashed
 * @returns The declaration, schema-parsed so every default is materialized
 * @throws When the resulting declaration is not schema-valid — e.g. an empty `skillPath`
 */
export function skillExtentDeclaration(
  config: SkillPackagingConfig,
  skillPath: string,
): ExtentDeclaration {
  return ExtentDeclarationSchema.parse({
    kind: SKILL_EXTENT_KIND,
    closureFrom: skillPath,
    maxDepth: config.linkFollowDepth ?? DEFAULT_LINK_FOLLOW_DEPTH,
    exclude: (config.excludeReferencesFromBundle?.rules ?? []).flatMap((rule) => rule.patterns),
  });
}

/**
 * The skill extent — `ClosureExtentContributor` under a fixed id and kind.
 *
 * Delegation rather than inheritance, and the thinness is the finding: if this
 * class needed to *do* anything, the closure primitive would have been
 * inadequate and the skill contributor would have stayed privileged. It owns
 * only the two things the registry reads before `contribute` runs — a stable
 * `id` for `zone_provenance`, and the `kind` `ContributorRegistry.forKind`
 * partitions on.
 *
 * **One instance per skill**, keyed by {@link skillExtentContributorId}. A fixed
 * id would cap a population at one skill extent, because
 * `ContributorRegistry.register` refuses a duplicate — see that function.
 */
export class SkillExtentContributor implements ExtentContributor {
  readonly id: string;

  readonly kind: string = SKILL_EXTENT_KIND;

  readonly stratum: ContributorStratum = 'closure';

  /** The generic primitive this contributor is nothing but a naming of. */
  readonly #closure: ClosureExtentContributor;

  /**
   * @param skillName - The skill's name. Discriminates both the contributor id
   *   and, through the delegate, the extent's within-root context id — one
   *   source for both, so the two cannot drift apart.
   */
  constructor(skillName: string) {
    this.id = skillExtentContributorId(skillName);
    this.#closure = new ClosureExtentContributor(skillName, SKILL_EXTENT_KIND);
  }

  /**
   * Produce the skill extent by running the closure primitive.
   *
   * Not `async`: the delegate's promise is returned directly, so there is no
   * second microtask and no place for this method to add behaviour.
   *
   * @param base - Everything merged so far — the realizations a reference can
   *   resolve to, and the `blob_references` rows that are the edges
   * @param parameters - A {@link skillExtentDeclaration} result, arriving as
   *   config data exactly as a user-declared extent would
   * @returns The extent's context, members, realizations and conditions
   */
  contribute(base: ProjectionBase, parameters: JsonValue): Promise<ExtentContribution> {
    return this.#closure.contribute(base, parameters);
  }
}
