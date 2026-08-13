/**
 * The **package** extent contributor (zones §7.1, base stratum).
 *
 * A package extent answers *what does this package make available* — which is
 * not the same question as *what files are in its directory*. The publisher's
 * `exports` map owns that answer, so every specifier this contributor resolves
 * goes through `resolveAssetReference`, the canonical VAT helper for "where is
 * this file?" (root `CLAUDE.md`). Writing a path-only resolver here would give
 * a package extent containing files the package does not expose, which is a
 * confident wrong answer about the one thing this extent exists to state.
 *
 * ## `node_modules` is resolved, never walked
 *
 * Enumerating `node_modules` by crawling it imports 40K+ files for a question
 * that is answered by reading one manifest and resolving N specifiers. Listing
 * and resolving are different concerns, and `CLAUDE.md` names the walk as
 * explicitly outside `resolveAssetReference`'s remit. So the population is
 * `root package + workspace members + declared dependencies`, and every one of
 * them is located by resolution.
 *
 * ## Zero realizations is the point, not an edge case
 *
 * A dependency declared in `dependencies` but absent from `node_modules` gets a
 * {@link ResourceRow} with `observed: false` and **no**
 * {@link ResourceRealizationRow} — resource-projection §4.1's "known, but not
 * present". Membership is knowledge; realization is presence. A contributor
 * that dropped the row would lose the declaration, and one that invented a
 * realization at a path that does not exist would make `exists` meaningless.
 * The identity is still minted, from the conventional install location, so the
 * row for a dependency is a stable thing to join against.
 *
 * The identity of an uninstalled package is minted at `node_modules/<name>`
 * because that is where an install would put it. A package manager that hoists
 * it elsewhere will mint a different id once it is installed — an honest
 * limitation of predicting a location, not a claim of stability.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { resolveAssetReference, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import type {
  ResourceRealizationRow,
  ResourceRow,
} from '../../schemas/projection-resources.js';
import type { JsonValue, ProjectionConditionSeverity } from '../../schemas/projection-shared.js';
import type { ContributorStratum, ExtentContribution, ExtentContributor } from '../contributor.js';
import type { ProjectionBase } from '../projection.js';
import { collectRealization, relativize } from '../realizations.js';

import { extentContextId } from './context-id.js';

/** A dependency is declared but nothing resolves for it. Legal, and the reason for zero realizations. */
export const PACKAGE_NOT_INSTALLED = 'PACKAGE_NOT_INSTALLED';

/** The package's `exports` map does not expose the requested subpath. */
export const PACKAGE_SUBPATH_NOT_EXPORTED = 'PACKAGE_SUBPATH_NOT_EXPORTED';

/** A subpath the `exports` map permits, whose target is not on disk. */
export const PACKAGE_SUBPATH_ABSENT = 'PACKAGE_SUBPATH_ABSENT';

/** Resolution threw for a reason that is neither absence nor an `exports` exclusion. */
export const PACKAGE_RESOLUTION_FAILED = 'PACKAGE_RESOLUTION_FAILED';

/** Node's code for "this package is not installed anywhere up the tree". */
const MODULE_NOT_FOUND = 'MODULE_NOT_FOUND';

/** Node's code for "the package is here, but its `exports` map hides this subpath". */
const NOT_EXPORTED = 'ERR_PACKAGE_PATH_NOT_EXPORTED';

const CONTRIBUTOR_ID = 'builtin:package';
const PACKAGE_KIND = 'package';
const MANIFEST = 'package.json';
const NODE_MODULES = 'node_modules';

/** Severity per condition code. A missing dependency is a fact, not a fault. */
const CONDITION_SEVERITY: Readonly<Record<string, ProjectionConditionSeverity>> = {
  [PACKAGE_NOT_INSTALLED]: 'info',
  [PACKAGE_SUBPATH_NOT_EXPORTED]: 'info',
  [PACKAGE_SUBPATH_ABSENT]: 'warning',
  [PACKAGE_RESOLUTION_FAILED]: 'error',
};

/**
 * What one run of the package contributor is scoped by.
 *
 * `subpaths` is what makes the `exports` map observable: the caller names the
 * assets it cares about (`schemas/skill.json`, `dist/index.js`), and each is
 * resolved through the publisher's declared surface rather than guessed at.
 */
export const PackageExtentParametersSchema = z.object({
  dependencyFields: z.array(z.string().min(1)).default(['dependencies'])
    .describe('Manifest fields read for declared dependency names'),
  subpaths: z.array(z.string().min(1)).default([])
    .describe('Package-relative subpaths to resolve inside every located package, honouring its exports map'),
}).strict();

export type PackageExtentParameters = z.infer<typeof PackageExtentParametersSchema>;

/** A package to contribute, with its directory when we already know it. */
interface PackageSpec {
  /** npm package name from the manifest, or from the declaring dependency field. */
  name: string;
  /** Absolute directory, present only for a package located without resolution. */
  directory?: string;
}

/** Either a located absolute path, or the condition code explaining its absence. */
type Location = { readonly path: string } | { readonly failure: string };

/** A parsed manifest. Fields beyond `name`/`workspaces` are read dynamically. */
type Manifest = Record<string, unknown>;

/**
 * Contributes the `package` extents: the workspace's own packages plus every
 * declared dependency, each located through its public surface.
 */
export class PackageExtentContributor implements ExtentContributor {
  readonly id = CONTRIBUTOR_ID;
  readonly kind = PACKAGE_KIND;
  readonly stratum: ContributorStratum = 'base';

  /**
   * Enumerate packages and resolve their declared surface.
   *
   * @param base - The projection built so far; supplies the corpus root and the shared identity map
   * @param parameters - {@link PackageExtentParametersSchema}-shaped, or null for the defaults
   * @returns One extent per package, with realizations only where something resolved
   */
  async contribute(base: ProjectionBase, parameters: JsonValue): Promise<ExtentContribution> {
    const params = PackageExtentParametersSchema.parse(parameters ?? {});
    const contribution: ExtentContribution = {
      contexts: [], resources: [], realizations: [], memberships: [], tags: [], conditions: [],
    };

    for (const spec of collectPackageSpecs(base.root, params)) {
      // Sequential on purpose: `ResourceIdentityMap` memoizes per path, and the
      // realization collector is a couple of `lstat`s — a fan-out would buy
      // nothing but a nondeterministic row order.
      await contributePackage(base, spec, params, contribution);
    }

    return contribution;
  }
}

/**
 * Add one package's extent, resource, membership and (when located) realization.
 */
async function contributePackage(
  base: ProjectionBase,
  spec: PackageSpec,
  params: PackageExtentParameters,
  out: ExtentContribution,
): Promise<void> {
  // The package name is a *within-root* discriminator, never the whole id: two
  // federated roots that both depend on `react` have two package extents, and
  // `resolution_contexts` keys on `contextId` alone, keep-first — so a
  // root-blind id would drop the second root's extent and leave its membership
  // rows pointing at the first root's.
  const extentId = extentContextId(PACKAGE_KIND, base.identities.rootId, spec.name);
  out.contexts.push({
    contextId: extentId,
    species: 'extent',
    kind: PACKAGE_KIND,
    rootId: base.identities.rootId,
    extentContextId: null,
    role: null,
  });

  const located = spec.directory === undefined
    ? locatePackage(spec.name, base.root)
    : { path: spec.directory };
  const packagePath = 'path' in located
    ? located.path
    : safePath.join(base.root, NODE_MODULES, spec.name);
  const resourceId = base.identities.idFor(packagePath);

  out.resources.push(resourceRow(resourceId, PACKAGE_KIND, 'path' in located));
  out.memberships.push({ resourceId, extentId });

  if (!('path' in located)) {
    out.conditions.push({
      extentId,
      path: relativize(packagePath, base.root),
      code: located.failure,
      severity: CONDITION_SEVERITY[located.failure] ?? 'warning',
      message: `Package "${spec.name}" is declared but was not located from the corpus root`,
      resourceId,
    });
    return;
  }

  out.realizations.push(await realization(base, located.path, resourceId, extentId));
  for (const subpath of params.subpaths) {
    await contributeSubpath(base, spec.name, extentId, subpath, out);
  }
}

/**
 * Add one `exports`-honoured subpath of an already-located package.
 */
async function contributeSubpath(
  base: ProjectionBase,
  packageName: string,
  extentId: string,
  subpath: string,
  out: ExtentContribution,
): Promise<void> {
  const specifier = `${packageName}/${subpath}`;
  const located = resolveSpecifier(specifier, base.root, subpathFailureCode);
  if (!('path' in located)) {
    const conventional = safePath.join(base.root, NODE_MODULES, packageName, subpath);
    out.conditions.push({
      extentId,
      path: relativize(conventional, base.root),
      code: located.failure,
      severity: CONDITION_SEVERITY[located.failure] ?? 'warning',
      message: `Subpath "${specifier}" did not resolve through the package's declared surface`,
      resourceId: null,
    });
    return;
  }

  const resourceId = base.identities.idFor(located.path);
  out.resources.push(resourceRow(resourceId, 'file', true));
  out.memberships.push({ resourceId, extentId });
  out.realizations.push(await realization(base, located.path, resourceId, extentId));
}

/** A `resources` row, with the two columns this contributor never varies fixed. */
function resourceRow(resourceId: string, kind: string, observed: boolean): ResourceRow {
  // `origin` carries the extent KIND, not the contributor id — filesystem, git, closure, plugin
  // and marketplace all write their kind, and this one wrote `builtin:package`, which made the
  // column's vocabulary unreadable across contributors.
  return { resourceId, kind, origin: PACKAGE_KIND, observed, fromEnumeration: true, vatId: null };
}

/** The realization row for an absolute path in one package extent. */
async function realization(
  base: ProjectionBase,
  absolutePath: string,
  resourceId: string,
  extentId: string,
): Promise<ResourceRealizationRow> {
  return collectRealization(absolutePath, resourceId, { root: base.root, extentId });
}

/**
 * Locate a package's directory through its manifest subpath.
 *
 * `resolveAssetReference` cannot resolve a bare package *name* — its specifier
 * pattern requires a subpath — so the probe is `<name>/package.json` and the
 * directory is its parent. A package whose `exports` map hides its own manifest
 * is therefore unlocatable through its public surface, which is reported as
 * such rather than papered over with a `node_modules` guess.
 */
function locatePackage(packageName: string, root: string): Location {
  const located = resolveSpecifier(`${packageName}/${MANIFEST}`, root, packageFailureCode);
  return 'path' in located ? { path: safePath.join(located.path, '..') } : located;
}

/**
 * Resolve one specifier, treating a resolved-but-absent target as unresolved.
 *
 * The existence check is not belt-and-braces: `resolveAssetReference` falls back
 * to *path* resolution for an unscoped bare specifier that Node reports as
 * `MODULE_NOT_FOUND`, so a successful return is not by itself evidence that
 * anything is installed.
 *
 * @param specifier - `<name>/<subpath>` bare specifier
 * @param root - Corpus root, the resolution anchor
 * @param failureCodeFor - Maps a thrown error to this caller's condition code
 * @returns The forward-slashed absolute path, or a condition code
 */
function resolveSpecifier(
  specifier: string,
  root: string,
  failureCodeFor: (error: unknown) => string,
): Location {
  let resolved: string;
  try {
    resolved = resolveAssetReference(specifier, root);
  } catch (error) {
    return { failure: failureCodeFor(error) };
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Node-resolved target of a manifest-declared specifier
  return existsSync(resolved) ? { path: toForwardSlash(resolved) } : { failure: failureCodeFor(undefined) };
}

/**
 * Distinguish "declared but not installed" from "resolution failed otherwise".
 *
 * `MODULE_NOT_FOUND` (and the `undefined` this module passes for a resolved
 * target that is not on disk) is the legal zero-realization case. An `exports`
 * exclusion means the package may well be installed — it simply does not expose
 * its manifest, so we still cannot say where it is. Anything else (a malformed
 * manifest, a permissions error) is a genuine failure and is recorded as one
 * rather than thrown: one unreadable dependency must not abort a population.
 */
function packageFailureCode(error: unknown): string {
  const code = errorCodeOf(error);
  if (code === NOT_EXPORTED) return PACKAGE_SUBPATH_NOT_EXPORTED;
  if (code === MODULE_NOT_FOUND || code === undefined) return PACKAGE_NOT_INSTALLED;
  return PACKAGE_RESOLUTION_FAILED;
}

/** For a subpath of an already-located package, absence and exclusion are the only outcomes. */
function subpathFailureCode(error: unknown): string {
  return errorCodeOf(error) === NOT_EXPORTED ? PACKAGE_SUBPATH_NOT_EXPORTED : PACKAGE_SUBPATH_ABSENT;
}

/** Node's error code, read through the `cause` `resolveAssetReference` wraps it in. */
function errorCodeOf(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : error;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause as { code: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * The packages this run contributes: the root package, every workspace member,
 * and every name declared in the configured dependency fields of either.
 *
 * Names are de-duplicated with the located spelling winning, so a workspace
 * member that is also declared as a dependency of a sibling is contributed once,
 * from its real directory.
 */
function collectPackageSpecs(root: string, params: PackageExtentParameters): PackageSpec[] {
  const specs = new Map<string, PackageSpec>();
  const manifests: Manifest[] = [];

  const rootManifest = readManifest(safePath.join(root, MANIFEST));
  if (rootManifest !== undefined) {
    manifests.push(rootManifest);
    addOwnPackage(specs, rootManifest, root);
    for (const directory of workspaceDirectories(root, rootManifest)) {
      const manifest = readManifest(safePath.join(directory, MANIFEST));
      if (manifest === undefined) continue;
      manifests.push(manifest);
      addOwnPackage(specs, manifest, directory);
    }
  }

  for (const manifest of manifests) {
    for (const name of declaredDependencies(manifest, params.dependencyFields)) {
      if (!specs.has(name)) specs.set(name, { name });
    }
  }

  return [...specs.values()];
}

/** Record a package we already hold the directory of. */
function addOwnPackage(specs: Map<string, PackageSpec>, manifest: Manifest, directory: string): void {
  const name = manifest['name'];
  if (typeof name === 'string' && name.length > 0) {
    specs.set(name, { name, directory });
  }
}

/** Every dependency name declared across the configured manifest fields. */
function declaredDependencies(manifest: Manifest, fields: readonly string[]): string[] {
  const names: string[] = [];
  for (const field of fields) {
    const value = manifest[field];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      names.push(...Object.keys(value));
    }
  }
  return names;
}

/**
 * Expand the `workspaces` field to absolute member directories.
 *
 * npm's array form and Yarn's `{ packages: [...] }` form are both accepted.
 * Only a literal path and a trailing `/*` are expanded — the two shapes every
 * workspace in practice uses — and a `/*` expansion is one `readdir` of the
 * parent, not a tree walk.
 */
function workspaceDirectories(root: string, manifest: Manifest): string[] {
  const directories: string[] = [];
  for (const pattern of workspacePatterns(manifest['workspaces'])) {
    if (typeof pattern === 'string') {
      directories.push(...expandWorkspacePattern(root, pattern));
    }
  }
  return directories;
}

/** The raw pattern list, accepting npm's array form and Yarn's `{ packages }` form. */
function workspacePatterns(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  const nested = typeof raw === 'object' && raw !== null
    ? (raw as { packages?: unknown }).packages
    : undefined;
  return Array.isArray(nested) ? nested : [];
}

/** One workspace pattern's member directories. */
function expandWorkspacePattern(root: string, pattern: string): string[] {
  if (pattern.endsWith('/*')) {
    const parent = safePath.join(root, pattern.slice(0, -2));
    return childDirectories(parent);
  }
  return pattern.includes('*') ? [] : [safePath.join(root, pattern)];
}

/** Immediate subdirectories of a path, or none when it cannot be read. */
function childDirectories(parent: string): string[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a workspaces-declared directory under the corpus root
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => safePath.join(parent, entry.name));
  } catch {
    return [];
  }
}

/**
 * Read and parse a manifest, or report `undefined`.
 *
 * A missing or malformed `package.json` is a fact about the corpus, not a
 * harness error — a workspace glob legitimately matches a directory that is not
 * a package.
 */
function readManifest(manifestPath: string): Manifest | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a manifest path derived from the corpus root
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Manifest)
      : undefined;
  } catch {
    return undefined;
  }
}
