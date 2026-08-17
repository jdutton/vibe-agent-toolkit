/**
 * The **plugin** and **marketplace** extent contributors (zones.md §7.1, closure
 * stratum).
 *
 * ## Why these are the case that makes `resources` an entity table
 *
 * A plugin named in a marketplace manifest but not installed has no local path.
 * It is a {@link ResourceRow} with `kind: 'plugin'`, `observed: false` and
 * **zero realizations** — resource-projection §4.1's "known, but not present" —
 * and it is the concrete reason `resources` is one row per *entity* rather than
 * one row per file. Dropping it would lose the declaration entirely; realizing
 * it at a path that does not exist would make `exists` meaningless and collapse
 * the graded-resolution tiers of §6.3 (`same marketplace` / `known other
 * marketplace` / `unknown marketplace`) into one undifferentiated answer.
 *
 * The mirror image is the *installed* plugin, and it is the reason both
 * contributors also emit a `resource_tags` row. An installed plugin's identity
 * is its directory's identity, which the filesystem extent already claimed as
 * `kind: 'directory'`; `resources` keeps the first row per id and base
 * contributors run first, so the `kind: 'plugin'` row emitted here survives only
 * where there is no directory to lose to. The tag is keyed by
 * `(resourceId, tag, value, source)` and so is additive rather than a race —
 * *is this a plugin, and what is it called* stays answerable either way.
 *
 * ## Neither extent is a link closure, and neither is a fresh crawl
 *
 * `ClosureExtentContributor` is the §7.3 primitive for an extent defined by
 * *reachability through references*. Plugin and marketplace membership is not
 * that: a plugin contains what its manifest declares (plus the conventional
 * component directories Claude Code auto-discovers), and a marketplace contains
 * the plugins its manifest lists. That is a **manifest union**, not a reference
 * closure, so these are implemented directly rather than by contorting a
 * declaration into a `closureFrom` walk.
 *
 * They are nevertheless `closure`-stratum, for the reason §7.2 draws the line:
 * both are defined over *what other contributors already enumerated*. Manifests
 * are discovered from the base's realizations, members are re-keyed from the
 * base's realization rows, and a plugin extent absorbs any `skill` extent the
 * base holds beneath it. Consequently these contributors perform **no crawl of
 * their own** — the only filesystem read is the two manifest files, whose bytes
 * the projection does not otherwise carry.
 *
 * ## Idempotence under the fixpoint
 *
 * The merge driver re-invokes a closure contributor until its
 * {@link extentDigest} stops moving, so `contribute` must be a pure function of
 * the base. It is: every row is derived from the first realization the base
 * holds per path, membership is de-duplicated per extent, and conditions are
 * emitted once per `(extent, path)` rather than once per observation. The base
 * grows monotonically over a finite set of paths, so the row set reaches a fixed
 * point and `populate` never has to raise `ClosureNonConvergenceError`.
 *
 * ## Nesting lives in membership, never in `extentContextId`
 *
 * A plugin extent inside a marketplace extent looks like it should be spelled
 * with `resolution_contexts.extentContextId`, and it must not be:
 * `ResolutionContextRowSchema`'s refinement requires that column to be **null
 * for `species: 'extent'`** ("an extent is its own base") and non-null only for
 * a lens. So nesting is carried by rows — the marketplace extent holds the
 * plugin *entity* as a member, and the plugin's own extent holds that plugin's
 * files — which is also the only representation a federated query can join.
 */

import { readFileSync } from 'node:fs';

import { MarketplaceManifestSchema, type MarketplaceManifest } from '@vibe-agent-toolkit/agent-skills';
import {
  CONDITION_WITHOUT_REFERENCE,
  extentContextId,
  type ContributorStratum,
  type ExtentContribution,
  type ExtentContributor,
  type JsonValue,
  type ProjectionBase,
  type RealizationConditionRow,
  type ResourceRealizationRow,
} from '@vibe-agent-toolkit/resources';
import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';

import { ClaudePluginSchema } from '../schemas/claude-plugin.js';

/** `resolution_contexts.kind` for a plugin extent, and `resources.kind` for a plugin entity. */
export const PLUGIN_KIND = 'plugin';

/** `resolution_contexts.kind` for a marketplace extent. */
export const MARKETPLACE_KIND = 'marketplace';

/** `zone_provenance.contributorId` for {@link PluginExtentContributor}. */
export const PLUGIN_CONTRIBUTOR_ID = 'builtin:plugin';

/** `zone_provenance.contributorId` for {@link MarketplaceExtentContributor}. */
export const MARKETPLACE_CONTRIBUTOR_ID = 'builtin:marketplace';

/** A declared plugin nothing in this projection realizes. Legal, and the reason for zero realizations. */
export const PLUGIN_NOT_INSTALLED = 'PLUGIN_NOT_INSTALLED';

/** A manifest that could not be read or did not validate. */
export const MANIFEST_UNREADABLE = 'MANIFEST_UNREADABLE';

/** Root-relative suffix identifying a plugin manifest. */
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

/** Root-relative suffix identifying a marketplace manifest. */
const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';

/** `resolution_contexts.kind` of the extents a plugin extent absorbs. */
const SKILL_KIND = 'skill';

/**
 * Component directories Claude Code discovers without a manifest declaration.
 *
 * Included unconditionally, not only when the manifest omits the matching
 * field: a plugin that declares `skills` still ships auto-discovered
 * `commands/`, and an extent that omitted them would under-report the plugin.
 */
const CONVENTIONAL_COMPONENT_DIRS = ['agents', 'commands', 'hooks', 'skills'] as const;

/**
 * Manifest fields naming component paths.
 *
 * `hooks`, `mcpServers` and `lspServers` also accept an inline config object;
 * only the string and string-array forms name a path, and the object form is
 * skipped rather than guessed at.
 */
const COMPONENT_FIELDS = [
  'agents',
  'commands',
  'hooks',
  'lspServers',
  'mcpServers',
  'outputStyles',
  'skills',
] as const;

/** One marketplace manifest's plugin entry. */
type MarketplacePluginEntry = MarketplaceManifest['plugins'][number];

/** Everything one extent's row emission needs, gathered once. */
interface ExtentScope {
  readonly base: ProjectionBase;
  /** The extent's kind, which is also `resources.origin` for every row it emits. */
  readonly kind: string;
  /** The contributor emitting these rows — `resource_tags.source` keys on it. */
  readonly contributorId: string;
  readonly extentId: string;
  /** Root-relative path → the FIRST realization the base holds for it. */
  readonly byPath: ReadonlyMap<string, ResourceRealizationRow>;
  /** Paths already admitted to this extent, so overlapping declarations emit one row. */
  readonly admitted: Set<string>;
  readonly out: ExtentContribution;
}

/** What a plugin manifest tells its extent. */
interface PluginManifestFacts {
  /** The declared plugin name, recorded as `resources.vatId`, or null when unreadable. */
  readonly name: string | null;
  /** Plugin-relative component paths the manifest declares. */
  readonly componentPaths: readonly string[];
}

/**
 * Contributes one `plugin` extent per plugin manifest the base enumerated.
 *
 * Membership is the plugin's manifest and directory, everything beneath its
 * declared and conventional component directories, and the members of any
 * `skill` extent the base holds inside it — the nesting §4 calls for, without a
 * compile-time dependency on whichever contributor produced those skill extents.
 */
export class PluginExtentContributor implements ExtentContributor {
  readonly id: string = PLUGIN_CONTRIBUTOR_ID;

  readonly kind: string = PLUGIN_KIND;

  readonly stratum: ContributorStratum = 'closure';

  /**
   * False — and it is the one closure contributor for which that is true, which
   * is why the flag is declared rather than inferred from the stratum. This
   * extent is defined by manifests and directory conventions the base already
   * enumerated, not by following references, so it reads realizations only.
   */
  readonly readsBlobs = false;

  /**
   * Contribute every plugin extent discoverable from the base.
   *
   * @param base - Everything merged so far; supplies the realizations that
   *   decide which plugins exist and what they contain
   * @param _parameters - Unused: a plugin extent is fully determined by the
   *   manifests the base enumerated, so there is nothing to scope it by
   * @returns The contributed rows
   */
  async contribute(base: ProjectionBase, _parameters: JsonValue): Promise<ExtentContribution> {
    return contributeEachManifest(base, {
      suffix: PLUGIN_MANIFEST,
      kind: PLUGIN_KIND,
      contributorId: PLUGIN_CONTRIBUTOR_ID,
      contribute: contributePlugin,
    });
  }
}

/**
 * Contributes one `marketplace` extent per marketplace manifest the base
 * enumerated, including the plugins it names but does not contain.
 */
export class MarketplaceExtentContributor implements ExtentContributor {
  readonly id: string = MARKETPLACE_CONTRIBUTOR_ID;

  readonly kind: string = MARKETPLACE_KIND;

  readonly stratum: ContributorStratum = 'closure';

  /** False, for the reason {@link PluginExtentContributor.readsBlobs} states. */
  readonly readsBlobs = false;

  /**
   * Contribute every marketplace extent discoverable from the base.
   *
   * @param base - Everything merged so far; decides which declared plugins are
   *   present and which are merely known
   * @param _parameters - Unused, for the same reason as the plugin extent
   * @returns The contributed rows
   */
  async contribute(base: ProjectionBase, _parameters: JsonValue): Promise<ExtentContribution> {
    return contributeEachManifest(base, {
      suffix: MARKETPLACE_MANIFEST,
      kind: MARKETPLACE_KIND,
      contributorId: MARKETPLACE_CONTRIBUTOR_ID,
      contribute: contributeMarketplace,
    });
  }
}

/** What one manifest-driven extent family needs in order to emit its rows. */
interface ManifestExtentSpec {
  /** The manifest's root-relative path suffix. */
  readonly suffix: string;
  /** `resolution_contexts.kind` and `resources.origin` for the extents produced. */
  readonly kind: string;
  /** The emitting contributor's id, recorded on every tag. */
  readonly contributorId: string;
  /** What to emit for one discovered manifest. */
  readonly contribute: (scope: ExtentScope, directory: string, manifestPath: string) => void;
}

/**
 * Run one contributor over every manifest of a kind the base realized.
 *
 * @param base - The projection built so far
 * @param spec - Which manifests to find and what to emit for each
 * @returns The accumulated rows
 */
function contributeEachManifest(base: ProjectionBase, spec: ManifestExtentSpec): ExtentContribution {
  const byPath = indexFirstRealizationByPath(base);
  const out: ExtentContribution = {
    contexts: [], resources: [], realizations: [], memberships: [], tags: [], conditions: [],
  };

  for (const manifestPath of discoverManifests(byPath, spec.suffix)) {
    const directory = containingDirectoryOf(manifestPath, spec.suffix);
    spec.contribute(openExtent(base, byPath, out, spec, directory), directory, manifestPath);
  }

  return out;
}

/**
 * Emit one plugin's extent: its manifest, its directory, its components, and
 * any skill extent nested inside it.
 *
 * @param scope - The extent being populated
 * @param directory - Root-relative plugin directory
 * @param manifestPath - Root-relative path of `.claude-plugin/plugin.json`
 */
function contributePlugin(scope: ExtentScope, directory: string, manifestPath: string): void {
  const manifest = readPluginManifest(scope, manifestPath);
  admitEntity(scope, directory, PLUGIN_KIND, manifest.name);
  admitPath(scope, manifestPath);

  for (const relativeDir of componentDirectories(directory, manifest.componentPaths)) {
    admitTree(scope, relativeDir);
  }
  admitNestedSkillExtents(scope, directory);
}

/**
 * Emit one marketplace's extent: its manifest, its directory, and every plugin
 * it declares — present or not.
 *
 * @param scope - The extent being populated
 * @param directory - Root-relative marketplace directory
 * @param manifestPath - Root-relative path of `.claude-plugin/marketplace.json`
 */
function contributeMarketplace(scope: ExtentScope, directory: string, manifestPath: string): void {
  const manifest = readMarketplaceManifest(scope, manifestPath);
  admitEntity(scope, directory, MARKETPLACE_KIND, manifest?.name ?? null);
  admitPath(scope, manifestPath);

  for (const entry of manifest?.plugins ?? []) {
    contributeDeclaredPlugin(scope, directory, entry);
  }
}

/**
 * Emit one marketplace-declared plugin, whether or not anything realizes it.
 *
 * The absent case is the whole point: a membership row with no realization row,
 * plus a {@link PLUGIN_NOT_INSTALLED} condition so the gap is explained rather
 * than merely empty.
 *
 * @param scope - The marketplace extent
 * @param directory - Root-relative marketplace directory
 * @param entry - One `plugins[]` entry from the manifest
 */
function contributeDeclaredPlugin(
  scope: ExtentScope,
  directory: string,
  entry: MarketplacePluginEntry,
): void {
  const declaredPath = declaredPluginPath(directory, entry);
  const resourceId = admitEntity(scope, declaredPath, PLUGIN_KIND, entry.name);
  if (scope.byPath.has(declaredPath)) {
    return;
  }

  scope.out.conditions.push({
    extentId: scope.extentId,
    path: declaredPath,
    code: PLUGIN_NOT_INSTALLED,
    severity: 'info',
    message: `Plugin "${entry.name}" is declared by this marketplace, but nothing in this projection`
      + ` realizes it at "${declaredPath}" — it is known without being present`,
    resourceId,
    ...CONDITION_WITHOUT_REFERENCE,
  });
}

/**
 * Where a declared plugin would live under the marketplace.
 *
 * A string `source` is a marketplace-relative path (Claude Code refuses `..`
 * traversal in it, which `MarketplaceManifestSchema` already enforces), so it is
 * resolved as a path and deliberately **not** through `resolveAssetReference`:
 * that helper treats an unscoped `dir/file` as an npm bare specifier first, so a
 * source of `plugins/foo` would silently relocate to `node_modules/plugins/foo`
 * whenever a package of that name happens to be installed. This field is a
 * vendor manifest's relative path, not a VAT config-supplied asset reference.
 *
 * An external source (`github`, `url`, `npm`, `pip`) names no local path at all.
 * Its identity is minted at the location an install would use — the same
 * honest prediction `PackageExtentContributor` makes at `node_modules/<name>` —
 * so the row is a stable thing to join against, while `observed: false` and the
 * absence of any realization keep it from claiming to be there.
 *
 * @param directory - Root-relative marketplace directory
 * @param entry - The manifest entry
 * @returns Root-relative path the plugin would occupy
 */
function declaredPluginPath(directory: string, entry: MarketplacePluginEntry): string {
  const { source } = entry;
  return safePath.join(directory, typeof source === 'string' ? source : entry.name);
}

/**
 * Open one extent: emit its `resolution_contexts` row and return its scope.
 *
 * @param base - The projection built so far
 * @param byPath - The base's first realization per path
 * @param out - The contribution being accumulated
 * @param spec - The manifest family being contributed, supplying kind and contributor id
 * @param discriminator - Root-relative directory, distinguishing extents of one
 *   kind within one root. Never omitted: `ProjectionBuilder` keys
 *   `resolution_contexts` on `contextId` alone, keep-first, so a root-blind or
 *   discriminator-less id silently drops the second extent
 * @returns The scope subsequent emissions write through
 */
function openExtent(
  base: ProjectionBase,
  byPath: ReadonlyMap<string, ResourceRealizationRow>,
  out: ExtentContribution,
  spec: ManifestExtentSpec,
  discriminator: string,
): ExtentScope {
  const { rootId } = base.identities;
  const { kind, contributorId } = spec;
  const extentId = extentContextId(kind, rootId, discriminator);
  out.contexts.push({
    contextId: extentId,
    species: 'extent',
    kind,
    rootId,
    // Null, always: the schema refuses anything else for an extent. See the
    // module note on why nesting is carried by membership instead.
    extentContextId: null,
    role: null,
  });
  return { base, kind, contributorId, extentId, byPath, admitted: new Set<string>(), out };
}

/**
 * Admit a named entity — a plugin or a marketplace — realized or not.
 *
 * ## Why the tag is not redundant with `kind`
 *
 * An **installed** plugin's identity is the identity of its directory, which the
 * filesystem extent already minted as `kind: 'directory'`. `resources` keeps the
 * first row per `resourceId`, and base contributors run before closure ones, so
 * the `kind: 'plugin'` row emitted here is merged away for every plugin that is
 * actually on disk. It survives for exactly the case that has no directory to
 * lose to — the declared-but-absent plugin — which is a sharper statement of
 * §4.1 than a uniform `kind` would be, but it means `kind` alone cannot answer
 * *is this resource a plugin*.
 *
 * `resource_tags` can: it is keyed by `(resourceId, tag, value, source)`, so an
 * entity claim is additive rather than a race, and it carries the declared name
 * next to the contributor that read it.
 *
 * @param scope - The extent to admit into
 * @param relativePath - Root-relative path the entity occupies, or would
 * @param kind - `resources.kind` for the entity
 * @param vatId - The entity's declared name, or null when unknown
 * @returns The entity's identity
 */
function admitEntity(
  scope: ExtentScope,
  relativePath: string,
  kind: string,
  vatId: string | null,
): string {
  const realized = scope.byPath.get(relativePath);
  const resourceId = realized?.resourceId
    ?? scope.base.identities.idFor(absoluteOf(scope.base, relativePath));

  scope.admitted.add(relativePath);
  scope.out.resources.push({
    resourceId,
    kind,
    origin: scope.kind,
    // Both false for a declared-but-absent entity: nothing observed it, and no
    // enumeration produced it — a manifest did.
    observed: realized !== undefined,
    fromEnumeration: realized !== undefined,
    vatId,
  });
  scope.out.memberships.push({ resourceId, extentId: scope.extentId });
  scope.out.tags.push({ resourceId, tag: kind, value: vatId, source: scope.contributorId });
  if (realized !== undefined) {
    scope.out.realizations.push({ ...realized, extentId: scope.extentId });
  }
  return resourceId;
}

/**
 * Admit one root-relative path, if the base realized it.
 *
 * @param scope - The extent to admit into
 * @param relativePath - Root-relative path
 */
function admitPath(scope: ExtentScope, relativePath: string): void {
  const realized = scope.byPath.get(relativePath);
  if (realized !== undefined) {
    admitRealized(scope, realized);
  }
}

/**
 * Admit a realization the base already holds, re-keyed into this extent.
 *
 * The base's row is inherited rather than re-collected: this extent does not
 * re-observe the path, and a second `lstat` could disagree with the first.
 *
 * @param scope - The extent to admit into
 * @param row - The base's realization row
 */
function admitRealized(scope: ExtentScope, row: ResourceRealizationRow): void {
  if (scope.admitted.has(row.path)) {
    return;
  }
  scope.admitted.add(row.path);
  scope.out.resources.push({
    resourceId: row.resourceId,
    kind: row.isDirectory ? 'directory' : 'file',
    origin: scope.kind,
    observed: true,
    fromEnumeration: true,
    vatId: null,
  });
  scope.out.memberships.push({ resourceId: row.resourceId, extentId: scope.extentId });
  scope.out.realizations.push({ ...row, extentId: scope.extentId });
}

/**
 * Admit every base realization at or beneath one root-relative directory.
 *
 * @param scope - The extent to admit into
 * @param relativeDir - Root-relative directory (or file — an exact match counts)
 */
function admitTree(scope: ExtentScope, relativeDir: string): void {
  for (const row of scope.byPath.values()) {
    if (isWithin(relativeDir, row.path)) {
      admitRealized(scope, row);
    }
  }
}

/**
 * Absorb every `skill` extent the base holds inside this plugin.
 *
 * This is the nesting rule — *a plugin extent contains its skills' extents* —
 * expressed over rows rather than over a class, so it holds whether or not any
 * skill contributor is registered, and picks up a skill's members that live
 * *outside* the plugin directory (a bundled asset reached by reference) as well
 * as those inside it.
 *
 * @param scope - The plugin extent
 * @param directory - Root-relative plugin directory
 */
function admitNestedSkillExtents(scope: ExtentScope, directory: string): void {
  for (const context of scope.base.resolutionContexts) {
    if (context.species !== 'extent' || context.kind !== SKILL_KIND) {
      continue;
    }
    const rows = scope.base.resourceRealizations.filter((row) => row.extentId === context.contextId);
    if (!rows.some((row) => isWithin(directory, row.path))) {
      continue;
    }
    for (const row of rows) {
      admitRealized(scope, row);
    }
  }
}

/**
 * The root-relative directories one plugin's components live in.
 *
 * @param directory - Root-relative plugin directory
 * @param componentPaths - Plugin-relative paths the manifest declared
 * @returns Root-relative directories, declared ones first
 */
function componentDirectories(
  directory: string,
  componentPaths: readonly string[],
): string[] {
  return [...componentPaths, ...CONVENTIONAL_COMPONENT_DIRS]
    .map((componentPath) => safePath.join(directory, componentPath));
}

/**
 * Read and validate a plugin manifest, recording a condition when it cannot be.
 *
 * An unreadable manifest is a fact about the corpus, not a harness failure: the
 * extent still exists, with the conventional component directories only.
 *
 * @param scope - The plugin extent
 * @param manifestPath - Root-relative manifest path
 * @returns The declared name and component paths
 */
function readPluginManifest(scope: ExtentScope, manifestPath: string): PluginManifestFacts {
  const parsed = ClaudePluginSchema.safeParse(readJson(absoluteOf(scope.base, manifestPath)));
  if (!parsed.success) {
    scope.out.conditions.push(unreadableManifest(scope.extentId, manifestPath, PLUGIN_MANIFEST));
    return { name: null, componentPaths: [] };
  }
  return { name: parsed.data.name, componentPaths: componentPathsOf(parsed.data) };
}

/**
 * Read and validate a marketplace manifest, recording a condition when it
 * cannot be.
 *
 * @param scope - The marketplace extent
 * @param manifestPath - Root-relative manifest path
 * @returns The parsed manifest, or undefined
 */
function readMarketplaceManifest(
  scope: ExtentScope,
  manifestPath: string,
): MarketplaceManifest | undefined {
  const parsed = MarketplaceManifestSchema.safeParse(readJson(absoluteOf(scope.base, manifestPath)));
  if (!parsed.success) {
    scope.out.conditions.push(unreadableManifest(scope.extentId, manifestPath, MARKETPLACE_MANIFEST));
    return undefined;
  }
  return parsed.data;
}

/** The condition recording a manifest that could not be read or did not validate. */
function unreadableManifest(
  extentId: string,
  manifestPath: string,
  manifestKind: string,
): RealizationConditionRow {
  return {
    extentId,
    path: manifestPath,
    code: MANIFEST_UNREADABLE,
    severity: 'warning',
    message: `"${manifestPath}" could not be read as a ${manifestKind} manifest,`
      + ' so this extent holds only what convention supplies',
    resourceId: null,
    ...CONDITION_WITHOUT_REFERENCE,
  };
}

/**
 * Every path-shaped component declaration in a plugin manifest.
 *
 * An `if` chain over a field list rather than a `switch` over the union: the
 * inline-config form of `hooks` / `mcpServers` / `lspServers` names no path, and
 * enumerating union members here would put the manifest schema's job in this
 * function.
 *
 * @param manifest - A validated plugin manifest
 * @returns Plugin-relative component paths, in field order
 */
function componentPathsOf(manifest: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const field of COMPONENT_FIELDS) {
    const value = manifest[field];
    if (typeof value === 'string') {
      paths.push(value);
    } else if (Array.isArray(value)) {
      paths.push(...value.filter((item): item is string => typeof item === 'string'));
    }
  }
  return paths;
}

/**
 * Index the base's realizations by root-relative path, first row winning.
 *
 * First-wins is a stated tie-break, not an accident: a path realized in several
 * extents has one set of observed columns, and inheriting whichever extent was
 * registered last would make membership depend on registration order.
 *
 * @param base - The projection built so far
 * @returns Path → its first realization row
 */
function indexFirstRealizationByPath(
  base: ProjectionBase,
): ReadonlyMap<string, ResourceRealizationRow> {
  const byPath = new Map<string, ResourceRealizationRow>();
  for (const row of base.resourceRealizations) {
    if (!byPath.has(row.path)) {
      byPath.set(row.path, row);
    }
  }
  return byPath;
}

/**
 * Every manifest of one kind the base realized, in a stable order.
 *
 * Sorted by code unit rather than left in base order so the contribution — and
 * therefore its digest — does not depend on which contributor enumerated the
 * tree first.
 *
 * @param byPath - The base's first realization per path
 * @param suffix - Manifest path suffix to match
 * @returns Root-relative manifest paths
 */
function discoverManifests(
  byPath: ReadonlyMap<string, ResourceRealizationRow>,
  suffix: string,
): string[] {
  const found: string[] = [];
  for (const row of byPath.values()) {
    if (row.exists && !row.isDirectory && row.path.endsWith(suffix)) {
      found.push(row.path);
    }
  }
  // Explicit code-unit comparator: `sonarjs/no-alphabetical-sort` refuses a
  // bare `sort()`, and `localeCompare` would make row order — and therefore the
  // digest — depend on the host's collation.
  return found.sort(compareCodeUnits);
}

/**
 * The directory holding a manifest whose path ends with `suffix`.
 *
 * @param manifestPath - Root-relative manifest path
 * @param suffix - The suffix it ends with
 * @returns Root-relative directory, or `.` when the manifest is at the root
 */
function containingDirectoryOf(manifestPath: string, suffix: string): string {
  const cut = manifestPath.length - suffix.length;
  return cut <= 0 ? '.' : manifestPath.slice(0, cut - 1);
}

/**
 * Is a root-relative path at or beneath a root-relative directory?
 *
 * @param relativeDir - The containing directory, or `.` for the whole root
 * @param candidate - The path to test
 * @returns True when the candidate is the directory itself or below it
 */
function isWithin(relativeDir: string, candidate: string): boolean {
  if (relativeDir === '' || relativeDir === '.') {
    return true;
  }
  // Both operands are `resource_realizations.path` values, which `relativize`
  // has already forward-slashed, so no separator normalization is needed here.
  return candidate === relativeDir || candidate.startsWith(`${relativeDir}/`);
}

/**
 * The absolute path of a root-relative one.
 *
 * @param base - The projection built so far
 * @param relativePath - Root-relative, forward-slashed path
 * @returns Absolute, forward-slashed path
 */
function absoluteOf(base: ProjectionBase, relativePath: string): string {
  return relativePath === '.' ? base.root : safePath.join(base.root, relativePath);
}

/**
 * Parse a JSON file, reporting unreadable and malformed alike as `undefined`.
 *
 * @param absolutePath - Absolute path of the manifest
 * @returns The parsed value, or undefined
 */
function readJson(absolutePath: string): unknown {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a manifest path the base projection already enumerated
    const parsed: unknown = JSON.parse(readFileSync(absolutePath, 'utf8'));
    return parsed;
  } catch {
    return undefined;
  }
}
