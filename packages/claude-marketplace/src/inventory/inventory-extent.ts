/**
 * The **inventory** extent: `vat inventory`'s answer to "which files belong to
 * this skill", expressed as the generic closure primitive plus a declaration.
 *
 * The sibling of `agent-skills/src/projection/skill-extent.ts`, and deliberately
 * written to the same shape — read that module first, including its
 * expressible/not-expressible table, because everything it says about what the
 * primitive can and cannot carry applies here unchanged. This file states only
 * what is DIFFERENT, which is the walk it stands in for.
 *
 * ## Why this lives in `claude-marketplace` and not in `agent-skills`
 *
 * The skill translation lives in `agent-skills` because it translates a
 * `SkillPackagingConfig` — an `agent-skills` type, whose defaults
 * (`linkFollowDepth ?? 2`, `excludeNavigationFiles ?? true`) are that package's
 * facts. This one translates nothing: it is a FIXED walk policy, and the policy
 * is `extract-skill.ts`'s. Its inputs are the two things that vary at the call
 * site (which SKILL.md, and whether a git oracle was supplied) and nothing else.
 *
 * Putting it in `agent-skills` would move a policy into a package that has no
 * caller for it, and would make an `agent-skills` edit the way to change what
 * `vat inventory` includes. Putting it beside the extractor that owns the policy
 * keeps the declaration and the walk options it must reproduce in one directory,
 * where a diff shows both halves at once.
 *
 * ## The walk it must reproduce, option for option
 *
 * `collectLinkedFiles` calls `walkLinkGraph` with exactly:
 *
 * | Walk option | Declaration |
 * |---|---|
 * | `maxDepth: Infinity` | {@link INVENTORY_MAX_DEPTH} — `'full'`, the declaration's spelling of the same union |
 * | `excludeRules: []` | no `patterns` rule at all; there is nothing to flatten |
 * | `excludeNavigationFiles: true` | {@link INVENTORY_REFUSED_NAVIGATION_FILE}, unconditionally, because the option is a literal |
 * | *(no `deferredArtifacts`)* | no `admitPaths`. With `deferredArtifacts` absent, `refusesAgentInstructionFile` short-circuits on `declaredSources === undefined` and refuses EVERY agent-instruction file, so there is no escape hatch to model |
 * | `gitTracker` present / absent | {@link INVENTORY_REFUSED_GITIGNORED}, emitted only in the present case — see below |
 * | `projectRoot`, `skillRootPath` | the projection's root and `closureFrom`; not refusals |
 *
 * ## The gitignore rule is CONDITIONAL, and the condition is not cosmetic
 *
 * `resource_realizations.gitignored` is populated by `FilesystemExtentContributor`
 * only when the population was given a `GitTracker`
 * (`realizations.ts`: `context.gitTracker?.isUsable() === true ? … : false`), so
 * with no tracker the column is `false` on every row and a rule keyed on it
 * refuses nothing. Emitting it anyway would produce a declaration that CLAIMS a
 * branch it cannot run — the same dishonesty `skillRefusals` avoids by omitting
 * the navigation rule outright when `excludeNavigationFiles` is off, rather than
 * emitting it empty.
 *
 * ⚠️ **And the arms are not equal in the no-tracker state, which is a fact about
 * the WALKER and is stated here so it is not read as absent.** `walkLinkGraph`'s
 * gitignore branch does not need a tracker: with none it spawns
 * `git check-ignore` per target (`readGitignored`), so it still refuses ignored
 * targets. The closure cannot, because its only gitignore input is a column that
 * a tracker-less population never fills. The two therefore agree in the
 * no-tracker state only on a corpus with no gitignored link targets — which is
 * measured, per state, by `inventory-extent-corpus.integration.test.ts`, not
 * assumed here.
 *
 * ## `exists` is part of the gitignore rule, not decoration
 *
 * `classifyGitignored` returns early on `!facts.exists`, because neither ignore
 * oracle can be trusted about a path that is not there — `GitTracker`'s active
 * set contains only paths that exist, so a typo'd link would otherwise read as
 * "absent, therefore ignored". The declaration reproduces the guard by making the
 * rule a CONJUNCTION over two columns, which is why
 * `ExtentRefusalRuleSchema.flags` is a record read with AND rather than a list
 * read with OR.
 */

import {
  AGENT_INSTRUCTION_FILE_PATTERNS,
  NAVIGATION_FILE_PATTERNS,
} from '@vibe-agent-toolkit/agent-skills';
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
} from '@vibe-agent-toolkit/resources';

/**
 * The `resolution_contexts.kind` an inventory extent has.
 *
 * `'skill'`, the same kind the packaging translation uses, because it IS a
 * skill's extent — the kind names what the extent is about, not which lane
 * computed it. The two never collide: an extent's `contextId` is
 * `(kind, rootId, name)` and {@link inventoryExtentName} prefixes the name.
 */
export const INVENTORY_EXTENT_KIND = 'skill';

/** `zone_provenance.contributorId` prefix for an inventory extent. */
export const INVENTORY_EXTENT_CONTRIBUTOR_ID_PREFIX = 'builtin:inventory-skill';

/**
 * The extent NAME for one skill's inventory extent.
 *
 * Prefixed so a population may hold both this and the packaging translation's
 * extent for the same skill: the name is the within-root discriminator of the
 * extent's `contextId`, and both translations use kind `'skill'`.
 *
 * @param skillName - The skill's discriminator, unique within the population
 * @returns The extent name
 */
export function inventoryExtentName(skillName: string): string {
  return `inventory:${skillName}`;
}

/**
 * The `zone_provenance.contributorId` for one skill's inventory extent.
 *
 * @param skillName - The skill's discriminator, unique within the population
 * @returns The contributor id, unique per skill
 */
export function inventoryExtentContributorId(skillName: string): string {
  return `${INVENTORY_EXTENT_CONTRIBUTOR_ID_PREFIX}:${skillName}`;
}

/**
 * The declaration's spelling of `collectLinkedFiles`'s `maxDepth: Infinity`.
 *
 * `'full'` rather than a large number: the union `ExtentDeclarationSchema.maxDepth`
 * accepts is the same one `linkFollowDepth` accepts, and `'full'` is its member
 * for "unbounded". A numeric stand-in would be a bound that happens not to bite.
 */
export const INVENTORY_MAX_DEPTH = 'full';

/** `classifyPathKind`'s `directory-target`. */
export const INVENTORY_REFUSED_DIRECTORY_TARGET = 'INVENTORY_REFUSED_DIRECTORY_TARGET';

/** `classifyExclusion`'s `navigation-file`. */
export const INVENTORY_REFUSED_NAVIGATION_FILE = 'INVENTORY_REFUSED_NAVIGATION_FILE';

/** `classifyExclusion`'s `agent-instruction-file`. */
export const INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE = 'INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE';

/** `classifyGitignored`'s `gitignored`, existence-gated exactly as that branch is. */
export const INVENTORY_REFUSED_GITIGNORED = 'INVENTORY_REFUSED_GITIGNORED';

/** The `resources.kind` a directory entity carries — see `skill-extent.ts`'s note. */
const DIRECTORY_KIND = 'directory';

/**
 * The realization columns {@link INVENTORY_REFUSED_GITIGNORED} refuses on, and
 * the values that refuse.
 *
 * Both entries are required: see the module note's "`exists` is part of the
 * gitignore rule" section. Spelled as one object so the conjunction is visible
 * at the site that depends on it.
 */
const GITIGNORED_FLAGS: Readonly<Record<string, boolean>> = { gitignored: true, exists: true };

/**
 * The inventory walk's refusal cascade, **in `classifyExclusion`'s own branch
 * order**.
 *
 * The order is behaviour, exactly as it is for the packaging translation: the
 * primitive is first-match-wins and each rule carries a distinct label, so a
 * gitignored directory must be attributed to `directory-target` — which is what
 * the walker does, its kind branch being the first one after the deferred check.
 *
 * Four rules, one per `classifyExclusion` branch this walk can reach and the
 * declaration can express:
 *
 * 1. **kinds `['directory']`** — first, and ungated.
 * 2. **navigation basenames** — ungated here, unlike the packaging translation,
 *    because `collectLinkedFiles` passes the literal `excludeNavigationFiles: true`.
 * 3. **agent-instruction basenames** — ungated, and with no `admitPaths` escape
 *    hatch: `refusesAgentInstructionFile` returns `true` for every one of them
 *    when `deferredArtifacts` is absent, which it is at this call site.
 * 4. **gitignored ∧ exists** — LAST, matching the cascade, and present only when
 *    the population can answer the question at all.
 *
 * The walker branches between 3 and 4 that are absent here — `outside-project`,
 * `skill-definition`, `unreadable-target` — are the ones `skill-extent.ts`'s
 * table already records as inexpressible; two of the three are not divergences
 * in practice because the closure resolves no reference to them either (a target
 * outside the root does not resolve; a target that does not exist is not
 * realized), while `skill-definition` is a genuine gap this cascade shares.
 *
 * @param hasGitTracker - Whether the population was given a usable git oracle
 * @returns The ordered refusal rules
 */
function inventoryRefusals(hasGitTracker: boolean): ExtentRefusalRule[] {
  const rules: ExtentRefusalRule[] = [
    {
      label: INVENTORY_REFUSED_DIRECTORY_TARGET,
      patterns: [], basenames: [], kinds: [DIRECTORY_KIND], flags: {},
    },
    {
      label: INVENTORY_REFUSED_NAVIGATION_FILE,
      patterns: [], basenames: [...NAVIGATION_FILE_PATTERNS], kinds: [], flags: {},
    },
    {
      label: INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE,
      patterns: [], basenames: [...AGENT_INSTRUCTION_FILE_PATTERNS], kinds: [], flags: {},
    },
  ];
  if (hasGitTracker) {
    rules.push({
      label: INVENTORY_REFUSED_GITIGNORED,
      patterns: [], basenames: [], kinds: [], flags: { ...GITIGNORED_FLAGS },
    });
  }
  return rules;
}

/**
 * The inventory walk for one skill, as a closure-extent declaration.
 *
 * @param skillPath - The SKILL.md path **relative to the projection root**,
 *   forward-slashed — the coordinate system `resource_realizations.path` uses,
 *   and the only one `closureFrom` is resolved in. The extractor works in
 *   absolute paths; converting is the caller's job, because the caller is the
 *   one holding the root
 * @param hasGitTracker - Whether the population was given a usable git oracle.
 *   Not "should we refuse gitignored files": the column this gates is unfilled
 *   without one, so declaring the rule anyway would claim a branch that cannot run
 * @returns The declaration, schema-parsed so every default is materialized
 * @throws When the resulting declaration is not schema-valid — e.g. an empty `skillPath`
 */
export function inventoryExtentDeclaration(
  skillPath: string,
  hasGitTracker: boolean,
): ExtentDeclaration {
  return ExtentDeclarationSchema.parse({
    kind: INVENTORY_EXTENT_KIND,
    closureFrom: skillPath,
    maxDepth: INVENTORY_MAX_DEPTH,
    refusals: inventoryRefusals(hasGitTracker),
    admitPaths: [],
  });
}

/**
 * One skill's inventory extent — `ClosureExtentContributor` under an inventory
 * id and the skill kind.
 *
 * Delegation rather than inheritance, and the thinness is the finding, exactly
 * as it is for `SkillExtentContributor`: if this class needed to *do* anything,
 * the primitive would have been inadequate for the second membership consumer
 * too.
 */
export class InventorySkillExtentContributor implements ExtentContributor {
  readonly id: string;

  readonly kind: string = INVENTORY_EXTENT_KIND;

  readonly stratum: ContributorStratum = 'closure';

  /** The generic primitive this contributor is nothing but a naming of. */
  readonly #closure: ClosureExtentContributor;

  /**
   * @param skillName - The skill's discriminator. Feeds both the contributor id
   *   and, through the delegate, the extent's within-root context id — one
   *   source for both, so the two cannot drift apart
   */
  constructor(skillName: string) {
    this.id = inventoryExtentContributorId(skillName);
    this.#closure = new ClosureExtentContributor(inventoryExtentName(skillName), INVENTORY_EXTENT_KIND);
  }

  /**
   * Produce the inventory extent by running the closure primitive.
   *
   * @param base - Everything merged so far
   * @param parameters - An {@link inventoryExtentDeclaration} result
   * @returns The extent's context, members, realizations and conditions
   */
  contribute(base: ProjectionBase, parameters: JsonValue): Promise<ExtentContribution> {
    return this.#closure.contribute(base, parameters);
  }
}
