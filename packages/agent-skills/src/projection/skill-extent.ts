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
 * target is an ordinary reachable file, and — since the primitive gained a
 * labelled `refusals` cascade plus `admitPaths` — on three of the cascade
 * discriminators that used to diverge, and now on their REASONS as well. What
 * remains is listed below. Stated here rather than in a report, because a reader
 * reaching for this translation needs the boundary, not the anecdote:
 *
 * | Walker feature | Verdict |
 * |---|---|
 * | `linkFollowDepth` | **expressible** — same union, same off-by-one (`depth < maxDepth`) |
 * | `excludeReferencesFromBundle` *membership* | **expressible** — first-match-wins and any-match select the same file set; carried as ONE refusal rule per declared rule, in declared order, which selects the same set the flat union did |
 * | `excludeReferencesFromBundle` *WHICH rule matched* | **expressible** — one refusal rule apiece means the primitive's first-match-wins scan is `excludeMatchers.find(...)`'s scan, and the winner's first pattern lands in `realization_conditions.matchedPattern`, the column `packaging-validator.ts` reads as `matchedRule.patterns[0]` |
 * | `excludeReferencesFromBundle` *`template` payload* | **expressible** — carried verbatim in `ExtentRefusalRule.payload` (opaque to the primitive) and reported as `realization_conditions.matchedPayload`, beside the rule's declared index. ⚠️ Never MEASURED against the walker: no shipped config declares a `template`, so the corpus shadow synthesizes one to compare the two arms |
 * | `excludeNavigationFiles` | **expressible** — a refusal rule over `NAVIGATION_FILE_PATTERNS`, gated on the knob exactly as `classifyExclusion` gates its branch |
 * | `agent-instruction-file` *membership* | **expressible** — a refusal rule over `AGENT_INSTRUCTION_FILE_PATTERNS`, unconditionally, and the explicit-`files:` escape hatch becomes `admitPaths` (see {@link declaredAgentInstructionSources}) |
 * | `directory-target` *membership* | **expressible** — a refusal rule over `kinds: ['directory']`, which reads `resources.kind`; a path glob cannot express it, because a directory's path is shaped like a file's |
 * | the REASON of those four exclusions | **expressible** — each refusal rule carries a `label`, and the first-match-wins order is `classifyExclusion`'s own branch order, so the refusal reports `SKILL_REFUSED_DIRECTORY_TARGET` where the walker reports `directory-target`. Pinned by the corpus shadow's reason-mismatch bucket, not asserted here |
 * | `deferredArtifacts` (`files:`) | **not expressible** — its three-way classification is keyed on filesystem existence and on gitignore, and the closure does no I/O by construction. Only the ONE fact `admitPaths` needs — which sources are explicit, non-glob agent-instruction files — is a pure function of the config, which is why that much survives the translation |
 * | routable vs non-routable | **not expressible** (reasoned, not measured — the corpus has no HTML) — `follow` names a reference FORM, never the parser kind of the TARGET, so wherever HTML blob references are populated the closure walks THROUGH a page `isRoutable` treats as a leaf |
 * | `skill-definition` | **not expressible** — the verdict depends on comparing the target against THIS walk's `skillRootPath` (a self-link is silently skipped, a sibling's SKILL.md is refused), and the declaration has no vocabulary for "the same file as my own root" |
 * | `gitignored`, `outside-project`, `unreadable-target`, `missing-target` | **not expressible** — each needs an oracle the closure does not consult: git, the project boundary, and two distinct filesystem-read outcomes |
 * | a refusal's PROVENANCE (`sourcePath`, `sourceLine`, `linkHref`, `targetExists`, `matchedRule`) | **expressible** — `realization_conditions` gained the six columns (projection schema v4), the closure fills them at the refusal site, and every one of the five is compared field by field against the walker's own row by the corpus shadow's provenance bucket |
 *
 * Read the membership, reason and provenance rows together: the primitive now
 * selects the same files for those causes, names the same cause, and carries the
 * same `sourcePath`/`sourceLine`/`linkHref`/`targetExists`/matched-rule
 * provenance the walker attaches to a refusal. What a projection still cannot
 * produce is the SEVEN reasons whose oracles it does not consult (git, the
 * project boundary, two read outcomes, its own skill root) — that, not the
 * payload, is what now stands between this and driving `vat`'s verdict engine
 * from a projection.
 *
 * The `excludeNavigationFiles` row is the one worth reading twice, because the
 * shape of its extension is the argument for why a rule needs a basename matcher
 * and not a cleverer glob: `isNavigationBasename` matches a **case-insensitive
 * basename set** (`README.md`, `index.md`, …), while `patterns` is picomatch
 * over a root-relative path. A brace alternation over `README` / `readme` /
 * `Readme` enumerates spellings a case-insensitive filesystem generates freely,
 * so the approximation silently under-matches exactly where the walker's comment
 * says it must not (`Claude.md` is loaded as instructions on APFS just as
 * `CLAUDE.md` is). The honest extension was a declared basename set, and it is
 * what `ExtentRefusalRule.basenames` is.
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
  type ExtentRefusalRule,
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
 * One declared `excludeReferencesFromBundle` rule, read off the config type
 * rather than off `walk-link-graph.ts`'s structurally identical `ExcludeRule`.
 *
 * The translation's input is the CONFIG, and deriving the type from it is what
 * makes a config-side change (a third field, say) a compile error here instead of
 * a silent drop.
 */
type DeclaredExcludeRule =
  NonNullable<SkillPackagingConfig['excludeReferencesFromBundle']>['rules'][number];

/**
 * The four refusal labels this translation supplies, one per `classifyExclusion`
 * branch it can express.
 *
 * SCREAMING_SNAKE because they land in `realization_conditions.code`, whose two
 * existing members (`CLOSURE_REFERENCE_UNRESOLVED`, `CLOSURE_ROOT_ABSENT`) set
 * that convention. Prefixed `SKILL_REFUSED_` because that column is an OPEN
 * vocabulary shared by every contributor in a population: a bare
 * `DIRECTORY_TARGET` would not say whose cascade decided it.
 *
 * The walker reason each one stands for is in its own doc line, and that mapping
 * is asserted end-to-end by the corpus shadow's reason-mismatch bucket rather
 * than trusted — see `projection-skill-extent-corpus.integration.test.ts`.
 */
/** `classifyPathKind`'s `directory-target`. */
export const SKILL_REFUSED_DIRECTORY_TARGET = 'SKILL_REFUSED_DIRECTORY_TARGET';

/** `classifyExclusion`'s `navigation-file`. */
export const SKILL_REFUSED_NAVIGATION_FILE = 'SKILL_REFUSED_NAVIGATION_FILE';

/** `classifyExclusion`'s `agent-instruction-file`. */
export const SKILL_REFUSED_AGENT_INSTRUCTION_FILE = 'SKILL_REFUSED_AGENT_INSTRUCTION_FILE';

/** `classifyExclusion`'s `pattern-matched`, from `excludeReferencesFromBundle`. */
export const SKILL_REFUSED_PATTERN_MATCHED = 'SKILL_REFUSED_PATTERN_MATCHED';

/**
 * This skill's refusal cascade, **in `classifyExclusion`'s own branch order**.
 *
 * ⚠️ The order is load-bearing now that a refusal carries a label: the primitive
 * is first-match-wins, so a directory that also matches an
 * `excludeReferencesFromBundle` pattern must be attributed to `directory-target`
 * — which is what the walker does, and which the previous flat encoding got
 * backwards (its glob matcher ran before its kind matcher, harmlessly, because
 * no verdict carried a reason to get wrong).
 *
 * The four rules, and why each sits where it does:
 *
 * 1. **kinds `['directory']`** — `classifyPathKind` is the FIRST thing
 *    `classifyExclusion` consults after the deferred check, and no knob gates it.
 * 2. **navigation basenames** — gated on `excludeNavigationFiles`, because
 *    `classifyExclusion`'s navigation branch is. Omitted entirely rather than
 *    emitted empty when the knob is off, so the declaration says "this branch
 *    does not run" rather than "it runs and catches nothing".
 * 3. **agent-instruction basenames** — unconditional, and that is not an
 *    oversight: `refusesAgentInstructionFile` is deliberately NOT gated on
 *    `excludeNavigationFiles`, because that knob is about content granularity
 *    while these files are about distributability. Sitting AFTER navigation is
 *    what makes a `files:`-declared `README.md` report `navigation-file` — see
 *    {@link declaredAgentInstructionSources} for the other half of that rule.
 * 4. **one rule per `excludeReferencesFromBundle` rule**, in declared order,
 *    last — see below.
 *
 * ## Why the exclude rules are ONE RULE EACH and not one flattened rule
 *
 * They used to flatten into a single refusal rule holding every rule's patterns,
 * which selected the same files and reported the same label but could not say
 * WHICH declared rule caught a file — so `LinkResolution.matchedRule`, which
 * `packaging-validator.ts:1182` reads `patterns[0]` off, had no counterpart.
 *
 * Expanding them restores it **without touching the reported reason**: every
 * expanded rule carries the SAME {@link SKILL_REFUSED_PATTERN_MATCHED} label, so
 * `realization_conditions.code` is unchanged, while the primitive's
 * first-match-wins scan over them is exactly `excludeMatchers.find(...)`'s scan
 * over `options.excludeRules` — same order, same winner. A label is a REASON and
 * reasons are shared; identity rides on the rule's position and its `payload`.
 *
 * ⚠️ They all stay in the glob branch's position, AFTER the basename rules: the
 * expansion widens one cascade step into N, it does not reorder the cascade. And
 * a config declaring no rules now contributes NO rule rather than one empty one —
 * an empty pattern list never matched anything, and "one rule per declared rule"
 * is a shape a reader can check against the config, which "always exactly one"
 * was not.
 *
 * Each expanded rule's `payload` carries what the primitive has no column for:
 * the rule's INDEX in the declared array (identity, when two rules share a first
 * pattern) and its `template` (the walker's own `ExcludeRule.template`, which no
 * `realization_conditions` column could hold without teaching the closure about
 * skill packaging).
 *
 * Basename lists are imported from `validation-rules.ts`, never re-spelled: that
 * module is explicit that ONE canonical spelling per name is the whole design,
 * and a second copy here would be the enumeration it warns against.
 *
 * @param config - The skill's packaging block
 * @returns The ordered refusal rules
 */
function skillRefusals(config: SkillPackagingConfig): ExtentRefusalRule[] {
  const excludeNavigation = config.excludeNavigationFiles ?? DEFAULT_EXCLUDE_NAVIGATION_FILES;
  return [
    // `flags: {}` on every rule: the packaging walk's own gitignore branch needs
    // an ORACLE (`readGitignored` spawns `git check-ignore` when no tracker is
    // plumbed), and `skill-extent.ts`'s table records it as inexpressible for
    // that reason. The empty record is the schema default and never matches, so
    // spelling it here declares "this translation refuses on no column" rather
    // than leaving a reader to infer it from an absent key.
    {
      label: SKILL_REFUSED_DIRECTORY_TARGET,
      patterns: [],
      basenames: [],
      kinds: [DIRECTORY_KIND],
      flags: {},
      payload: null,
    },
    ...(excludeNavigation
      ? [{
        label: SKILL_REFUSED_NAVIGATION_FILE,
        patterns: [],
        basenames: [...NAVIGATION_FILE_PATTERNS],
        kinds: [],
        flags: {},
        payload: null,
      }]
      : []),
    {
      label: SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
      patterns: [],
      basenames: [...AGENT_INSTRUCTION_FILE_PATTERNS],
      kinds: [],
      flags: {},
      payload: null,
    },
    // `payload: null` above, a payload here: the first three rules ARE the
    // walker's own branches, which carry no rule object for a consumer to read
    // back (`makeExclusion` sets `matchedRule` only for `pattern-matched`).
    ...(config.excludeReferencesFromBundle?.rules ?? []).map((rule, index) => ({
      label: SKILL_REFUSED_PATTERN_MATCHED,
      patterns: [...rule.patterns],
      basenames: [],
      kinds: [],
      flags: {},
      payload: excludeRulePayload(rule, index),
    })),
  ];
}

/**
 * One `excludeReferencesFromBundle` rule's identity, as opaque payload.
 *
 * `template` is the field the old flat encoding lost outright — the skill
 * extent's own boundary table used to record it as "not expressible", and it is
 * expressible now precisely because the payload is a channel the primitive never
 * reads. `ruleIndex` is what distinguishes two rules that share a first pattern,
 * which `matchedPattern` alone cannot.
 *
 * `template: null` rather than an omitted key, because the row this lands in is
 * read as data: a consumer asking "did this rule declare a template" must not
 * have to distinguish an absent key from a null one.
 *
 * @param rule - One declared exclude rule
 * @param index - Its 0-based position in the declared array — first-match-wins order
 * @returns The rule's payload, JSON-shaped
 */
function excludeRulePayload(rule: DeclaredExcludeRule, index: number): JsonValue {
  return { ruleIndex: index, template: rule.template ?? null };
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
 * ⚠️ **The asymmetry here is the walker's cascade ORDER, and it stays in this
 * translation even though the primitive now has a cascade of its own.**
 * `walk-link-graph.ts`'s `classifyExclusion` refuses `navigation-file` BEFORE it
 * reaches the agent-instruction branch, and only the agent-instruction branch
 * carries the explicit-`files:` escape hatch. A `files:`-declared `README.md`
 * linked from a SKILL.md is therefore STILL excluded by the walker, as
 * `navigation-file` — the hatch never gets a chance to run. {@link skillRefusals}
 * reproduces the ORDER, so the reported reason is right; it cannot reproduce the
 * hatch's POSITION, because `admitPaths` outranks the whole cascade rather than
 * sitting inside one branch of it. So the positional fact is discharged HERE, by
 * narrowing which declarations earn `admitPaths` at all — a per-branch escape
 * hatch is a primitive feature nothing else has asked for.
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
 * `excludeReferencesFromBundle` rule's `patterns` flatten into ONE labelled
 * refusal rule — sound because the walker's `find` and the primitive's `some`
 * select the same file set AND report the same reason (`pattern-matched` for all
 * of them); which rule won is observable only through its `template`, which the
 * primitive still has nowhere to put.
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
    refusals: skillRefusals(config),
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
