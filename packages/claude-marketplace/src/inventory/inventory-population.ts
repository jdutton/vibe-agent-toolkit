/**
 * The **inventory population**: `vat inventory`'s membership, answered by a
 * projection instead of by `crawlSkillLinkRegistry` + `walkLinkGraph`.
 *
 * This module is the CALLER the closure lane has never had. The declaration half
 * has been built and proven for some time — `inventoryExtentDeclaration` +
 * `InventorySkillExtentContributor` reproduce `collectLinkedFiles`'s walk option
 * for option, and `inventory-extent-corpus.integration.test.ts` measures zero
 * membership divergence against a negative control that brings 253 back. What was
 * missing was a production route that runs any of it.
 *
 * ## Why the caller is the load-bearing piece, and not a formality
 *
 * `populate()` had no production caller at all, and the consequences were not
 * cosmetic:
 *
 * - The `closure` stratum measured **0% on every command**, because the lab
 *   measures commands and no command reached the code. Instrumenting the corpus
 *   integration test cannot substitute: `vitest.setup.js` deletes every `VAT_*`
 *   variable before any test module loads, so the seam is off there by
 *   construction.
 * - Measurement and flip were therefore mutually blocking — the projection could
 *   not be costed until something ran it, and running it was the decision the
 *   cost was supposed to inform.
 *
 * One `vat inventory` behind {@link INVENTORY_CRAWL_ENV} breaks that cycle, which
 * is the whole reason this lane goes first.
 *
 * ## Why `vat inventory` and not a packaging verb
 *
 * Of the three call sites that consume a link walk, this is the only one that
 * consumes **membership alone**. `skill-packager.ts` also reads
 * `excludedReferences` and `deferredAssets`; `packaging-validator.ts` additionally
 * reads `maxBundledDepth`. The closure selects the identical files and emits **no
 * reason**, so pointing either of those at it would silently delete adopter-visible
 * validation findings. Membership parity is not flip-readiness, and this module
 * claims only the former.
 *
 * ## Both arms stay live, deliberately
 *
 * The incumbent remains the default and is not touched. This is an opt-in second
 * implementation whose purpose is evidence: with the switch on, a single
 * `vat-lab crawl run` prints the `crawl` and `closure` strata from one dump for
 * the first time, against the same subject, in the same process.
 */

import {
  ContributorRegistry,
  FilesystemExtentContributor,
  populate,
  type JsonValue,
  type Projection,
} from '@vibe-agent-toolkit/resources';
import { compareCodeUnits, safePath, toForwardSlash, type GitTracker } from '@vibe-agent-toolkit/utils';

import {
  InventorySkillExtentContributor,
  inventoryExtentContributorId,
  inventoryExtentDeclaration,
} from './inventory-extent.js';

/**
 * The env var that selects `vat inventory`'s crawler.
 *
 * An environment switch rather than a config field, for the same reason
 * `VAT_CRAWL_TIMING` is one: this selects which INSTRUMENT runs, not what the
 * project means. It is also what makes the choice reachable from the lab, which
 * spawns the binary and controls its environment — a config field would put the
 * A and B arms in the subject's own tree, where a measurement would be editing
 * the thing it measures.
 */
export const INVENTORY_CRAWL_ENV = 'VAT_INVENTORY_CRAWL';

/**
 * {@link INVENTORY_CRAWL_ENV}'s value that selects the projection lane.
 *
 * Kept as an explicit spelling after the projection became the DEFAULT, rather
 * than deleted as redundant: it is what the lab's A arm passes, and naming the
 * default out loud is how an A/B stays legible when the default later moves
 * again.
 */
export const INVENTORY_CRAWL_PROJECTION = 'projection';

/**
 * {@link INVENTORY_CRAWL_ENV}'s value that selects the incumbent link walk.
 *
 * This is the escape hatch, and it exists for two distinct readers. A user who
 * hits a membership difference the projection gets wrong can get their previous
 * answer back without downgrading vat; and the lab can still capture both arms
 * of the comparison from one build, which is the whole reason the switch was an
 * environment variable rather than config.
 */
export const INVENTORY_CRAWL_WALKER = 'walker';

/**
 * Whether this process should answer inventory membership from a projection.
 *
 * ## The projection is the DEFAULT as of 2026-08-15 — this predicate is inverted
 *
 * It shipped gated OFF, as a second implementation kept beside the first so the
 * two could be measured against each other in one process. Everything that
 * gating was waiting on is now discharged: `populate()` has a production caller,
 * membership parity is proven against the link walk on a real 18-skill adopter
 * plugin, and both lanes now emit members in one order — so the swap is
 * verifiable as a **byte-for-byte no-op** on `vat inventory`'s output rather than
 * as an unordered set comparison.
 *
 * ⚠️ **It is measurably SLOWER and that was accepted deliberately, not
 * overlooked** (Jeff, 2026-08-15). ~5.3× on that adopter: 522 ms of link walk
 * against 2,751 ms of projection, warm, on a clean machine. The cost is not the
 * membership traversal — that is 2.5% of the projection's own time — but the
 * substrate beneath it, which enumerates the whole tree (20,965 paths against
 * the walk's 1,673 markdown documents) and reads every file it can key. **Do not
 * "optimize" that away without reading the two contributors first: both halves
 * are load-bearing.** Narrowing enumeration to markdown drops real non-markdown
 * members, because membership is bounded by what the base realized; and
 * narrowing the parse to markdown deliberately blinds the closure to references
 * emitted from a skill's bundled scripts, which is one of the failures the
 * projection exists to fix.
 *
 * Read from the environment at each call rather than memoized at module load:
 * the cost is one property access on a lane that then crawls a corpus, and a
 * module-level binding would make the switch unobservable to a test that sets the
 * variable after import — which is every test, since `vitest.setup.js` clears
 * `VAT_*` before any module loads.
 *
 * Exactly one value turns it OFF, and an unrecognized value now lands on the
 * projection rather than the walk. The rule is unchanged and only its
 * destination moved: an unrecognized instrument selects the DEFAULT instrument
 * rather than throwing, because a typo'd selector must not fail a user's
 * command.
 *
 * @returns `true` when the projection lane is selected
 */
export function projectionCrawlSelected(): boolean {
  return process.env[INVENTORY_CRAWL_ENV] !== INVENTORY_CRAWL_WALKER;
}

/**
 * A populated projection, indexed to answer one question: which files does this
 * skill's extent contain?
 *
 * Absolute paths on the way in and on the way out, because that is the currency
 * `extractClaudeSkillInventory` works in; the root-relative coordinates the
 * projection stores are an internal detail of this index.
 */
export interface InventoryPopulation {
  /** The absolute root the population was built for — the reuse key. */
  readonly root: string;
  /**
   * The skill's linked files, or `undefined` when this population holds no
   * extent for that skill.
   *
   * `undefined` is not "no linked files": it means the question was not asked of
   * this population, and the caller must fall back rather than report an empty
   * membership as an answer.
   *
   * @param skillMdPath - Absolute path to the skill's SKILL.md
   * @returns Absolute paths of the skill's linked files, or `undefined`
   */
  membersOf(skillMdPath: string): readonly string[] | undefined;
}

/**
 * A way to obtain the one population every skill under a subject reads from.
 *
 * Takes the skill list because a population must register one
 * {@link InventorySkillExtentContributor} per skill BEFORE it runs — unlike a
 * registry, which is crawled once and then queried per skill. A fixed contributor
 * id would cap the population at a single extent, so the ids are per skill and the
 * set has to be known up front.
 *
 * Returns `undefined` when no single population can serve the subject — the same
 * contract, and the same reason, as the shared-registry provider: membership is
 * resolved relative to a root, so a population rooted elsewhere answers a
 * different question.
 */
export type SharedPopulationSource = (
  skillMdPaths: readonly string[],
) => Promise<InventoryPopulation | undefined>;

/**
 * Root-relative, forward-slashed — the coordinate system
 * `resource_realizations.path` uses, and the only one `closureFrom` resolves in.
 *
 * @param root - The absolute projection root
 * @param absolute - An absolute path under it
 * @returns The path as the projection spells it
 */
function relativeToRoot(root: string, absolute: string): string {
  return toForwardSlash(safePath.relative(root, absolute));
}

/**
 * Populate one root with an inventory extent per skill, and index the result.
 *
 * Registers exactly what the corpus parity test registers — one
 * `FilesystemExtentContributor` plus one {@link InventorySkillExtentContributor}
 * per skill — so the lane that ships and the lane that is measured for divergence
 * are assembled the same way. The blob stage the closure reads is the driver's own
 * and needs no registration.
 *
 * @param options - The root, its skills, and the run's git oracle
 * @param options.root - Absolute projection root
 * @param options.skillMdPaths - Absolute SKILL.md paths under that root
 * @param options.gitTracker - The oracle, or omitted for the tracker-less
 *   population. Not cosmetic: `resource_realizations.gitignored` is filled only
 *   when a tracker was supplied, so its absence changes which refusal rules the
 *   declaration may honestly carry
 * @returns The indexed population
 */
export async function buildInventoryPopulation(options: {
  root: string;
  skillMdPaths: readonly string[];
  gitTracker?: GitTracker | undefined;
}): Promise<InventoryPopulation> {
  const root = safePath.resolve(options.root);
  const hasGitTracker = options.gitTracker !== undefined;

  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());

  const parameters: Record<string, JsonValue> = {};
  // The skill's own root-relative path is the discriminator. It is unique within
  // the root by construction, unlike the frontmatter `name`, which is
  // caller-supplied text that may be missing or repeated — and a collision here
  // is not a mild defect: `ContributorRegistry.register` throws on a duplicate id,
  // which would turn two same-named skills into a failed inventory.
  for (const skillMdPath of options.skillMdPaths) {
    const relative = relativeToRoot(root, safePath.resolve(skillMdPath));
    registry.register(new InventorySkillExtentContributor(relative));
    parameters[inventoryExtentContributorId(relative)] = inventoryExtentDeclaration(
      relative,
      hasGitTracker,
    ) as unknown as JsonValue;
  }

  const projection = await populate({
    root,
    registry,
    parameters,
    ...(options.gitTracker !== undefined && { gitTracker: options.gitTracker }),
  });

  return indexPopulation(root, options.skillMdPaths, projection);
}

/**
 * Turn a populated projection into the per-skill membership index.
 *
 * @param root - The absolute projection root
 * @param skillMdPaths - The same skill list the population was built from
 * @param projection - The populated projection
 * @returns The population's read surface
 */
function indexPopulation(
  root: string,
  skillMdPaths: readonly string[],
  projection: Projection,
): InventoryPopulation {
  const extentIdByRelative = new Map<string, string>();
  for (const row of projection.zoneProvenance) {
    extentIdByRelative.set(row.contributorId, row.contextId);
  }

  const membersByExtent = new Map<string, string[]>();
  for (const row of projection.resourceRealizations) {
    const bucket = membersByExtent.get(row.extentId);
    if (bucket === undefined) membersByExtent.set(row.extentId, [row.path]);
    else bucket.push(row.path);
  }

  const byAbsoluteSkill = new Map<string, readonly string[]>();
  for (const skillMdPath of skillMdPaths) {
    const absolute = safePath.resolve(skillMdPath);
    const relative = relativeToRoot(root, absolute);
    const extentId = extentIdByRelative.get(inventoryExtentContributorId(relative));
    if (extentId === undefined) continue;
    const members = membersByExtent.get(extentId) ?? [];
    byAbsoluteSkill.set(
      absolute,
      members
        // `closureFrom` IS a member of its own extent; `collectLinkedFiles` never
        // lists the skill it walked from. Dropping it here is what makes the two
        // sets describe the same thing — the corpus parity test does the mirror
        // of this, adding the skill's own path to the WALKER's set.
        .filter((path) => path !== relative)
        .map((path) => safePath.resolve(root, path))
        .sort(compareCodeUnits),
    );
  }

  return {
    root,
    membersOf: (skillMdPath: string) => byAbsoluteSkill.get(safePath.resolve(skillMdPath)),
  };
}

