/**
 * A whole-corpus population of **this repository**, through `populate()`, with
 * every one of the six shipped extent contributors registered.
 *
 * ## Why this test lives in `claude-marketplace`
 *
 * The plan put it in `packages/resources/test/integration/`, and that is not
 * buildable: `SkillExtentContributor` lives in `agent-skills` and the plugin and
 * marketplace contributors live here, both of which sit *above* `resources` in
 * the dependency graph. `claude-marketplace` depends on `agent-skills`,
 * `resources`, `schema` and `utils`, so it is the only package that can hold all
 * six in one registry.
 *
 * ## Why it is in the system tier
 *
 * Its whole cost is one population of the live repository, so it grows with
 * the repository rather than with anything the file does: it crossed the
 * integration tier's 5 s per-file budget on the CI floor by merely existing
 * (5,047 ms on main, 2026-09-22). A corpus-scale run is system-shaped work.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * **Structural invariants only.** Every assertion here is a statement of the
 * form "no row references a row that does not exist" or "two independently
 * computed counts agree". Row *counts* are printed and never asserted: the
 * corpus is a live repository, so a count assertion is a test that fails on
 * every commit — and one that gets "fixed" by editing the expected number,
 * which is not a test at all.
 *
 * The measurements this run exists to produce (zones.md §17 risks 2 and 4) are
 * printed for the record and written up in `docs/architecture/zones.md`. As of
 * 2026-08-13, on 66 registered contributors: convergence on **pass 2**, ~5,700
 * resources, ~8,000 realizations, 170 extents, ~4,700 blobs, ~44,600 reference
 * candidates; 57 s wall on an idle machine, 175 s on a loaded one. Two runs
 * seven minutes apart disagreed on three of those counts, because the corpus is
 * a working tree. The pass count does not move, which is why it is the only
 * figure this file pins.
 *
 * ## Every heading and every parser link is a row
 *
 * `blobSectionsFor` and `blobReferencesFor` keep an input that carries no
 * position, with null position columns, rather than skipping it or defaulting
 * it to line 1. Remark does hand `toResourceLink` a `link` node with
 * `position === undefined` for a GFM autolink literal in certain quoted or
 * parenthesised contexts; that link is still a row. So each blob's rows number
 * exactly its own counts: one `blob_sections` row per heading
 * (`blobs.headingCount`), and one AST-derived `blob_references` row per link the
 * parser found (`blobs.linkCount`), whose `astIndex` values are exactly
 * 0 to linkCount - 1, the parser's own order.
 *
 * A test here once proved that none of the references the stage used to drop
 * for want of a position could have been a closure edge. Nothing is dropped any
 * more, so that question no longer arises: a positionless link is a row like
 * any other.
 *
 * ## Why the agreement is not vacuous
 *
 * `blobs.linkCount` and the AST-derived rows are two independent measurements
 * of one quantity. The check is armed by every AST link in the corpus, not by
 * the positionless ones, and {@link MIN_AST_REFERENCE_ROWS} keeps that honest.
 * Two markers say which rows are AST-derived: `astIndex !== null`, set by the
 * producer per row, and `AST_SYNTACTIC_FORMS`, the producer's own partition of
 * the forms. The check requires the two to agree on every row, so a partition
 * re-derived by hand (a hand-listed form triple once reported every HTML
 * reference as dropped) is caught rather than trusted.
 *
 * How many rows carry no position is printed, never asserted: it is a property
 * of the corpus and of remark, not an invariant.
 */

import {
  SkillExtentContributor,
  skillExtentContributorId,
  skillExtentDeclaration,
} from '@vibe-agent-toolkit/agent-skills';
import {
  NO_GIT_MEMBERS,
  AST_SYNTACTIC_FORMS,
  ClosureNonConvergenceError,
  ContributorRegistry,
  crawlSourceFor,
  DEFAULT_CONTENT_DEMAND,
  FilesystemExtentContributor,
  GitExtentContributor,
  populate,
  relativize,
  type ExtentContributor,
  type JsonValue,
  type Projection,
  withPopulationRun,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { NEVER_CRAWL_GLOBS, crawlDirectory } from '@vibe-agent-toolkit/utils/crawl';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { atLeastTierTimeout, refuseUnreadableFixture } from '@vibe-agent-toolkit/utils/testing';
import { beforeAll, describe, expect, inject, it } from 'vitest';

import {
  MarketplaceExtentContributor,
  PluginExtentContributor,
} from '../../src/projection/plugin-extent.js';

/** The corpus: this repository's root, four levels up from this file. */
const ROOT = safePath.resolve(__dirname, '..', '..', '..', '..');

/**
 * Closure passes the probe is willing to run before calling it non-convergent.
 *
 * Deliberately well above the measured depth: the probe re-populates the whole
 * corpus once per cap value, so this bounds the test's runtime, and a corpus
 * that genuinely needed more than this would be the finding.
 */
const PROBE_CEILING = 6;

/**
 * Floor on the AST-derived `blob_references` rows the link-count agreement runs over.
 *
 * **This is not the row-count assertion this file refuses to make** (see the
 * header). A count assertion pins the corpus and fails on the next commit; this
 * pins nothing about the corpus's size, only that the measurement below has a
 * subject at all. It can only fail one way — by the population *collapsing* —
 * and a collapse is a finding, not a rebase.
 *
 * It exists because a per-blob agreement over no AST rows is vacuously true,
 * and this file has already lost one assertion (the closure-edge test, see
 * header) to exactly that. Measured 2026-08-24:
 * 2,432 AST rows over the whole corpus, of which **926** come from `.md`/`.html`
 * blobs — the subset that survives if parsing is ever narrowed to markdown and
 * HTML. 500 sits below both, so it clears today and clears that narrowing, but
 * catches a parser that silently stops running.
 */
const MIN_AST_REFERENCE_ROWS = 500;

/** What the escalating-cap probe learned about the closure stratum. */
interface ConvergenceProbe {
  /** The projection from the first cap that converged. */
  projection: Projection;
  /** Passes the whole stratum needed before nobody moved. */
  passes: number;
  /**
   * Contributor ids still moving at the end of pass *k*, for `k = 2 … passes-1`.
   *
   * Pass 1 is not probed: `iterateClosure` seeds its digest map empty, so every
   * closure contributor moves on pass 1 by construction.
   */
  movingByPass: readonly (readonly string[])[];
}

let probe: ConvergenceProbe;
let registeredIds: readonly string[];

/**
 * Every SKILL.md the git extent can see, root-relative and forward-slashed.
 *
 * Discovered before population because `ContributorRegistry.register` runs
 * before `contribute` does — one `SkillExtentContributor` per skill, since a
 * fixed contributor id would cap the population at a single skill extent.
 *
 * @returns Root-relative SKILL.md paths, in crawl order
 */
async function discoverSkillPaths(): Promise<string[]> {
  const absolute = await crawlDirectory({
    outputs: [],
    baseDir: ROOT,
    unreadable: refuseUnreadableFixture(ROOT),
    include: ['**/SKILL.md'],
    exclude: [...NEVER_CRAWL_GLOBS],
    respectGitignore: true,
    includeUntracked: true,
  });
  return absolute.map((path) => relativize(path, ROOT));
}

/**
 * Build the registry and the per-contributor parameter map.
 *
 * The skill "name" is the SKILL.md's **root-relative path**, not its directory
 * basename: the basename is not unique in this corpus (several fixtures ship
 * `skills/foo/SKILL.md`), and a duplicate name would collide both in
 * `ContributorRegistry.register` and in the extent's within-root discriminator.
 *
 * @param skillPaths - Root-relative SKILL.md paths
 * @returns The registry, its parameters, and every registered contributor id
 */
function buildRegistry(skillPaths: readonly string[]): {
  registry: ContributorRegistry;
  parameters: Record<string, JsonValue>;
  ids: string[];
} {
  const registry = new ContributorRegistry();
  const parameters: Record<string, JsonValue> = {};
  const ids: string[] = [];

  const add = (contributor: ExtentContributor): void => {
    registry.register(contributor);
    ids.push(contributor.id);
  };

  add(new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND));
  add(new GitExtentContributor());

  for (const skillPath of skillPaths) {
    add(new SkillExtentContributor(skillPath));
    parameters[skillExtentContributorId(skillPath)] =
      // `false`, stated rather than defaulted: the gitignore refusal rule is
      // conditional on a usable `GitTracker`, and `zone_provenance.parameterSet`
      // must record the declaration this population ACTUALLY ran under. A run
      // that hands the base a usable tracker records `true` and a cascade one
      // rule longer — so a silent default here would let the recorded parameters
      // disagree with the extent they claim to describe.
      skillExtentDeclaration({}, skillPath, false) as unknown as JsonValue;
  }

  // Registered AFTER the skill contributors on purpose: `PluginExtentContributor`
  // absorbs the members of any `skill` extent nested inside a plugin directory,
  // so with this order it sees them on its first pass. The reverse order costs
  // the stratum one extra pass — measured, and recorded in zones.md.
  add(new PluginExtentContributor());
  add(new MarketplaceExtentContributor());

  return { registry, parameters, ids };
}

/**
 * Populate repeatedly with an increasing cap until the stratum converges.
 *
 * The cap is the only convergence oracle `populate` exposes, and it is enough:
 * `ClosureNonConvergenceError.contributorIds` names exactly the contributors
 * whose digest moved on the final pass, so running at cap *k* reports
 * *moving(k)* and the first cap that returns reports *moving(k) = ∅*.
 *
 * @param registry - The contributors to run
 * @param parameters - Per-contributor parameter sets
 * @returns The converged projection and the per-pass moving sets
 * @throws When the stratum has not converged by {@link PROBE_CEILING}
 */
async function probeConvergence(
  registry: ContributorRegistry,
  parameters: Record<string, JsonValue>,
): Promise<ConvergenceProbe> {
  const movingByPass: string[][] = [];
  const gitTracker = new GitTracker(ROOT);

  // From 2, not 1. `iterateClosure` seeds `previousDigests` empty, so *every*
  // closure contributor moves on pass 1 by construction — a cap-1 run is a
  // guaranteed throw that measures nothing and costs a whole population.
  for (let cap = 2; cap <= PROBE_CEILING; cap++) {
    try {
      const { projection } = await withPopulationRun(NO_GIT_MEMBERS, (run) => populate({
        root: ROOT, registry, parameters, gitTracker, run, maxIterations: cap,
      }));
      return { projection, passes: cap, movingByPass };
    } catch (error) {
      if (!(error instanceof ClosureNonConvergenceError)) throw error;
      movingByPass.push([...error.contributorIds]);
    }
  }

  throw new Error(
    `The closure stratum did not converge within ${PROBE_CEILING} passes over this corpus.`
    + ` Still moving on the last pass: ${(movingByPass.at(-1) ?? []).join(', ')}.`,
  );
}

/**
 * Where each blob's AST-derived `blob_references` rows disagree with its parse.
 *
 * `blobs.linkCount` is `parsed.links.length`, every link the blob's parser
 * found, and every one of them is a row whose `astIndex` is its place in that
 * list. So a blob's `astIndex` values, sorted, must be exactly 0 to
 * linkCount - 1: a missing index is a link that never became a row, a repeated
 * or out-of-range one is a row no parser produced.
 *
 * `astIndex !== null` and `AST_SYNTACTIC_FORMS` are two statements of which rows
 * are AST-derived, and every row must get the same answer from both.
 *
 * @param projection - The populated projection
 * @returns The blobs whose rows disagree with `linkCount`, the rows whose two
 *   markers disagree, the AST rows the agreement is taken over, and the AST rows
 *   per blob that carry no position
 */
function astReferenceAgreement(projection: Projection): {
  disagreements: string[];
  markerMismatches: string[];
  astRowTotal: number;
  positionless: Map<string, number>;
} {
  const astIndexes = new Map<string, number[]>();
  const markerMismatches: string[] = [];
  const positionless = new Map<string, number>();
  let astRowTotal = 0;
  for (const row of projection.blobReferences) {
    if ((row.astIndex !== null) !== AST_SYNTACTIC_FORMS.has(row.syntacticForm)) {
      markerMismatches.push(`${row.blob}#${row.ordinal}: ${row.syntacticForm} with astIndex ${String(row.astIndex)}`);
    }
    if (row.astIndex === null) continue;
    astRowTotal++;
    const indexes = astIndexes.get(row.blob);
    if (indexes === undefined) astIndexes.set(row.blob, [row.astIndex]);
    else indexes.push(row.astIndex);
    if (row.line === null) positionless.set(row.blob, (positionless.get(row.blob) ?? 0) + 1);
  }

  const disagreements: string[] = [];
  for (const blob of projection.blobs) {
    const indexes = (astIndexes.get(blob.contentKey) ?? []).sort((a, b) => a - b);
    const whole = indexes.length === blob.linkCount && indexes.every((value, position) => value === position);
    if (!whole) disagreements.push(`${blob.contentKey}: astIndex [${indexes.join(',')}] vs ${blob.linkCount} links`);
  }
  return { disagreements, markerMismatches, astRowTotal, positionless };
}

/**
 * First realized path for each keyed blob, so a content key can be named.
 *
 * "First" is arbitrary and deliberately so: a blob realized at three paths is
 * one blob, and this map exists only for the printed diagnostic below, which
 * needs *a* filename, not the authoritative one.
 *
 * @param projection - The populated projection
 * @returns Content key → one root-relative path realizing it
 */
function realizedPathByContentKey(projection: Projection): Map<string, string> {
  const pathByKey = new Map<string, string>();
  for (const row of projection.resourceRealizations) {
    if (row.contentKey !== null && !pathByKey.has(row.contentKey)) {
      pathByKey.set(row.contentKey, row.path);
    }
  }
  return pathByKey;
}

/**
 * Lowercased final extension of a path, or `(none)`.
 *
 * @param path - Root-relative path
 * @returns The extension including the dot
 */
function extensionOf(path: string): string {
  const match = /\.[^./]+$/.exec(path);
  return match === null ? '(none)' : match[0].toLowerCase();
}

/** Print the cardinalities this run exists to measure. Printed, never asserted. */
function reportCardinalities(projection: Projection): void {
  console.log('[risk 4] cardinality of a whole-corpus population of this repository');
  const table = {
    resources: projection.resources.length,
    resource_realizations: projection.resourceRealizations.length,
    resource_extents: projection.resourceExtents.length,
    resource_tags: projection.resourceTags.length,
    realization_conditions: projection.realizationConditions.length,
    resolution_contexts: projection.resolutionContexts.length,
    zone_provenance: projection.zoneProvenance.length,
    blobs: projection.blobs.length,
    blob_references: projection.blobReferences.length,
    blob_sections: projection.blobSections.length,
    blob_conditions: projection.blobConditions.length,
  };
  console.table(table);
  console.log('[extents by kind]', JSON.stringify(tally(
    projection.resolutionContexts.map((row) => row.kind),
  )));
  console.log('[realization conditions]', JSON.stringify(tally(
    projection.realizationConditions.map((row) => row.code),
  )));
  console.log('[blob conditions]', JSON.stringify(tally(
    projection.blobConditions.map((row) => row.code),
  )));
}

/**
 * Count occurrences of each distinct value.
 *
 * @param values - The values to tally
 * @returns Value → occurrence count
 */
function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

beforeAll(async () => {
  const skillPaths = await discoverSkillPaths();
  const { registry, parameters, ids } = buildRegistry(skillPaths);
  registeredIds = ids;

  probe = await probeConvergence(registry, parameters);

  console.log(`[setup] ${skillPaths.length} skills, ${ids.length} contributors registered`);
  console.log(`[risk 2] closure stratum converged on pass ${probe.passes}`);
  for (const [index, moving] of probe.movingByPass.entries()) {
    console.log(`  still moving after pass ${index + 2}: ${moving.length} — ${moving.join(', ')}`);
  }
  reportCardinalities(probe.projection);

}, atLeastTierTimeout(inject('tierHookTimeout'), 3_600_000));

describe('whole-corpus population', () => {
  it('converges within the probe ceiling', () => {
    expect(probe.passes).toBeLessThanOrEqual(PROBE_CEILING);
    // One recorded moving set per probed cap that threw; the probe starts at 2.
    expect(probe.movingByPass).toHaveLength(probe.passes - 2);
  });

  it('realizes only identities the resources table holds', () => {
    const known = new Set(probe.projection.resources.map((row) => row.resourceId));
    const orphans = probe.projection.resourceRealizations
      .filter((row) => !known.has(row.resourceId))
      .map((row) => `${row.extentId} ${row.path}`);
    expect(orphans).toEqual([]);
  });

  it('places every membership and realization in a declared resolution context', () => {
    const contexts = new Set(probe.projection.resolutionContexts.map((row) => row.contextId));
    const unknown = [
      ...probe.projection.resourceExtents.map((row) => row.extentId),
      ...probe.projection.resourceRealizations.map((row) => row.extentId),
    ].filter((extentId) => !contexts.has(extentId));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('keeps (extentId, path) unique across resource_realizations', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const row of probe.projection.resourceRealizations) {
      const key = `${row.extentId}\0${row.path}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it('records provenance for every extent, from a registered contributor, once each', () => {
    const registered = new Set(registeredIds);
    const contexts = new Set(probe.projection.resolutionContexts.map((row) => row.contextId));
    const keys = new Set<string>();
    const covered = new Set<string>();

    for (const row of probe.projection.zoneProvenance) {
      expect(registered.has(row.contributorId)).toBe(true);
      expect(contexts.has(row.contextId)).toBe(true);
      const key = `${row.contextId}\0${row.contributorId}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
      covered.add(row.contextId);
    }

    // No extent exists without a contributor accountable for it.
    expect([...contexts].filter((contextId) => !covered.has(contextId))).toEqual([]);
  });

  it('leaves no heading without a section row', () => {
    // One `blob_sections` row per heading, a heading with no position included
    // (kept with null span columns, never skipped).
    const sections = new Map<string, number>();
    for (const row of probe.projection.blobSections) {
      sections.set(row.blob, (sections.get(row.blob) ?? 0) + 1);
    }
    expect(probe.projection.blobs.some((row) => row.headingCount > 0)).toBe(true);
    const disagreements = probe.projection.blobs
      .filter((row) => row.headingCount !== (sections.get(row.contentKey) ?? 0))
      .map((row) => `${row.contentKey}: ${row.headingCount} headings vs ${sections.get(row.contentKey) ?? 0} rows`);
    expect(disagreements).toEqual([]);
  });

  it('agrees between blobs.sectionCount and the blob_sections rows', () => {
    const sections = new Map<string, number>();
    for (const row of probe.projection.blobSections) {
      sections.set(row.blob, (sections.get(row.blob) ?? 0) + 1);
    }
    const disagreements = probe.projection.blobs
      .filter((row) => row.sectionCount !== (sections.get(row.contentKey) ?? 0))
      .map((row) => `${row.contentKey}: ${row.sectionCount} vs ${sections.get(row.contentKey) ?? 0}`);
    expect(disagreements).toEqual([]);
  });

  it('agrees between blobs.linkCount and the parser-derived blob_references rows', () => {
    const { disagreements, markerMismatches, astRowTotal, positionless } = astReferenceAgreement(probe.projection);

    // Arm the assertion before making it: an agreement over no AST rows is
    // vacuously true. See {@link MIN_AST_REFERENCE_ROWS} for why a floor is not
    // the row-count assertion this file refuses to make.
    expect(astRowTotal).toBeGreaterThan(MIN_AST_REFERENCE_ROWS);
    expect(probe.projection.blobs.length).toBeGreaterThan(0);

    // Every row is AST-derived by both markers or by neither.
    expect(markerMismatches).toEqual([]);
    // Every link the parser found is exactly one row, positioned or not, and no
    // row is one the parser did not produce.
    expect(disagreements).toEqual([]);

    // Printed, never asserted: how many links arrived with no position is a
    // property of the corpus and of remark, not an invariant.
    const total = [...positionless.values()].reduce((sum, count) => sum + count, 0);
    const pathByKey = realizedPathByContentKey(probe.projection);
    console.log(`[positionless] ${total} AST reference row(s) with no source position,`
      + ` across ${positionless.size} blob(s), against ${astRowTotal} AST reference row(s)`);
    console.log(`  positionless-blob extensions: ${JSON.stringify(tally(
      [...positionless.keys()].map((contentKey) => extensionOf(pathByKey.get(contentKey) ?? '')),
    ))}`);
  });
});
