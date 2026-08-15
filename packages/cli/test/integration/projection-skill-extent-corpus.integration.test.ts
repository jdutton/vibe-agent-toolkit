/**
 * The projection's skill extent, run as a **shadow** of the shipped walker over
 * this repository's real skill corpus — Stage 2 of the closure-primitive
 * migration, and now Stage 3's gate.
 *
 * ## Stage 3: the arms AGREE, and the control is what makes that mean something
 *
 * Stage 2 measured the closure as a strict SUPERSET of the walker and attributed
 * every difference to four causes ({@link KNOWN_CAUSES}) — three branches of
 * `classifyExclusion`'s cascade a glob `exclude` list cannot express, plus the
 * transitive subtree behind them. Stage 3 gave the primitive the vocabulary for a
 * **refusal at a hub** ({@link NARROWING_LABELS} and {@link NARROWING_FIELDS}),
 * and the swept comparison now finds no difference at any depth.
 *
 * A green "no difference" is the weakest kind of result, so it is not the only
 * one asserted. The sweep runs a **second time with that vocabulary stripped and
 * nothing else changed**, and must reproduce all four causes with pruning still
 * dominant. Agreement that survives its own negative control is a measurement;
 * agreement on its own is satisfied by a closure that returned nothing.
 *
 * ## Two comparisons, not one: membership AND the stated reason
 *
 * Membership agreement is the older half. The refusal cascade also makes the two
 * arms comparable on WHY a candidate was turned away, so
 * {@link compareReasons} takes every path BOTH arms refused and checks the
 * closure's condition code against the walker's own `excludeReason` through an
 * explicit four-entry table ({@link REASON_TO_REFUSAL_CODE}). The count of paths
 * compared is asserted non-zero beside the mismatch list, because an empty
 * mismatch list over an empty comparison is the same vacuous pass a zero-cell
 * sweep would give. Demonstrated falsifiable rather than assumed: swapping two
 * labels in the translation leaves membership untouched and turns 15 of the 59
 * compared paths into mismatches.
 *
 * `packages/agent-skills/test/projection-skill-extent.test.ts` already compares
 * `SkillExtentContributor` with `walkLinkGraph` at *fixture* scale, on a corpus
 * built to reach the walker's discriminators. This file asks the other half of
 * the question: over the skills VAT actually ships, under the configs VAT
 * actually declares, do the two agree?
 *
 * ## The first answer is that the production corpus cannot tell them apart
 *
 * Measured, and asserted below rather than remembered: under the shipped
 * configs, **every one of the fourteen declared skills bundles exactly its own
 * `SKILL.md` and nothing else**. Twelve declare `linkFollowDepth: 0`; the other
 * two carry only `https:` links and `../../../../docs/**` links that leave the
 * project root. So both implementations return a singleton for every skill, and
 * they agree — which is a true statement that establishes nothing. A corpus that
 * cannot make the two answers differ makes an equality assertion over it
 * vacuous.
 *
 * That is why {@link CORPORA} has a third entry. `repo-root` walks the *same
 * real files under the same real configs* against this repository's root
 * instead of each package's own, which is the one ambient input that turns those
 * `../../../../docs/**` pointers into in-project edges. Nothing is invented: the
 * links are the ones the skills already carry, and the depth sweep re-runs both
 * arms across `linkFollowDepth` 0…full so the depth cap, the navigation-file
 * rule, the agent-instruction rule and the directory-target rule are all reached.
 *
 * ## Why this test lives in `cli`
 *
 * Because "under the configs VAT actually declares" is a `cli` fact. The merged
 * `skills.defaults` + `skills.config.<name>` block is produced by
 * `mergeSkillPackagingConfig`, and the skill set by `discoverSkillsFromConfig`,
 * both of which live here and are what `vat skills build`, `vat audit` and
 * `vat skill review` all read. Re-deriving either inside `agent-skills` would be
 * a second opinion about the corpus — and a shadow whose two arms disagree about
 * *which skills, under which config* is not a shadow of anything.
 *
 * `cli` is also the only package that can see all three: the discovery/merge
 * above, `walkLinkGraph` (`agent-skills`), and `populate` (`resources`).
 *
 * ## Both arms are driven the way production drives them
 *
 * - **Walker arm.** One `createProjectRegistry(root)` per corpus — the registry
 *   `packageSkills` builds once and reuses — then one `walkLinkGraph` per skill
 *   with the options `skill-packager.ts:600` assembles.
 * - **Closure arm.** One `populate()` per corpus, with the filesystem extent and
 *   one `SkillExtentContributor` per skill, exactly as
 *   `projection-population.integration.test.ts` registers them. Not a
 *   hand-assembled base: the closure stratum's fixpoint, the blob stage and
 *   `blob_references` all come from the driver.
 *
 * ## What is deliberately NOT handed to the walker
 *
 * `packageSkill` adds two more inputs to its walk that
 * {@link skillExtentDeclaration} does not model, and handing them to only one
 * arm would manufacture a difference that says nothing about the primitive:
 * `testInputExcludeRules(...)` (derived from `test.evals`) and
 * `deferredArtifacts` (the `files:` model). Both are withheld from **both** arms,
 * and the cost of withholding them is measured, not assumed — see
 * `'omitting the packager-only walk inputs changes no membership'`.
 *
 * ⚠️ **That symmetry is no longer perfect, and the gap is stated rather than
 * papered over.** Since Stage 3, {@link skillExtentDeclaration} derives
 * `admitPaths` from `config.files` — so the closure arm models the one slice of
 * the `files:` model that is a pure function of the config (which sources are
 * explicit, non-glob agent-instruction files), while the walker arm is handed no
 * `deferredArtifacts` at all and therefore short-circuits its escape hatch on
 * `declaredSources === undefined`. A skill declaring an agent-instruction file
 * in `files:` would be admitted by the closure and refused by the walker HERE,
 * and that difference would be an artefact of this file's inputs rather than a
 * fact about the primitive.
 *
 * It does not bite today: no declared skill has such an entry, which is why both
 * arms still agree. It is left one-sided rather than fixed because handing the
 * walker a `deferredArtifacts` built from `config.files` alone would still not
 * match the packager — both production lanes build theirs from
 * `partitionTestInputFileEntries(...).kept` — so the "equal inputs" this section
 * promises would become a different inequality wearing a costume. The
 * fixture-scale comparison in `projection-skill-extent.test.ts` DOES plumb it,
 * per skill, exactly as `skill-packager.ts:599` does, and that is where the
 * hatch is exercised as a genuine two-arm agreement.
 *
 * ## One known divergence this corpus cannot reach, stated so it is not read as absent
 *
 * `walkLinkGraph`'s asset handling ignores `maxDepth`: `processLink` adds a
 * non-markdown target to `bundledAssetSet` unconditionally, while the depth check
 * lives in `processRegistryResource` and is reached only for a registry member.
 * That produces a `walkerOnly` difference — the one direction this corpus never
 * shows — and it is unreachable here because **no declared skill links directly
 * to a non-markdown file**. It stays pinned at fixture scale, in
 * `projection-skill-extent.test.ts`'s `linkFollowDepth 0` and cascade cases.
 * `expect(walkerOnly).toEqual([])` below is therefore a measurement of this
 * corpus, not a claim that the walker has no such branch.
 */

import {
  SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
  SKILL_REFUSED_DIRECTORY_TARGET,
  SKILL_REFUSED_NAVIGATION_FILE,
  SKILL_REFUSED_PATTERN_MATCHED,
  SkillExtentContributor,
  createProjectRegistry,
  skillExtentContributorId,
  skillExtentDeclaration,
  walkLinkGraph,
  type LinkResolution,
  type SkillPackagingConfig,
  type WalkLinkGraphOptions,
  type WalkableRegistry,
} from '@vibe-agent-toolkit/agent-skills';
import {
  CLOSURE_REFERENCE_UNRESOLVED,
  CLOSURE_ROOT_ABSENT,
  ContributorRegistry,
  FilesystemExtentContributor,
  ProjectionBuilder,
  populate,
  type JsonValue,
  type Projection,
  type ProjectionBase,
} from '@vibe-agent-toolkit/resources';
import { GitTracker, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { discoverSkillsFromConfig } from '../../src/commands/skills/skill-discovery.js';
import { loadConfigCached } from '../../src/utils/config-loader.js';
import { mergeSkillPackagingConfig } from '../../src/utils/skill-packaging-config.js';

// ============================================================================
// The corpus
// ============================================================================

/** The repository root, four levels up from this file. */
const REPO_ROOT = safePath.resolve(__dirname, '..', '..', '..', '..');

/** The two VAT projects in this repository that declare a `skills:` section. */
const DEV_AGENTS = 'packages/vat-development-agents';
const CAT_AGENTS = 'packages/vat-example-cat-agents';

/** One corpus: a set of declared skills, resolved against one project root. */
interface CorpusSpec {
  /** Stable name, appearing in every printed table. */
  readonly label: string;
  /** Roots whose `skills:` sections declare the skills, repo-relative. */
  readonly configRoots: readonly string[];
  /** The project root both arms state every path against, repo-relative. */
  readonly projectRoot: string;
  /** What this corpus is for — printed with the run. */
  readonly note: string;
}

/**
 * The corpora, in increasing order of what they can distinguish.
 *
 * The first two are the production configuration: the project root each skill's
 * `findProjectRoot(dirname(skillPath))` actually resolves to. The third is the
 * same files and the same configs against the repository root — the only corpus
 * of the three in which either implementation follows an edge at all.
 */
const CORPORA: readonly CorpusSpec[] = [
  {
    label: 'production/dev-agents',
    configRoots: [DEV_AGENTS],
    projectRoot: DEV_AGENTS,
    note: 'the root findProjectRoot resolves for these skills',
  },
  {
    label: 'production/cat-agents',
    configRoots: [CAT_AGENTS],
    projectRoot: CAT_AGENTS,
    note: 'the root findProjectRoot resolves for this skill',
  },
  {
    label: 'repo-root',
    configRoots: [DEV_AGENTS, CAT_AGENTS],
    projectRoot: '.',
    note: 'same files, same configs, wider root — the corpus that CAN distinguish',
  },
];

/** The packager's own default when `linkFollowDepth` is absent (skill-packager.ts:580). */
const DEFAULT_DEPTH = 2;

/** The packager's own default when `excludeNavigationFiles` is absent. */
const DEFAULT_EXCLUDE_NAVIGATION = true;

/**
 * Depths the sweep re-runs both arms at, over the `repo-root` corpus.
 *
 * The shipped configs pin twelve of the fourteen skills at `0`, so without this
 * sweep the corpus's own declarations would keep the walk from ever starting.
 * Every value here is one `SkillPackagingConfigSchema` accepts.
 */
const SWEPT_DEPTHS: readonly (number | 'full')[] = [0, 1, 2, 'full'];

/** Repeats each timing arm runs. The estimator is `min`, never a median. */
const TIMING_REPEATS = 9;

/**
 * Skills the two configs declare, as of this writing.
 *
 * Pinned so a discovery that silently found *fewer* skills cannot pass as
 * agreement: every assertion here is over the skills the run enumerated, and a
 * run that enumerated none would satisfy all of them.
 */
const TOTAL_DECLARED_SKILLS = 14;

/** The transitive divergence cause — see {@link DivergenceCause}. */
const PRUNED = 'pruned-behind-exclusion';

/**
 * The one directory a shipped `excludeReferencesFromBundle` rule rejects on this
 * corpus: `vat-example-cat-agents` declares `**\/agents/**`, and its SKILL.md
 * links nine documents under it. Every other declared rule (`docs/**`,
 * `packages/**\/README.md`) sits on a skill pinned at `linkFollowDepth: 0`, where
 * no rule ever gets a candidate to judge.
 */
const EXCLUDED_DIRECTORY = 'vat-example-cat-agents/resources/agents';

/**
 * The skill that declares the rule above.
 *
 * The check is scoped to it because an exclude rule is per-skill: another skill
 * reaching the same directory at `linkFollowDepth: 'full'` has declared no rule
 * against it and is right to bundle it.
 */
const EXCLUDING_SKILL = 'vat-example-cat-agents';

/**
 * Every cause the depth sweep produced **before** the refusal vocabulary landed,
 * in code-unit order — and therefore exactly what the narrowing closes.
 *
 * These four were the whole of the difference measured in Stage 2: three direct
 * branches of `classifyExclusion`'s ordered cascade that a glob `exclude` list
 * could not express, plus the transitive subtree behind them. Stage 3 gave the
 * primitive a labelled refusal cascade and `admitPaths`, so the swept comparison
 * now agrees and this list is no longer an expected result.
 *
 * ⚠️ It is retained as the **negative control's** expectation, not as history.
 * "Zero divergence" is satisfiable by a closure that returned nothing at all, so
 * the sweep is run a second time with the vocabulary stripped
 * ({@link NARROWING_LABELS}, {@link NARROWING_FIELDS}) and must reproduce
 * precisely these four — 253 attributed paths, of which 239 are the transitive
 * bucket, 9 `navigation-file`, 3 `directory-target` and 2
 * `agent-instruction-file`. An
 * equality rather than a subset check on both arms: a NEW cause appearing is the
 * finding this file exists to surface, and a `toContain`-shaped assertion would
 * let one through.
 */
const KNOWN_CAUSES: readonly DivergenceCause[] = [
  'agent-instruction-file',
  'directory-target',
  'navigation-file',
  PRUNED,
];

/**
 * The declaration FIELDS Stage 3's narrowing added to the closure primitive.
 *
 * Named once so the negative control can remove exactly this vocabulary and
 * nothing else. Reconstructing a pre-Stage-3 declaration by hand would be a
 * second opinion about {@link skillExtentDeclaration}'s translation rather than
 * a control over it, and would keep agreeing after the translation changed.
 *
 * Every name here is asserted PRESENT on a real declaration before the control
 * runs, so a rename cannot silently turn the control into a no-op — the failure
 * mode of an opt-out list that nothing checks.
 *
 * ⚠️ Only `admitPaths` is a field. The other three-quarters of the narrowing
 * moved into {@link NARROWING_LABELS} when the flat `excludeBasenames` /
 * `excludeKinds` pair became rules of an ordered, labelled `refusals` cascade —
 * and the control cannot simply empty `refusals`, because that array ALSO
 * carries the `excludeReferencesFromBundle` globs, which are pre-Stage-3 and
 * must survive into the control or its numbers stop meaning what they meant.
 */
const NARROWING_FIELDS = ['admitPaths'] as const;

/**
 * The refusal-rule LABELS Stage 3's narrowing added, as the control must strip
 * them: by label, from the cascade the shipped translation actually produced.
 *
 * These are the three `classifyExclusion` branches a glob `exclude` list could
 * not express. The fourth rule the translation emits —
 * {@link SKILL_REFUSED_PATTERN_MATCHED} — is the pre-Stage-3 `exclude` list
 * wearing a label, so it is deliberately NOT here: removing it would make the
 * control weaker than the state it stands in for, and would add a fifth cause
 * (`pattern-matched`) the historical measurement never contained.
 *
 * Imported from the translation rather than re-spelled, and each is asserted
 * present in a real declaration's cascade before the control runs — a label
 * typo would otherwise strip nothing and the control would agree with
 * everything.
 */
const NARROWING_LABELS: readonly string[] = [
  SKILL_REFUSED_DIRECTORY_TARGET,
  SKILL_REFUSED_NAVIGATION_FILE,
  SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
];

/**
 * The walker `excludeReason` each refusal label must reproduce, one entry per
 * `classifyExclusion` branch the closure can express.
 *
 * An EXPLICIT table, not a string transform: `directory-target` →
 * `SKILL_REFUSED_DIRECTORY_TARGET` is a mapping someone decided, and a
 * mechanical `toUpperCase().replaceAll('-','_')` would keep agreeing after the
 * translation started emitting a label that merely looks right. The other seven
 * reasons are absent on purpose — the closure consults none of their oracles, so
 * a closure refusal carrying one of them is a finding, not a gap.
 */
const REASON_TO_REFUSAL_CODE: ReadonlyMap<string, string> = new Map([
  ['directory-target', SKILL_REFUSED_DIRECTORY_TARGET],
  ['navigation-file', SKILL_REFUSED_NAVIGATION_FILE],
  ['agent-instruction-file', SKILL_REFUSED_AGENT_INSTRUCTION_FILE],
  ['pattern-matched', SKILL_REFUSED_PATTERN_MATCHED],
]);

/**
 * The two condition codes the closure PRIMITIVE owns.
 *
 * Everything else in a closure contribution's condition table arrived as a
 * refusal rule's label, so subtracting these two is how the refusal view is
 * read off without hardcoding which labels the translation happens to supply.
 */
const PRIMITIVE_CONDITION_CODES: ReadonlySet<string> = new Set([
  CLOSURE_REFERENCE_UNRESOLVED,
  CLOSURE_ROOT_ABSENT,
]);

// ============================================================================
// Types
// ============================================================================

/** One skill of the corpus, with the config every VAT lane resolves for it. */
interface CorpusSkill {
  /** The declared skill name — the extent's within-root discriminator. */
  readonly name: string;
  /** Absolute path to SKILL.md. */
  readonly absolutePath: string;
  /** Project-root-relative, forward-slashed — how `resource_realizations.path` spells it. */
  readonly relativePath: string;
  /** `skills.defaults` merged with `skills.config.<name>`. */
  readonly config: SkillPackagingConfig;
}

/** One corpus root, with both arms' inputs prepared. */
interface Corpus {
  readonly spec: CorpusSpec;
  /** Absolute project root every path is stated against. */
  readonly root: string;
  readonly skills: readonly CorpusSkill[];
  /** The walker's input: the project registry `packageSkills` builds once. */
  readonly registry: WalkableRegistry;
  /** The closure arm's input: a real `populate()` of the same root. */
  readonly projection: Projection;
  /** A base rebuilt from {@link projection}, so one `contribute` can be repeated. */
  readonly base: ProjectionBase;
  /** Skill name → the `resolution_contexts.contextId` its extent got. */
  readonly extentIdByName: ReadonlyMap<string, string>;
  /** Shared git oracle — the walker spawns `git check-ignore` per path without one. */
  readonly gitTracker: GitTracker;
  /**
   * What each arm's *preparation* cost, in ms.
   *
   * The per-skill figures below are the walk alone, and on their own they would
   * flatter the closure arm badly: `walkLinkGraph` runs against a registry
   * `packageSkills` builds anyway, whereas the closure needs a whole populated
   * projection that no vat command produces today. These two numbers are where
   * a Stage 3 flip's real cost lives, so they are measured, not elided.
   */
  readonly preparationMs: { readonly registry: number; readonly populate: number };
}

/**
 * Why one path is in one arm and not the other.
 *
 * Every value but the last is `walkLinkGraph`'s **own** verdict, read off the
 * `excludedReferences` row it emitted for that target — never a re-derivation
 * here, which would be a second opinion about a cascade this file does not own.
 *
 * `pruned-behind-exclusion` is the transitive case, and it is a checked claim
 * rather than a shrug: it is asserted only for a path the walker emitted **no**
 * row of any kind for, which is exactly what "the walker never reached it"
 * means. It arises because a refusal at a hub — `docs/README.md` as
 * `navigation-file`, `CLAUDE.md` as `agent-instruction-file` — removes not just
 * that file but everything reachable only through it, while the closure has no
 * vocabulary for the refusal and walks straight on.
 */
type DivergenceCause =
  | NonNullable<LinkResolution['excludeReason']>
  | typeof PRUNED;

/** One path present in one arm and absent from the other, with its cause. */
interface AttributedPath {
  readonly path: string;
  readonly cause: DivergenceCause;
}

/** One skill's disagreement between the two arms, under one config. */
interface Divergence {
  readonly corpus: string;
  readonly skill: string;
  readonly depth: number | 'full';
  /** Bundled by the walker, refused by the closure. */
  readonly walkerOnly: readonly string[];
  /** Admitted by the closure, refused by the walker, each with the walker's reason. */
  readonly closureOnly: readonly AttributedPath[];
}

/** Everything one walk produced, in the comparison's coordinate system. */
interface WalkerRun {
  /** Bundle membership, including the root the walker never lists itself. */
  readonly members: string[];
  /** Every path the walker reached — bundled or refused. */
  readonly seen: ReadonlyMap<string, DivergenceCause | 'bundled'>;
}

/** Everything one closure contribution produced, in the same coordinate system. */
interface ClosureRun {
  /** Extent membership. */
  readonly members: string[];
  /** Root-relative path → the refusal label the closure reported for it. */
  readonly refusals: ReadonlyMap<string, string>;
}

/**
 * The reason half of the comparison, beside the membership half.
 *
 * `compared` exists so an empty {@link mismatches} cannot pass by being empty by
 * CONSTRUCTION: a bucket that never compared a path agrees with everything, and
 * is exactly the vacuous result the membership assertion already has to guard
 * against ([[fixtures-that-cannot-distinguish]]).
 */
interface ReasonComparison {
  /** How many paths BOTH arms refused, and whose reasons were therefore compared. */
  readonly compared: number;
  /** One rendered line per path the two arms refused for different stated reasons. */
  readonly mismatches: readonly string[];
}

// ============================================================================
// Corpus assembly
// ============================================================================

/**
 * Resolve one config root's declared skills, each with its merged config.
 *
 * @param configRoot - Absolute root holding the governing config
 * @param projectRoot - Absolute root every returned path is stated against
 * @returns One entry per declared skill, in discovery order
 * @throws When the root has no config or no `skills:` section — {@link CORPORA}
 *   would then be describing a project that no longer exists
 */
async function corpusSkillsOf(configRoot: string, projectRoot: string): Promise<CorpusSkill[]> {
  const skillsSection = loadConfigCached(configRoot)?.skills;
  if (skillsSection === undefined) {
    throw new Error(`${configRoot} declares no skills section; CORPORA is stale.`);
  }

  const discovered = await discoverSkillsFromConfig(skillsSection, configRoot);
  const { defaults, config: perSkill } = skillsSection;

  return discovered.map((skill) => {
    const absolutePath = safePath.resolve(skill.sourcePath);
    return {
      name: skill.name,
      absolutePath,
      relativePath: toForwardSlash(safePath.relative(projectRoot, absolutePath)),
      config: mergeSkillPackagingConfig(
        defaults as Record<string, unknown> | undefined,
        perSkill?.[skill.name] as Record<string, unknown> | undefined,
      ),
    };
  });
}

/**
 * Populate the projection for one corpus, with one skill extent per declared skill.
 *
 * @param root - Absolute project root
 * @param skills - The declared skills
 * @param gitTracker - The run's git oracle, shared with the walker arm
 * @returns The projection, and the extent id each skill's contributor produced
 */
async function populateCorpus(
  root: string,
  skills: readonly CorpusSkill[],
  gitTracker: GitTracker,
): Promise<{ projection: Projection; extentIdByName: Map<string, string> }> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());

  const parameters: Record<string, JsonValue> = {};
  for (const skill of skills) {
    registry.register(new SkillExtentContributor(skill.name));
    parameters[skillExtentContributorId(skill.name)] = declarationFor(skill, skill.config);
  }

  const projection = await populate({ root, registry, parameters, gitTracker });

  // From provenance rather than by re-deriving `extentContextId`: the row names
  // the contributor that produced the extent, so a change to how an extent id is
  // spelled cannot silently point this test at the wrong extent.
  const extentIdByName = new Map<string, string>();
  for (const skill of skills) {
    const contributorId = skillExtentContributorId(skill.name);
    const row = projection.zoneProvenance.find((entry) => entry.contributorId === contributorId);
    if (row === undefined) throw new Error(`No provenance row for ${contributorId}`);
    extentIdByName.set(skill.name, row.contextId);
  }

  return { projection, extentIdByName };
}

/**
 * Rebuild a `ProjectionBase` holding only what a closure walk reads.
 *
 * Two callers need it and neither can use `populate`'s return value: the depth
 * sweep runs one `contribute` per depth (re-populating per depth would be a
 * whole corpus crawl per value), and the timing arm repeats one `contribute` ten
 * times. `populate` returns a `Projection` — no `root`, no `identities` — rather
 * than the base it walked.
 *
 * The rows are **copied from the populated projection**, never re-derived, so the
 * repeated call is the same computation over the same edges; and only the
 * filesystem extent's realizations are carried, which is exactly what the closure
 * stratum saw on its first pass.
 *
 * `'agrees with the populated run it stands in for'` pins the reconstruction.
 *
 * @param root - Absolute project root
 * @param projection - The populated projection to copy rows from
 * @param extentIds - Extent ids belonging to skill extents, whose realization
 *   rows are duplicates of the filesystem rows and are dropped
 * @returns A base carrying the base-stratum realizations and every blob reference
 */
function baseFrom(
  root: string,
  projection: Projection,
  extentIds: ReadonlySet<string>,
): ProjectionBase {
  const builder = new ProjectionBuilder(root);
  builder.addRoot({ id: builder.identities.rootId, path: safePath.resolve(root) });

  for (const row of projection.resources) builder.addResource(row);
  for (const row of projection.resourceRealizations) {
    if (!extentIds.has(row.extentId)) builder.addRealization(row);
  }
  for (const row of projection.blobReferences) builder.addBlobReference(row);

  return builder.base();
}

/** Assemble both arms' inputs for one corpus. */
async function corpusOf(spec: CorpusSpec): Promise<Corpus> {
  const root = safePath.resolve(safePath.join(REPO_ROOT, spec.projectRoot));
  const skills: CorpusSkill[] = [];
  for (const configRoot of spec.configRoots) {
    // Sequential: each discovery crawls a package, and the sets are concatenated
    // in declared order so the printed tables are stable.
    skills.push(...await corpusSkillsOf(safePath.join(REPO_ROOT, configRoot), root));
  }

  const gitTracker = new GitTracker(root);
  const registryStartedAt = performance.now();
  const registry = await createProjectRegistry(root);
  const registryMs = performance.now() - registryStartedAt;

  const populateStartedAt = performance.now();
  const { projection, extentIdByName } = await populateCorpus(root, skills, gitTracker);
  const populateMs = performance.now() - populateStartedAt;

  return {
    spec,
    root,
    skills,
    registry: registry as WalkableRegistry,
    projection,
    base: baseFrom(root, projection, new Set(extentIdByName.values())),
    extentIdByName,
    gitTracker,
    preparationMs: { registry: registryMs, populate: populateMs },
  };
}

// ============================================================================
// The two arms
// ============================================================================

/** Order by UTF-16 code unit — never `localeCompare`, whose collation is locale-dependent. */
function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The comparison currency: a deduplicated, deterministically ordered path set. */
function pathSet(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort(byCodeUnit);
}

/** Members of `left` that `right` does not have. */
function only(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right);
  return left.filter((path) => !other.has(path));
}

/**
 * Whether a comparison runs with Stage 3's refusal vocabulary or without it.
 *
 * `off` is the negative control, not a supported configuration.
 */
type Narrowing = 'on' | 'off';

/** One skill's declaration, as `PopulateOptions.parameters` carries it. */
// `JsonValue` IS a union by definition, and it is the declared parameter type of
// both `populate` and `contribute`; narrowing this return would only move the cast
// to every call site.
// eslint-disable-next-line sonarjs/function-return-type -- see the note above
function declarationFor(
  skill: CorpusSkill,
  config: SkillPackagingConfig,
  narrowing: Narrowing = 'on',
): JsonValue {
  // `excludeReferencesFromBundle.rules` is OPTIONAL on the config type the CLI's
  // discovery hands back and REQUIRED on the one `skillExtentDeclaration`
  // declares — two structurally different `SkillPackagingConfig`s across package
  // boundaries. Runtime is unaffected (`skill-extent.ts:127` already does
  // `?.rules ?? []`), so this normalizes rather than casts; a cast would hide a
  // divergence that is real. No gate catches it: test files are in no tsconfig,
  // so this file is never typechecked by `bun run validate`.
  // 🐛 Two `SkillPackagingConfig` types have STRUCTURALLY DIVERGED across package
  // boundaries: the one CLI discovery returns has `excludeReferencesFromBundle.rules`
  // OPTIONAL and `targets` READONLY; the one `skillExtentDeclaration` declares has
  // them required and mutable. Both differences are real, and there may be more —
  // they surface one at a time.
  //
  // Runtime is unaffected: `skill-extent.ts:127` already reads `?.rules ?? []` and
  // never mutates `targets`. Normalizing field-by-field here would reshape a config
  // to satisfy a type mismatch that belongs upstream, so this casts and names the
  // divergence instead. Fixing it means reconciling the two declarations.
  //
  // ⚠️ Nothing catches this: test files are in no tsconfig, so `bun run validate`
  // never typechecks this file. It was found only via an editor diagnostic.
  const declaration = skillExtentDeclaration(
    config as unknown as Parameters<typeof skillExtentDeclaration>[0],
    skill.relativePath,
  ) as unknown as Record<string, unknown>;
  if (narrowing === 'on') return declaration as JsonValue;
  // The control: every refusal matcher Stage 3 added, back to the state it had
  // before. `admitPaths` is emptied rather than deleted, because the schema is
  // `.strict()` with defaults — a missing key would be re-defaulted to the same
  // `[]` anyway, and spelling it makes the control's intent legible at the
  // failure site. The cascade is FILTERED rather than emptied, so the
  // pattern-matched rule (which predates Stage 3) survives into the control.
  return {
    ...declaration,
    refusals: (declaration['refusals'] as readonly { readonly label: string }[])
      .filter((rule) => !NARROWING_LABELS.includes(rule.label)),
    ...Object.fromEntries(NARROWING_FIELDS.map((field) => [field, []])),
  } as JsonValue;
}

/** The refusal labels a real declaration's cascade carries, in cascade order. */
function refusalLabelsOf(declaration: JsonValue): string[] {
  const refusals = (declaration as Record<string, unknown>)['refusals'];
  return (refusals as readonly { readonly label: string }[]).map((rule) => rule.label);
}

/**
 * The walk options `skill-packager.ts` assembles, minus the two packager-only
 * inputs the module note names.
 *
 * @param corpus - The corpus the skill belongs to
 * @param skill - The skill being walked
 * @param config - The effective config, possibly depth-overridden by the sweep
 * @returns Options for {@link walkLinkGraph}
 */
function walkOptionsFor(
  corpus: Corpus,
  skill: CorpusSkill,
  config: SkillPackagingConfig,
): WalkLinkGraphOptions {
  const depth = config.linkFollowDepth ?? DEFAULT_DEPTH;
  return {
    maxDepth: depth === 'full' ? Number.POSITIVE_INFINITY : depth,
    excludeRules: config.excludeReferencesFromBundle?.rules ?? [],
    projectRoot: corpus.root,
    skillRootPath: skill.absolutePath,
    excludeNavigationFiles: config.excludeNavigationFiles ?? DEFAULT_EXCLUDE_NAVIGATION,
    gitTracker: corpus.gitTracker,
  };
}

/**
 * Run `walkLinkGraph` for one skill and record both what it bundled and what it
 * refused, with the refusal's own reason.
 *
 * The walk's own root is bundled by construction and absent from
 * `bundledResources` (the visited set holds it before the map does), whereas
 * `closureFrom` is an admitted member — adding it here is what makes the two sets
 * describe the same thing.
 *
 * @param corpus - The corpus the skill belongs to
 * @param skill - The skill being walked
 * @param options - Pre-built walk options, so a timing loop can hoist them
 * @returns Root-relative membership, and every path the walker reached
 */
function walkerRun(
  corpus: Corpus,
  skill: CorpusSkill,
  options: WalkLinkGraphOptions,
): WalkerRun {
  const result = walkLinkGraph(
    corpus.registry.getResource(skill.absolutePath)?.id ?? '',
    corpus.registry,
    options,
  );
  const relative = (absolute: string): string =>
    toForwardSlash(safePath.relative(corpus.root, absolute));

  const members = pathSet([
    skill.relativePath,
    ...result.bundledResources.map((resource) => relative(resource.filePath)),
    ...result.bundledAssets.map(relative),
  ]);

  const seen = new Map<string, DivergenceCause | 'bundled'>();
  for (const path of members) seen.set(path, 'bundled');
  for (const reference of result.excludedReferences) {
    // `bundled` wins: one path can be reached twice, refused on one route and
    // admitted on another, and it is a member either way.
    const path = relative(reference.path);
    if (seen.get(path) === 'bundled') continue;
    seen.set(path, reference.excludeReason ?? PRUNED);
  }

  return { members, seen };
}

/**
 * One skill extent's membership, as the populated projection recorded it.
 *
 * @param corpus - The corpus the skill belongs to
 * @param skill - The skill whose extent to read
 * @returns Root-relative membership
 */
function projectedMembers(corpus: Corpus, skill: CorpusSkill): string[] {
  const extentId = corpus.extentIdByName.get(skill.name);
  return pathSet(corpus.projection.resourceRealizations
    .filter((row) => row.extentId === extentId)
    .map((row) => row.path));
}

/**
 * The closure's membership AND its stated refusals for one skill under an
 * arbitrary config.
 *
 * Runs the same contributor `populate` ran, over the base rebuilt from that
 * population — the only way to vary a declaration without re-crawling the corpus.
 *
 * The refusal view is every condition row whose code is not one of the
 * primitive's own two, minus anything that is also a member. Both subtractions
 * matter: the first keeps a broken link out of the refusal bucket (it is a fact
 * about a reference, not a verdict about a file), and the second mirrors
 * {@link walkerRun}'s "bundled wins" rule, so a path reached twice is compared
 * as a member on both sides or as a refusal on both sides.
 *
 * @param corpus - The corpus the skill belongs to
 * @param skill - The skill whose extent to compute
 * @param config - The effective config
 * @param narrowing - Whether Stage 3's refusal vocabulary is in the declaration
 * @returns Root-relative membership and the refusal label per refused path
 */
async function closureRun(
  corpus: Corpus,
  skill: CorpusSkill,
  config: SkillPackagingConfig,
  narrowing: Narrowing = 'on',
): Promise<ClosureRun> {
  const contribution = await new SkillExtentContributor(skill.name)
    .contribute(corpus.base, declarationFor(skill, config, narrowing));
  const members = pathSet(contribution.realizations.map((row) => row.path));

  const memberSet = new Set(members);
  const refusals = new Map<string, string>();
  for (const row of contribution.conditions) {
    if (PRIMITIVE_CONDITION_CODES.has(row.code) || memberSet.has(row.path)) continue;
    refusals.set(row.path, row.code);
  }

  return { members, refusals };
}

/**
 * The reason halves of the two arms, for every path BOTH of them refused.
 *
 * Only paths in both refusal views are compared: a path one arm bundled is a
 * MEMBERSHIP difference, which {@link Divergence} already owns, and counting it
 * here too would report one disagreement twice under two names.
 *
 * A walker reason with no {@link REASON_TO_REFUSAL_CODE} entry is a mismatch and
 * not a skip. The four mapped reasons are the ones the closure claims; a closure
 * refusal sitting on top of `skill-definition` or `gitignored` would mean it is
 * reporting a reason it has no oracle for, which is the failure this bucket
 * exists to catch rather than an out-of-scope case to wave through.
 *
 * @param walk - What the walker bundled and refused
 * @param closure - What the closure admitted and refused
 * @returns How many paths were compared, and every disagreement, rendered
 */
function compareReasons(walk: WalkerRun, closure: ClosureRun): ReasonComparison {
  const mismatches: string[] = [];
  let compared = 0;

  for (const [path, code] of closure.refusals) {
    const reason = walk.seen.get(path);
    // Absent: the walker never reached it. `bundled`: a membership difference.
    // `PRUNED`: the walker emitted a row with no reason, so there is no reason
    // to compare against.
    if (reason === undefined || reason === 'bundled' || reason === PRUNED) continue;
    compared += 1;
    const expected = REASON_TO_REFUSAL_CODE.get(reason);
    if (expected !== code) {
      mismatches.push(`${path}: walker=${reason} closure=${code} expected=${expected ?? '<unmapped>'}`);
    }
  }

  return { compared, mismatches };
}

/** Both arms for one skill under one config, and their attributed difference. */
async function compareSkill(
  corpus: Corpus,
  skill: CorpusSkill,
  config: SkillPackagingConfig,
  narrowing: Narrowing = 'on',
): Promise<{
  walker: string[];
  closure: string[];
  divergence: Divergence | undefined;
  reasons: ReasonComparison;
}> {
  const walk = walkerRun(corpus, skill, walkOptionsFor(corpus, skill, config));
  const run = await closureRun(corpus, skill, config, narrowing);
  const closure = run.members;
  const walkerOnly = only(walk.members, closure);
  const closureOnly = only(closure, walk.members).map((path) => ({
    path,
    // The walker's own verdict where it has one; otherwise it never reached the
    // path at all, which is the transitive case.
    cause: (walk.seen.get(path) ?? PRUNED) as DivergenceCause,
  }));

  const divergence = walkerOnly.length === 0 && closureOnly.length === 0
    ? undefined
    : {
      corpus: corpus.spec.label,
      skill: skill.name,
      depth: config.linkFollowDepth ?? DEFAULT_DEPTH,
      walkerOnly,
      closureOnly,
    };
  const reasons = compareReasons(walk, run);
  return { walker: walk.members, closure, divergence, reasons };
}

/** What one pass of {@link SWEPT_DEPTHS} over one corpus produced. */
interface SweepResult {
  readonly divergences: Divergence[];
  /** One printable row per (depth, skill) cell. */
  readonly rows: Record<string, unknown>[];
  /** Bundled paths that a declared exclude rule should have rejected. */
  readonly excludeEscapes: string[];
  /** Cells in which either arm bundled more than the SKILL.md alone. */
  readonly followed: number;
  /** Paths BOTH arms refused, summed over every cell — the reason bucket's population. */
  readonly reasonsCompared: number;
  /** Every path the two arms refused for different stated reasons. */
  readonly reasonMismatches: string[];
}

/**
 * Run both arms over every skill at every swept depth.
 *
 * Extracted from its `it` block only to stay under the cognitive-complexity
 * ceiling: the two loops plus the exclude-rule probe exceed it inline.
 *
 * @param corpus - The corpus to sweep — in practice the repo-root one
 * @param narrowing - Whether Stage 3's refusal vocabulary is in the declaration
 * @returns Every cell's outcome, plus the two aggregate counters
 */
async function sweepDepths(corpus: Corpus, narrowing: Narrowing = 'on'): Promise<SweepResult> {
  const result: SweepResult = {
    divergences: [], rows: [], excludeEscapes: [], followed: 0,
    reasonsCompared: 0, reasonMismatches: [],
  };
  let followed = 0;
  let reasonsCompared = 0;

  for (const depth of SWEPT_DEPTHS) {
    for (const skill of corpus.skills) {
      const config: SkillPackagingConfig = { ...skill.config, linkFollowDepth: depth };
      const { walker, closure, divergence, reasons } = await compareSkill(corpus, skill, config, narrowing);
      if (divergence !== undefined) result.divergences.push(divergence);
      if (walker.length > 1 || closure.length > 1) followed += 1;
      reasonsCompared += reasons.compared;
      result.reasonMismatches.push(
        ...reasons.mismatches.map((line) => `${skill.name}@${String(depth)}: ${line}`),
      );
      result.rows.push({
        depth, skill: skill.name, walker: walker.length, closure: closure.length,
        agree: divergence === undefined,
      });
      // `excludeReferencesFromBundle` membership, exercised rather than reasoned
      // about — see EXCLUDED_DIRECTORY for why this is the only skill that can
      // exercise it on this corpus.
      const escaped = skill.name === EXCLUDING_SKILL
        ? [...walker, ...closure].filter((path) => path.includes(`${EXCLUDED_DIRECTORY}/`))
        : [];
      result.excludeEscapes.push(...escaped.map((path) => `${skill.name}@${String(depth)}: ${path}`));
    }
  }

  return { ...result, followed, reasonsCompared };
}

// ============================================================================
// Setup
// ============================================================================

let corpora: Corpus[];

beforeAll(async () => {
  corpora = [];
  for (const spec of CORPORA) {
    // Sequential: each corpus populates a whole project, and two at once would
    // put two full crawls in flight for no shorter test.
    corpora.push(await corpusOf(spec));
  }

  console.log('[corpus] preparation is WARM — VAT\'s on-disk parse cache survives between runs,'
    + ' and a first cold run of this file was ~50x slower.'
    + ' These two columns are SINGLE observations (setup runs once), unlike the min-of-nine walk'
    + ' figures below: across four runs `populate ms` for repo-root moved 1818 → 3548 on machine'
    + ' load alone, so read them as an order of magnitude and nothing finer.');
  console.table(corpora.map((corpus) => ({
    corpus: corpus.spec.label,
    note: corpus.spec.note,
    skills: corpus.skills.length,
    realizations: corpus.projection.resourceRealizations.length,
    'reference candidates': corpus.projection.blobReferences.length,
    'createProjectRegistry ms': Number(corpus.preparationMs.registry.toFixed(0)),
    'populate ms': Number(corpus.preparationMs.populate.toFixed(0)),
  })));
}, 3_600_000);

// ============================================================================
// The experiment
// ============================================================================

describe('skill extent as a shadow of walkLinkGraph, over the real corpus', () => {
  it('agrees on membership for every declared skill, or names every difference', async () => {
    const divergences: Divergence[] = [];
    const rows: Record<string, unknown>[] = [];

    for (const corpus of corpora) {
      for (const skill of corpus.skills) {
        const { walker, closure, divergence } = await compareSkill(corpus, skill, skill.config);
        if (divergence !== undefined) divergences.push(divergence);
        rows.push({
          corpus: corpus.spec.label,
          skill: skill.name,
          depth: skill.config.linkFollowDepth ?? DEFAULT_DEPTH,
          walker: walker.length,
          closure: closure.length,
          agree: divergence === undefined,
        });
        // The closure arm the sweep and the timing both use must agree with the
        // one `populate` actually ran, or every figure below describes something
        // else. Asserted per skill so a failure names the skill.
        expect(closure).toEqual(projectedMembers(corpus, skill));
      }
    }
    console.table(rows);

    // Each declared skill appears once per corpus it belongs to: the fourteen
    // under their own project roots, and the same fourteen under the repo root.
    expect(rows).toHaveLength(TOTAL_DECLARED_SKILLS * 2);
    if (divergences.length > 0) console.log('[divergences]', JSON.stringify(divergences, null, 2));

    // Stage 3: the two arms now agree under the shipped configs, with nothing
    // named and nothing tolerated. The one difference this used to pin —
    // `packages/cli/src/skill-resolution`, a DIRECTORY reached by
    // `vat-skill-testing` at depth 2 — is what the `kinds: ['directory']` rule
    // closes. Still an equality over the RENDERED divergence rather than a length
    // check, so a regression names the skill, the depth and the cause it failed on.
    expect(divergences.map((row) => `${row.corpus}/${row.skill}@${String(row.depth)}: `
      + row.closureOnly.map((entry) => `${entry.path} (${entry.cause})`).join(', ')
      + (row.walkerOnly.length > 0 ? ` | walker-only: ${row.walkerOnly.join(', ')}` : ''),
    )).toEqual([]);
  }, 1_800_000);

  it('records that the PRODUCTION configuration cannot distinguish the two', () => {
    // Not a pass to be proud of — a stated limit. Under the shipped configs every
    // skill bundles exactly its own SKILL.md, so the agreement asserted above is
    // an equality between two singletons and proves nothing about the primitive.
    // Pinned as a fact so that if a skill ever gains a followed in-project link,
    // this test fails and the reader learns the corpus grew teeth.
    const singletons: string[] = [];
    for (const corpus of corpora) {
      if (corpus.spec.projectRoot === '.') continue;
      for (const skill of corpus.skills) {
        singletons.push(`${skill.name}: ${projectedMembers(corpus, skill).length}`);
      }
    }
    expect(singletons.every((entry) => entry.endsWith(': 1'))).toBe(true);
    console.log(`[vacuity] ${singletons.length} production skill bundles, all singletons`);
  });

  it('agrees across a depth sweep on the corpus that CAN distinguish', async () => {
    const corpus = corpora.find((entry) => entry.spec.projectRoot === '.');
    if (corpus === undefined) throw new Error('no repo-root corpus');

    const {
      divergences, rows, excludeEscapes, followed, reasonsCompared, reasonMismatches,
    } = await sweepDepths(corpus);
    console.table(rows.filter((row) => (row['walker'] as number) > 1 || (row['closure'] as number) > 1));
    console.log(`[non-vacuous] ${followed} of ${rows.length} sweep cells bundle more than the SKILL.md alone`);

    // The whole point of this corpus. A sweep in which nothing was ever followed
    // would be the same vacuous pass the production corpus already gives.
    expect(followed).toBeGreaterThan(0);

    // The REASON comparison, beside the membership one. Both arms refused these
    // paths; the question is whether they say the same thing about why.
    console.log(`[reasons] ${reasonsCompared} paths refused by BOTH arms,`
      + ` ${reasonMismatches.length} with disagreeing reasons`);
    if (reasonMismatches.length > 0) console.log('[reason mismatches]', reasonMismatches);
    // Population FIRST: an empty mismatch list over an empty comparison is the
    // same vacuous pass as an empty divergence list over an empty sweep, and a
    // refactor that stopped emitting refusal conditions entirely would satisfy
    // the equality below while saying nothing at all.
    expect(reasonsCompared).toBeGreaterThan(0);
    expect(reasonMismatches).toEqual([]);

    const attributed = divergences.flatMap((row) => row.closureOnly);
    const causeCounts = new Map<DivergenceCause, number>();
    for (const entry of attributed) causeCounts.set(entry.cause, (causeCounts.get(entry.cause) ?? 0) + 1);
    console.log('[causes]', JSON.stringify(Object.fromEntries(causeCounts)));

    // THE gate, and after Stage 3 it IS "no difference". The primitive now
    // expresses the three cascade branches this corpus exercises — a
    // case-insensitive basename refusal (`navigation-file`,
    // `agent-instruction-file`) and a resource-kind refusal (`directory-target`)
    // — and because an excluded target was already never walked THROUGH, closing
    // those three closes the transitive `pruned-behind-exclusion` bucket with them.
    //
    // ⚠️ On its own this assertion is worth very little: it is satisfied just as
    // well by a closure that returned nothing, or by a sweep that never followed
    // an edge. `followed` above is the second guard, and the negative control in
    // the next test is the third and the real one.
    expect([...new Set(attributed.map((entry) => entry.cause))].sort(byCodeUnit)).toEqual([]);
    expect(divergences).toEqual([]);

    // Neither arm may bundle anything the sole exercised exclude rule rejects.
    expect(excludeEscapes).toEqual([]);

    // …and the negative control, without which the line above is satisfied just
    // as well by a walk that never reached the directory. Drop the rule and both
    // arms must admit what it was rejecting — that is what makes "both sides
    // dropped them" a statement about the RULE rather than about reachability.
    const excluding = corpus.skills.find((skill) => skill.name === EXCLUDING_SKILL);
    if (excluding === undefined) throw new Error(`corpus lost ${EXCLUDING_SKILL}`);
    const unruled = await compareSkill(corpus, excluding, { linkFollowDepth: 1 });
    const inDirectory = (paths: readonly string[]): number =>
      paths.filter((path) => path.includes(`${EXCLUDED_DIRECTORY}/`)).length;
    expect(inDirectory(unruled.walker)).toBeGreaterThan(0);
    expect(inDirectory(unruled.closure)).toBe(inDirectory(unruled.walker));

    // The direction matters more than the count: the closure admits a SUPERSET.
    // Nothing the walker bundles is ever missing from it, at any swept depth —
    // which is what makes the difference a question of *narrowing* the primitive
    // rather than of teaching it to find things it cannot see.
    expect(divergences.flatMap((row) => row.walkerOnly)).toEqual([]);
  }, 1_800_000);

  it('NEGATIVE CONTROL: stripping the refusal vocabulary brings every cause back', async () => {
    // Without this test the agreement above is unfalsifiable. "Zero divergence"
    // is exactly what a closure that returned nothing would report, and exactly
    // what a sweep that never followed an edge would report — so the question
    // [[fixtures-that-cannot-distinguish]] asks has to be answered here: what
    // result would have shown the narrowing did nothing? This one.
    //
    // The control removes the vocabulary and NOTHING else, from the declaration
    // `skillExtentDeclaration` actually produced. It therefore keeps controlling
    // the real translation after that translation changes, which a hand-rebuilt
    // pre-Stage-3 declaration would not.
    const corpus = corpora.find((entry) => entry.spec.projectRoot === '.');
    if (corpus === undefined) throw new Error('no repo-root corpus');

    // The opt-out list must name fields and labels that exist, or the control
    // silently becomes a no-op that agrees with everything — the failure mode of
    // every unchecked exclusion list.
    const sample = corpus.skills[0];
    if (sample === undefined) throw new Error('no skills to sample a declaration from');
    const declaration = declarationFor(sample, sample.config);
    for (const field of NARROWING_FIELDS) {
      expect(Object.keys(declaration as Record<string, unknown>)).toContain(field);
    }
    // The other three-quarters of the narrowing live inside `refusals` now, so
    // the same "it must exist" check has to be made on the LABELS. A renamed
    // label would otherwise strip nothing and the control would recover no cause
    // at all — which the `KNOWN_CAUSES` equality below would then report as a
    // narrowing failure rather than as the broken control it is.
    const labels = refusalLabelsOf(declaration);
    for (const label of NARROWING_LABELS) expect(labels).toContain(label);
    // …and the control must be a NARROWING removal, not a cascade removal: the
    // pre-Stage-3 `exclude` list, now the pattern-matched rule, has to survive.
    expect(refusalLabelsOf(declarationFor(sample, sample.config, 'off')))
      .toEqual([SKILL_REFUSED_PATTERN_MATCHED]);

    const { divergences, followed } = await sweepDepths(corpus, 'off');
    const attributed = divergences.flatMap((row) => row.closureOnly);
    const causeCounts = new Map<DivergenceCause, number>();
    for (const entry of attributed) causeCounts.set(entry.cause, (causeCounts.get(entry.cause) ?? 0) + 1);
    console.log('[control causes]', JSON.stringify(Object.fromEntries(causeCounts)));
    console.log(`[control] ${followed} following cells, ${attributed.length} attributed paths`);

    // Every cause the narrowing closes, back — an equality, so a control that
    // recovered only some of them is a failure and not a pass.
    expect([...new Set(attributed.map((entry) => entry.cause))].sort(byCodeUnit)).toEqual(KNOWN_CAUSES);

    // The transitive bucket must DOMINATE, because that is the structural claim
    // the whole narrowing rests on: a refusal at a hub removes the subtree behind
    // it, not just the hub. A control in which pruning were a handful of paths
    // would mean the 239 measured in Stage 2 came from somewhere else. Bounded
    // below rather than pinned exactly — the count moves whenever a doc gains a
    // link, and a brittle equality would fail for reasons this file is not about.
    expect(causeCounts.get(PRUNED) ?? 0).toBeGreaterThan(50);

    // The superset property held BEFORE the narrowing too, which is what made
    // Stage 3 a narrowing problem rather than a "teach it to see" problem.
    expect(divergences.flatMap((row) => row.walkerOnly)).toEqual([]);
  }, 1_800_000);

  it('omitting the packager-only walk inputs changes no membership on this corpus', () => {
    // The boundary the module note declares, measured rather than assumed.
    // `test.evals` is declared for ten of these skills; if any skill ever linked
    // into an eval suite, the packager's extra exclude rules would move the
    // walker's answer and the closure declaration would have no way to follow.
    const moved: string[] = [];

    for (const corpus of corpora) {
      for (const skill of corpus.skills) {
        const evals = skill.config.test?.evals;
        if (evals === undefined) continue;
        const suite = toForwardSlash(safePath.relative(
          corpus.root,
          safePath.resolve(safePath.join(skill.absolutePath, '..'), evals, '..'),
        ));
        const bundled = walkerRun(corpus, skill, walkOptionsFor(corpus, skill, skill.config)).members
          .filter((path) => toForwardSlash(path).startsWith(`${suite}/`));
        if (bundled.length > 0) moved.push(`${corpus.spec.label} ${skill.name}: ${bundled.join(', ')}`);
      }
    }

    expect(moved).toEqual([]);
  }, 600_000);
});

// ============================================================================
// Head-to-head timing
// ============================================================================

/**
 * The minimum elapsed ms over {@link TIMING_REPEATS} runs of `arm`.
 *
 * `min`, never a median: one cold repeat poisons a median, and the fastest
 * observation is the one least contaminated by whatever else the machine was
 * doing. One un-timed warm-up run precedes the measured ones, so every reported
 * figure is fully warm — including `ClosureExtentContributor`'s per-base
 * `referencesByBlob` memo, which is cold exactly once per base.
 *
 * @param arm - The work to repeat
 * @returns The fastest observed wall time, in milliseconds
 */
async function minOf(arm: () => Promise<void> | void): Promise<number> {
  await arm();
  let best = Number.POSITIVE_INFINITY;
  for (let repeat = 0; repeat < TIMING_REPEATS; repeat++) {
    const startedAt = performance.now();
    await arm();
    best = Math.min(best, performance.now() - startedAt);
  }
  return best;
}

describe('head-to-head cost of the two implementations', () => {
  it('times both arms over each corpus, warm, min of nine', async () => {
    const rows: Record<string, unknown>[] = [];

    for (const corpus of corpora) {
      // Hoisted so neither arm is charged for building its own arguments, and at
      // depth `full` so neither is measured on a walk its config declined to take.
      const full: (skill: CorpusSkill) => SkillPackagingConfig =
        (skill) => ({ ...skill.config, linkFollowDepth: 'full' });
      const walks = corpus.skills.map((skill) => ({
        skill, options: walkOptionsFor(corpus, skill, full(skill)),
      }));
      const closures = corpus.skills.map((skill) => ({
        contributor: new SkillExtentContributor(skill.name),
        declaration: declarationFor(skill, full(skill)),
      }));

      const walkerMs = await minOf(() => {
        for (const { skill, options } of walks) walkerRun(corpus, skill, options);
      });
      const closureMs = await minOf(async () => {
        for (const { contributor, declaration } of closures) {
          await contributor.contribute(corpus.base, declaration);
        }
      });

      rows.push({
        corpus: corpus.spec.label,
        skills: corpus.skills.length,
        'walkLinkGraph ms': Number(walkerMs.toFixed(2)),
        'closure ms': Number(closureMs.toFixed(2)),
        'closure / walker': Number((closureMs / walkerMs).toFixed(3)),
      });
    }

    console.log('[timing] linkFollowDepth: full, warm, min of 9; per-skill compute only,'
      + ' shared preparation (createProjectRegistry / populate) excluded and reported by beforeAll');
    console.table(rows);

    // Printed, never asserted: a wall-clock threshold on a live machine is a test
    // that fails on a loaded laptop and gets "fixed" by raising the number.
    expect(rows).toHaveLength(CORPORA.length);
  }, 1_800_000);
});
