/**
 * The plugin and marketplace extents, over the shipped inventory fixtures.
 *
 * The load-bearing case is the **uninstalled** plugin: `marketplace.json`
 * declares four plugins and only one of them is on disk, so a contributor that
 * skipped the other three — or invented a realization for them — would erase
 * the "known but not present" distinction that makes `resources` an entity
 * table rather than a file table. Both answers are present in ONE fixture on
 * purpose: `foo` is installed and observed, `missing`/`repo-plugin`/
 * `npm-plugin` are not, so "correctly absent" cannot be confused with "the
 * contributor found nothing at all".
 */

import {
  ContributorRegistry,
  DISCARD_BLOB_POPULATION,
  extentContextId,
  FilesystemExtentContributor,
  populate,
  ResolutionContextRowSchema,
  type Projection,
  type ResolutionContextRow,
  type ResourceRow,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MARKETPLACE_CONTRIBUTOR_ID,
  MARKETPLACE_KIND,
  MarketplaceExtentContributor,
  PLUGIN_CONTRIBUTOR_ID,
  PLUGIN_KIND,
  PLUGIN_NOT_INSTALLED,
  PluginExtentContributor,
} from '../src/projection/plugin-extent.js';

const FIXTURES = safePath.resolve(__dirname, 'fixtures');
const PLUGIN_ROOT = safePath.join(FIXTURES, 'inventory-plugin');
const MARKETPLACE_ROOT = safePath.join(FIXTURES, 'inventory-marketplace');

// Hoisted: `sonarjs/no-duplicate-string` blocks any literal used 3+ times, and
// these paths are named across most assertions below.
const CANONICAL_PLUGIN = 'canonical';
const CANONICAL_MANIFEST = 'canonical/.claude-plugin/plugin.json';
const CANONICAL_SKILL = 'canonical/skills/foo/SKILL.md';
const SIBLING_PLUGIN_FILE = 'tri-state/commands/cmd1.md';
const MARKETPLACE_DIR = 'local';
const INSTALLED_PLUGIN = 'local/plugins/foo';
const INSTALLED_PLUGIN_NAME = 'foo';
const EXTERNAL_PLUGIN_NAME = 'repo-plugin';

let pluginProjection: Projection;
let marketplaceProjection: Projection;

/** Populate a fixture root with the filesystem base plus both new extents. */
async function project(root: string): Promise<Projection> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  registry.register(new PluginExtentContributor());
  registry.register(new MarketplaceExtentContributor());
  return populate({ root, registry, onBlobPopulation: DISCARD_BLOB_POPULATION });
}

/** The extent context of one kind whose id carries `discriminator`. */
function extentOf(
  projection: Projection,
  kind: string,
  discriminator: string,
): ResolutionContextRow | undefined {
  return projection.resolutionContexts.find(
    (row) => row.kind === kind && row.contextId === extentContextId(kind, row.rootId, discriminator),
  );
}

/** Every root-relative path realized in one extent. */
function pathsIn(projection: Projection, extentId: string | undefined): string[] {
  return projection.resourceRealizations
    .filter((row) => row.extentId === extentId)
    .map((row) => row.path);
}

/** The `resources` rows that are members of one extent. */
function membersOf(projection: Projection, extentId: string | undefined): ResourceRow[] {
  const memberIds = new Set(
    projection.resourceExtents.filter((row) => row.extentId === extentId).map((row) => row.resourceId),
  );
  return projection.resources.filter((row) => memberIds.has(row.resourceId));
}

/**
 * The plugin entity carrying a declared name.
 *
 * Found through `resource_tags`, not through `resources.kind`: an installed
 * plugin's identity is its directory's identity, and the filesystem extent —
 * a base contributor, so merged first — already claimed it as `directory`.
 */
function pluginNamed(projection: Projection, name: string): ResourceRow | undefined {
  const tagged = projection.resourceTags.find(
    (row) => row.tag === PLUGIN_KIND && row.value === name,
  );
  return projection.resources.find((row) => row.resourceId === tagged?.resourceId);
}

/**
 * The distinct names tagged as plugins among one extent's members.
 *
 * De-duplicated because two contributors legitimately attest the same plugin —
 * the marketplace read it from its manifest, the plugin extent from the
 * plugin's own — and `resource_tags` keys on the source, so both rows survive.
 */
function pluginNamesIn(projection: Projection, extentId: string | undefined): string[] {
  const memberIds = new Set(membersOf(projection, extentId).map((row) => row.resourceId));
  const names = new Set(
    projection.resourceTags
      .filter((row) => row.tag === PLUGIN_KIND && memberIds.has(row.resourceId))
      .map((row) => row.value ?? ''),
  );
  return [...names].sort((left, right) => (left < right ? -1 : 1));
}

beforeAll(async () => {
  pluginProjection = await project(PLUGIN_ROOT);
  marketplaceProjection = await project(MARKETPLACE_ROOT);
}, 60_000);

describe('PluginExtentContributor', () => {
  it('populates a base the plugin extent can close over', () => {
    // Guards the vacuous pass: a closure contributor over an empty base emits
    // an empty extent, and every membership assertion below would then compare
    // one empty set with another.
    const filesystemPaths = pathsIn(
      pluginProjection,
      pluginProjection.resolutionContexts.find((row) => row.kind === 'filesystem')?.contextId,
    );
    expect(filesystemPaths).toContain(CANONICAL_MANIFEST);
    expect(filesystemPaths).toContain(CANONICAL_SKILL);
    expect(filesystemPaths).toContain(SIBLING_PLUGIN_FILE);
  });

  it('declares one extent per discovered plugin, keyed by the plugin directory', () => {
    const context = extentOf(pluginProjection, PLUGIN_KIND, CANONICAL_PLUGIN);
    expect(context?.species).toBe('extent');
    // An extent is its own base, so it points at no other extent. Nesting is
    // carried by membership, not by this column — the schema refuses anything
    // else for `species: 'extent'`.
    expect(context?.extentContextId).toBeNull();
  });

  it('contains the plugin manifest and its skill files, and nothing from a sibling plugin', () => {
    const extentId = extentOf(pluginProjection, PLUGIN_KIND, CANONICAL_PLUGIN)?.contextId;
    const paths = pathsIn(pluginProjection, extentId);
    expect(paths).toContain(CANONICAL_MANIFEST);
    expect(paths).toContain(CANONICAL_SKILL);
    expect(paths).not.toContain(SIBLING_PLUGIN_FILE);
  });

  it('tags the plugin directory as a plugin carrying its declared name', () => {
    // Through the tag, not through `resources.kind`: the filesystem extent
    // minted this identity as a `directory` first, and `resources` keeps the
    // first row per id — so an installed plugin can only be recognised by a
    // row that is additive rather than in a race.
    const extentId = extentOf(pluginProjection, PLUGIN_KIND, CANONICAL_PLUGIN)?.contextId;
    expect(pluginNamesIn(pluginProjection, extentId)).toEqual([CANONICAL_PLUGIN]);

    const plugin = pluginNamed(pluginProjection, CANONICAL_PLUGIN);
    expect(plugin?.observed).toBe(true);
    expect(pathsIn(pluginProjection, extentId)).toContain(CANONICAL_PLUGIN);
  });
});

describe('MarketplaceExtentContributor', () => {
  it('contains every plugin the manifest declares, installed or not', () => {
    const extentId = extentOf(marketplaceProjection, MARKETPLACE_KIND, MARKETPLACE_DIR)?.contextId;
    expect(pluginNamesIn(marketplaceProjection, extentId)).toEqual([
      INSTALLED_PLUGIN_NAME,
      'missing',
      'npm-plugin',
      EXTERNAL_PLUGIN_NAME,
    ]);
  });

  it('records an externalSource plugin as known but not present: observed false, zero realizations', () => {
    const external = pluginNamed(marketplaceProjection, EXTERNAL_PLUGIN_NAME);
    expect(external?.observed).toBe(false);
    // The one case where `kind: 'plugin'` survives the merge: no directory
    // exists for a base contributor to have claimed this identity as one.
    expect(external?.kind).toBe(PLUGIN_KIND);
    const realizations = marketplaceProjection.resourceRealizations.filter(
      (row) => row.resourceId === external?.resourceId,
    );
    expect(realizations).toHaveLength(0);
  });

  it('distinguishes that from an installed plugin in the same manifest', () => {
    const installed = pluginNamed(marketplaceProjection, INSTALLED_PLUGIN_NAME);
    expect(installed?.observed).toBe(true);
    const paths = marketplaceProjection.resourceRealizations
      .filter((row) => row.resourceId === installed?.resourceId)
      .map((row) => row.path);
    expect(paths).toContain(INSTALLED_PLUGIN);

    // Both contributors attest it independently — the marketplace from its
    // manifest, the plugin extent from the plugin's own — and `resource_tags`
    // keys on the source, so neither claim overwrites the other.
    const sources = marketplaceProjection.resourceTags
      .filter((row) => row.resourceId === installed?.resourceId && row.tag === PLUGIN_KIND)
      .map((row) => row.source)
      .sort((left, right) => (left < right ? -1 : 1));
    expect(sources).toEqual([MARKETPLACE_CONTRIBUTOR_ID, PLUGIN_CONTRIBUTOR_ID]);
  });

  it('explains every absent plugin with a condition rather than a silent gap', () => {
    const extentId = extentOf(marketplaceProjection, MARKETPLACE_KIND, MARKETPLACE_DIR)?.contextId;
    const absent = marketplaceProjection.realizationConditions.filter(
      (row) => row.extentId === extentId && row.code === PLUGIN_NOT_INSTALLED,
    );
    expect(absent.map((row) => row.path).sort((left, right) => (left < right ? -1 : 1))).toEqual([
      'local/npm-plugin',
      'local/plugins/missing',
      'local/repo-plugin',
    ]);
  });

  it('still declares a plugin extent for the installed plugin it points at', () => {
    const context = extentOf(marketplaceProjection, PLUGIN_KIND, INSTALLED_PLUGIN);
    expect(context?.species).toBe('extent');
  });
});

describe('the closure fixpoint', () => {
  it('settles within one confirming pass, so both contributors are idempotent', async () => {
    // `populate` throws ClosureNonConvergenceError rather than returning a
    // truncated extent, and a cap of 2 leaves exactly one confirming pass: any
    // row either contributor re-derives differently on a second look — a
    // re-emitted condition, an order that depends on the growing base — moves
    // its digest and fails here.
    const registry = new ContributorRegistry();
    registry.register(new FilesystemExtentContributor());
    registry.register(new PluginExtentContributor());
    registry.register(new MarketplaceExtentContributor());
    await expect(
      populate({
        root: MARKETPLACE_ROOT,
        registry,
        maxIterations: 2,
        onBlobPopulation: DISCARD_BLOB_POPULATION,
      }),
    ).resolves.toBeDefined();
  }, 60_000);

  it('emits extent contexts the zone schema accepts', () => {
    // The refinement worth pinning: `extentContextId` must be null for an
    // extent. Nesting a plugin extent inside a marketplace extent through that
    // column would parse-fail here rather than ship a wrong shape.
    for (const row of marketplaceProjection.resolutionContexts) {
      expect(() => ResolutionContextRowSchema.parse(row)).not.toThrow();
    }
  });
});

describe('ContributorRegistry.forKind (§7.5, from the consumer side)', () => {
  it('throws for "marketplace" until this contributor is registered', () => {
    const registry = new ContributorRegistry();
    registry.register(new FilesystemExtentContributor());
    expect(() => registry.forKind(MARKETPLACE_KIND)).toThrow(/No extent contributor is registered/);
    registry.register(new MarketplaceExtentContributor());
    expect(registry.forKind(MARKETPLACE_KIND)).toHaveLength(1);
  });
});
