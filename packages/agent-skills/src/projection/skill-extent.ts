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
 * target is an ordinary reachable file, and — since `excludeBasenames`,
 * `excludeKinds` and `admitPaths` were added to the primitive — on three of the
 * cascade discriminators that used to diverge as well. What remains is listed
 * below. Stated here rather than in a report, because a reader reaching for this
 * translation needs the boundary, not the anecdote:
 *
 * | Walker feature | Verdict |
 * |---|---|
 * | `linkFollowDepth` | **expressible** — same union, same off-by-one (`depth < maxDepth`) |
 * | `excludeReferencesFromBundle` *membership* | **expressible** — first-match-wins and any-match select the same file set, so a flat union of every rule's `patterns` is exact |
 * | `excludeReferencesFromBundle` *`template` payload* | **not expressible** — an excluded target emits no row at all, so there is nowhere for `LinkResolution.matchedRule` to land |
 * | `excludeNavigationFiles` | **expressible** — via `excludeBasenames`, the primitive extension this row used to ask for; the basename set is `NAVIGATION_FILE_PATTERNS`, gated on the knob exactly as `classifyExclusion` gates its branch |
 * | `agent-instruction-file` *membership* | **expressible** — `excludeBasenames` carries `AGENT_INSTRUCTION_FILE_PATTERNS` unconditionally, and the explicit-`files:` escape hatch becomes `admitPaths` (see {@link declaredAgentInstructionSources}) |
 * | `directory-target` *membership* | **expressible** — via `excludeKinds: ['directory']`, which reads `resources.kind`; a path glob cannot express it, because a directory's path is shaped like a file's |
 * | `deferredArtifacts` (`files:`) | **not expressible** — its three-way classification is keyed on filesystem existence and on gitignore, and the closure does no I/O by construction. Only the ONE fact `admitPaths` needs — which sources are explicit, non-glob agent-instruction files — is a pure function of the config, which is why that much survives the translation |
 * | routable vs non-routable | **not expressible** (reasoned, not measured — the corpus has no HTML) — `follow` names a reference FORM, never the parser kind of the TARGET, so wherever HTML blob references are populated the closure walks THROUGH a page `isRoutable` treats as a leaf |
 * | `skill-definition` | **not expressible** — the verdict depends on comparing the target against THIS walk's `skillRootPath` (a self-link is silently skipped, a sibling's SKILL.md is refused), and the declaration has no vocabulary for "the same file as my own root" |
 * | `gitignored`, `outside-project`, `unreadable-target`, `missing-target` | **not expressible** — each needs an oracle the closure does not consult: git, the project boundary, and two distinct filesystem-read outcomes |
 * | every exclusion's REASON, and `template` | **still not expressible** — a refused candidate emits no row at all, so `directory-target` vs `navigation-file` vs `pattern-matched` collapses to one payload-free verdict, and `LinkResolution.matchedRule` has nowhere to land |
 *
 * Read the top three rows as membership-only. The primitive now *selects the
 * same files* for those three causes; it still cannot *say why*, and that
 * distinction is not cosmetic — `vat`'s verdict engine reports
 * `LINK_TO_NAVIGATION_FILE` and `LINK_TO_DIRECTORY` as distinct findings, and
 * nothing in the projection can reproduce that split.
 *
 * The `excludeNavigationFiles` row is the one worth reading twice, because the
 * shape of its extension is the argument for why it is a THIRD matcher and not a
 * cleverer glob: `isNavigationBasename` matches a **case-insensitive basename
 * set** (`README.md`, `index.md`, …), while `exclude` is picomatch over a
 * root-relative path. A brace alternation over `README` / `readme` / `Readme`
 * enumerates spellings a case-insensitive filesystem generates freely, so the
 * approximation silently under-matches exactly where the walker's comment says
 * it must not (`Claude.md` is loaded as instructions on APFS just as `CLAUDE.md`
 * is). The honest extension was a declared basename set, and it is what
 * `excludeBasenames` is.
 *
 * ## `closureFrom` is stated in projection coordinates
 *
 * {@link skillExtentDeclaration} takes the SKILL.md path **relative to the
 * corpus root**, the way `resource_realizations.path` spells it, because that is
 * the only coordinate system `closureFrom` is resolved in. The packager works in
 * absolute paths; converting is the caller's job precisely because the caller is
 * the one holding the root.
 */

import { basename } from 'node:path';

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
import { isGlob, safePath } from '@vibe-agent-toolkit/utils';

import {
  AGENT_INSTRUCTION_FILE_PATTERNS,
  NAVIGATION_FILE_PATTERNS,
  isAgentInstructionBasename,
} from '../validators/validation-rules.js';

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
 * The `resources.kind` a directory entity carries.
 *
 * Verified against the producers rather than assumed: both base contributors
 * spell it the same way — `filesystem-extent.ts` and `git-extent.ts` each emit
 * `kind: realization.isDirectory ? 'directory' : 'file'` — and
 * `projection-filesystem-extent.test.ts` pins it ("kinds a directory row
 * 'directory' and a file row 'file'"). That is what makes `excludeKinds` able to
 * stand in for the walker's `classifyPathKind`, whose `directory-target` branch
 * is the FIRST thing it refuses after the deferred check.
 */
const DIRECTORY_KIND = 'directory';

/**
 * The walker's default for `excludeNavigationFiles` when the config declares
 * none — `skill-packager.ts:582` spells it `options.excludeNavigationFiles ?? true`.
 */
const DEFAULT_EXCLUDE_NAVIGATION_FILES = true;

/**
 * The basenames this skill's closure refuses, in the walker's own cascade order
 * of *reasons* (which is unobservable here — see below — but is what a reader
 * comparing the two files will be looking for).
 *
 * `AGENT_INSTRUCTION_FILE_PATTERNS` is unconditional, and that is not an
 * oversight: `refusesAgentInstructionFile` is deliberately NOT gated on
 * `excludeNavigationFiles`, because that knob is about content granularity and
 * these files are about distributability. `NAVIGATION_FILE_PATTERNS` is gated,
 * because `classifyExclusion`'s navigation branch is.
 *
 * Imported from `validation-rules.ts`, never re-spelled: that module is explicit
 * that ONE canonical spelling per name is the whole design, and a second copy
 * here would be the enumeration it warns against.
 *
 * @param config - The skill's packaging block
 * @returns The basenames to refuse, case-insensitively
 */
function skillExcludeBasenames(config: SkillPackagingConfig): string[] {
  const excludeNavigation = config.excludeNavigationFiles ?? DEFAULT_EXCLUDE_NAVIGATION_FILES;
  return [
    ...AGENT_INSTRUCTION_FILE_PATTERNS,
    ...(excludeNavigation ? NAVIGATION_FILE_PATTERNS : []),
  ];
}

/**
 * A `files:` source stated in projection coordinates — root-relative and
 * forward-slashed, the way `resource_realizations.path` spells it.
 *
 * Mirrors `DeferredArtifacts.from`'s source normalization
 * (`relative(projectRoot, resolve(join(projectRoot, source)))`), which strips a
 * leading `./` and roots an absolute-looking source UNDER the project root. In
 * projection coordinates the project root is the empty prefix, so that
 * expression reduces to a normalizing join plus the leading-separator strip.
 *
 * @param source - A `files:` entry's `source`, authored relative to the project root
 * @returns The same path, root-relative and forward-slashed
 */
function rootRelativeSource(source: string): string {
  const joined = safePath.join(source);
  return joined.startsWith('/') ? joined.slice(1) : joined;
}

/**
 * The `files:`-declared agent-instruction files this skill's closure must admit
 * despite {@link skillExcludeBasenames} refusing their basenames.
 *
 * ⚠️ **The asymmetry here is the walker's cascade ORDER, and it belongs in this
 * translation rather than in the primitive.** `walk-link-graph.ts`'s
 * `classifyExclusion` refuses `navigation-file` BEFORE it reaches the
 * agent-instruction branch, and only the agent-instruction branch carries the
 * explicit-`files:` escape hatch. A `files:`-declared `README.md` linked from a
 * SKILL.md is therefore STILL excluded by the walker, as `navigation-file` — the
 * hatch never gets a chance to run. The primitive has no cascade to encode that
 * in (its three refusal matchers are unordered by construction, because they all
 * return the same payload-free verdict), so the ordering fact is discharged HERE
 * by narrowing which declarations earn `admitPaths` at all.
 *
 * "Explicit" is EXACT membership in `DeferredArtifacts.sourcePaths`, which is
 * why a GLOB source earns nothing: `DeferredArtifacts.from` registers a glob by
 * its STATIC BASE (a directory), so a glob's matches are only ever prefix
 * CHILDREN of what is in the set and the walker's exact-equality test refuses
 * them. `refusesAgentInstructionFile` states the reasoning in full: naming a
 * file is an unambiguous instruction to ship it, a glob is a net that never
 * named the file it caught.
 *
 * ⚠️ **One narrowing the walker applies and this cannot.** Both walker lanes
 * build their `DeferredArtifacts` from `partitionTestInputFileEntries(...).kept`
 * (`skill-packager.ts:593`, `packaging-validator.ts:523`), so a `files:` entry
 * whose source lives under a declared `test.evals` suite is dropped before it can
 * earn the hatch. Reproducing that needs `resolveTestInputDirs`, which probes the
 * filesystem and needs the project's whole skill list — neither of which a
 * config→declaration translation has, by construction. A `test.evals`-resident
 * `CLAUDE.md` declared in `files:` would therefore be admitted here and refused
 * by the walker. Unreachable on the real corpus today: the corpus shadow test
 * ("omitting the packager-only walk inputs changes no membership") measures the
 * `test.evals` overlap across all fourteen declared skills and finds it empty.
 *
 * @param config - The skill's packaging block
 * @returns Root-relative paths that outrank every refusal matcher
 */
function declaredAgentInstructionSources(config: SkillPackagingConfig): string[] {
  const admitted: string[] = [];
  for (const entry of config.files ?? []) {
    if (isGlob(entry.source)) continue;
    const source = rootRelativeSource(entry.source);
    if (isAgentInstructionBasename(basename(source))) admitted.push(source);
  }
  return admitted;
}

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
    // `classifyPathKind`'s `directory-target` branch refuses a directory
    // unconditionally — no knob gates it — so this list is unconditional too.
    excludeKinds: [DIRECTORY_KIND],
    excludeBasenames: skillExcludeBasenames(config),
    admitPaths: declaredAgentInstructionSources(config),
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
