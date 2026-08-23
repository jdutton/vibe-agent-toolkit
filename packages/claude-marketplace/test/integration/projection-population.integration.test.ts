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
 * ## The two skip counters are not equally clean, and the test says so
 *
 * `blobSectionsFor` and `blobReferencesFor` both **skip** an input that carries
 * no position rather than defaulting it to line 1. Headings need a line;
 * references need a line **and both offsets** (`hasReferenceSpan`), which is
 * not the same test — see that predicate's docstring. Headings: measured **0**,
 * a real invariant, asserted as one.
 *
 * References: **not** 0 — 80 of them on 2026-08-13, 97 on 2026-08-23. Remark hands
 * `toResourceLink` a `link` node with `position === undefined` for a GFM
 * autolink literal in certain quoted / parenthesised contexts, and this corpus's
 * non-markdown blobs are full of them
 * (`"WebFetch(domain:www.anthropic.com)"` in a `.ts` file). Asserting zero would
 * be asserting a falsehood; asserting the current count would be a row-count
 * assertion by another name. So the assertion here is the property the substrate
 * actually depends on and which a count cannot express: **every dropped
 * reference is one that could not have been a closure edge** — none of them
 * resolves, from its own referring file, to a path any realization occupies.
 * That is checked by re-resolving each dropped href through `resolveLocalHref`,
 * the same resolver `ClosureExtentContributor` walks with, rather than by
 * approximating "external" with a scheme regex.
 *
 * `projection-blob-population.test.ts` already pins the upstream behaviour with
 * a unit fixture; this is the corpus-scale companion, not a duplicate.
 */

import {
  SkillExtentContributor,
  skillExtentContributorId,
  skillExtentDeclaration,
} from '@vibe-agent-toolkit/agent-skills';
import {
  AST_SYNTACTIC_FORMS,
  ClosureNonConvergenceError,
  ContributorRegistry,
  FilesystemExtentContributor,
  GitExtentContributor,
  PackageExtentContributor,
  defaultParseCache,
  hasReferenceSpan,
  parseKeyed,
  populate,
  readContentWithKey,
  relativize,
  resolveLocalHref,
  type BlobPopulationResult,
  type ExtentContributor,
  type JsonValue,
  type ParseCache,
  type ParserKind,
  type Projection,
} from '@vibe-agent-toolkit/resources';
import { GitTracker, NEVER_CRAWL_GLOBS, crawlDirectory, safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

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

/** The prefix a content key carries when its bytes routed to the HTML parser. */
const HTML_KEY_PREFIX = 'html.';

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
let blobCounts: BlobPopulationResult;
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
    baseDir: ROOT,
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

  add(new FilesystemExtentContributor());
  add(new GitExtentContributor());
  add(new PackageExtentContributor());

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
 * @param onBlobPopulation - Receives the blob stage's counters each run
 * @returns The converged projection and the per-pass moving sets
 * @throws When the stratum has not converged by {@link PROBE_CEILING}
 */
async function probeConvergence(
  registry: ContributorRegistry,
  parameters: Record<string, JsonValue>,
  onBlobPopulation: (result: BlobPopulationResult) => void,
): Promise<ConvergenceProbe> {
  const movingByPass: string[][] = [];
  const gitTracker = new GitTracker(ROOT);

  // From 2, not 1. `iterateClosure` seeds `previousDigests` empty, so *every*
  // closure contributor moves on pass 1 by construction — a cap-1 run is a
  // guaranteed throw that measures nothing and costs a whole population.
  for (let cap = 2; cap <= PROBE_CEILING; cap++) {
    try {
      const projection = await populate({
        root: ROOT, registry, parameters, gitTracker, maxIterations: cap, onBlobPopulation,
      });
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
 * References the blob stage dropped, per blob, derived from the rows alone.
 *
 * `blobs.linkCount` is `parsed.links.length` — every link the blob's parser
 * found — so the difference between it and the blob's *parser-derived* rows is
 * exactly the links that could not be positioned. The lexer's rows cannot
 * contribute to either side: `LexicalReference.line`, `startOffset` and
 * `endOffset` are all required, so a lexical candidate is never dropped, and
 * `AST_SYNTACTIC_FORMS` is the producer's own statement of which forms are not
 * the lexer's.
 *
 * ⛔ This used to hold its own hand-listed `MARKDOWN_FORMS` triple and call it
 * "the three values only the markdown AST produces". That was true only while
 * mdast was the sole producer whose links survived to a row. The moment HTML
 * references got a span and their own `html-link` form, every one of them fell
 * outside the triple and this function reported them as dropped — 102 against
 * the stage's own 98, a disagreement of exactly the corpus's four HTML
 * references, none of which was dropped at all. The number was never the
 * problem: a consumer that re-derives a producer's partition by hand goes stale
 * the next time a parser is added, silently and in the direction of a false
 * alarm. Reading `AST_SYNTACTIC_FORMS` keeps the two measurements independent
 * (the counter is still `candidates - rows`, computed inside the stage) while
 * making them agree by construction rather than by coincidence.
 *
 * @param projection - The populated projection
 * @returns Content key → number of parser links dropped for want of a span
 */
function droppedReferencesByBlob(projection: Projection): Map<string, number> {
  const astRows = new Map<string, number>();
  for (const row of projection.blobReferences) {
    if (!AST_SYNTACTIC_FORMS.has(row.syntacticForm)) continue;
    astRows.set(row.blob, (astRows.get(row.blob) ?? 0) + 1);
  }

  const dropped = new Map<string, number>();
  for (const blob of projection.blobs) {
    const missing = blob.linkCount - (astRows.get(blob.contentKey) ?? 0);
    if (missing > 0) dropped.set(blob.contentKey, missing);
  }
  return dropped;
}

/** One dropped reference, with everything needed to judge whether it was an edge. */
interface DroppedReference {
  /** Root-relative path of the file that holds it. */
  from: string;
  /** The href exactly as authored. */
  href: string;
  /** Root-relative path it resolves to, when it resolves to a realized path. */
  resolvesTo: string | null;
}

/**
 * Re-parse the blobs that dropped a reference and resolve each dropped href.
 *
 * Only the affected blobs are re-read — the dropped hrefs are in no row, so
 * there is no cheaper way to see them, but there is no need to re-read the
 * other four thousand.
 *
 * @param projection - The populated projection
 * @param dropped - Content key → dropped count, from {@link droppedReferencesByBlob}
 * @returns One entry per dropped reference
 */
async function collectDroppedReferences(
  projection: Projection,
  dropped: ReadonlyMap<string, number>,
): Promise<DroppedReference[]> {
  const pathByKey = new Map<string, string>();
  for (const row of projection.resourceRealizations) {
    if (row.contentKey !== null && !pathByKey.has(row.contentKey)) {
      pathByKey.set(row.contentKey, row.path);
    }
  }
  const realizedPaths = new Set(projection.resourceRealizations.map((row) => row.path));
  const cache = defaultParseCache();
  const out: DroppedReference[] = [];

  for (const contentKey of dropped.keys()) {
    const from = pathByKey.get(contentKey);
    if (from === undefined) continue;
    out.push(...await droppedInBlob(contentKey, from, realizedPaths, cache));
  }

  return out;
}

/**
 * Re-read one blob and report every link the row builder could not position.
 *
 * The predicate is `hasReferenceSpan`, the producer's own — not a local
 * `line === undefined`. `astCandidates` rejects on the line **and** both
 * offsets, so a narrower question here would enumerate fewer references than
 * the count above claims were dropped, and the missing ones would be exactly
 * the shape (a line, no offsets) that hid the HTML under-report in the first
 * place: counted, never named, never resolved, never asserted on.
 *
 * @param contentKey - The blob's key, re-confirmed against the bytes read now
 * @param from - Root-relative path the bytes are read from
 * @param realizedPaths - Every path the projection realizes
 * @param cache - The content-addressed parse cache, already warm from population
 * @returns One entry per unpositionable link, empty when the bytes have changed
 */
async function droppedInBlob(
  contentKey: string,
  from: string,
  realizedPaths: ReadonlySet<string>,
  cache: ParseCache,
): Promise<DroppedReference[]> {
  const kind: ParserKind = contentKey.startsWith(HTML_KEY_PREFIX) ? 'html' : 'markdown';
  const keyed = await readContentWithKey(safePath.join(ROOT, from), kind);
  if (keyed.key !== contentKey) return [];
  const parsed = await parseKeyed(keyed, cache);

  return parsed.links.flatMap<DroppedReference>((link) => hasReferenceSpan(link)
    ? []
    : [{ from, href: link.href, resolvesTo: resolveWithin(link.href, from, realizedPaths) }]);
}

/**
 * Resolve an href from its referring file and report it only when the target is
 * a path this projection realizes.
 *
 * The same two steps `ClosureExtentContributor.resolveReference` performs, in
 * the same order and through the same resolver — a scheme regex would be a
 * second opinion about what "local" means.
 *
 * @param href - The reference exactly as authored
 * @param from - Root-relative path of the referring file
 * @param realizedPaths - Every path the projection realizes
 * @returns The root-relative target, or null when nothing realizes it
 */
function resolveWithin(href: string, from: string, realizedPaths: ReadonlySet<string>): string | null {
  const resolution = resolveLocalHref(href, `${ROOT}/${from}`, ROOT);
  if (resolution.kind !== 'resolved') return null;
  const candidate = relativize(resolution.resolvedPath, ROOT);
  return realizedPaths.has(candidate) ? candidate : null;
}

/** Print the cardinalities this run exists to measure. Printed, never asserted. */
function reportCardinalities(projection: Projection, counts: BlobPopulationResult): void {
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
  console.log('[blob stage]', JSON.stringify(counts));
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

  let latest: BlobPopulationResult | undefined;
  probe = await probeConvergence(registry, parameters, (result) => { latest = result; });
  if (latest === undefined) throw new Error('populate() never invoked onBlobPopulation');
  blobCounts = latest;

  console.log(`[setup] ${skillPaths.length} skills, ${ids.length} contributors registered`);
  console.log(`[risk 2] closure stratum converged on pass ${probe.passes}`);
  for (const [index, moving] of probe.movingByPass.entries()) {
    console.log(`  still moving after pass ${index + 2}: ${moving.length} — ${moving.join(', ')}`);
  }
  reportCardinalities(probe.projection, blobCounts);
}, 3_600_000);

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
    expect(blobCounts.headingsSkippedForMissingLine).toBe(0);
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

  it('drops no reference that could have been a closure edge', async () => {
    const dropped = droppedReferencesByBlob(probe.projection);
    const total = [...dropped.values()].reduce((sum, count) => sum + count, 0);
    // The rows and the counter are two independent measurements of one quantity.
    expect(total).toBe(blobCounts.referencesSkippedForMissingLine);

    const references = await collectDroppedReferences(probe.projection, dropped);
    console.log(`[skips] ${references.length} reference(s) dropped for want of a source span`);
    console.log(`  distinct hrefs: ${JSON.stringify([
      ...new Set(references.map((reference) => reference.href)),
    ].slice(0, 10))}`);

    const edges = references.filter((reference) => reference.resolvesTo !== null);
    expect(edges).toEqual([]);
  }, 300_000);
});
