/**
 * The workspace dependency graph, read from the one place it is declared:
 * every `packages/*\/package.json` and its `workspace:` specifiers.
 *
 * 🔑 **`package.json` is the only owner of "what depends on what".** This graph
 * used to be declared three more times by hand — per-package `tsconfig.json`
 * `references`, the `PUBLISHED_PACKAGES` publish order, and the postinstall
 * symlink list — and two of the three had drifted (12 of 25 reference lists
 * disagreed with the manifests; the publish order put two packages before a
 * dependency, so for the window between the two `npm publish` calls the
 * earlier one was uninstallable). Everything that needs the graph now derives
 * it from here: `generate-tsconfig-refs.ts` writes the references,
 * {@link publishedPackagesInDependencyOrder} replaces the hand list, and
 * `validate-repo-structure.ts` fails when a derived artifact is stale.
 *
 * Reading is deliberately strict. A manifest that exists but cannot be parsed
 * throws rather than dropping the package from the graph: a graph that is
 * silently one node short publishes, links and references everything except
 * the package that is broken.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { direntKindFollowingSync, isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

import type { DEPENDENCY_FIELDS } from './resolve-workspace-deps.js';

/** The `workspace:` protocol prefix Bun writes for an in-repo dependency. */
const WORKSPACE_PROTOCOL = 'workspace:';

/** A dependency field's kind, for callers that want only what `src/` can import. */
export type DependencyKind = 'runtime' | 'dev';

/** One workspace package, as the graph sees it. */
export interface WorkspacePackage {
  /** Directory name under `packages/` — the key every derived list is keyed on. */
  readonly dir: string;
  /** The manifest `name`. */
  readonly name: string;
  /** `private: true` — never published, never installed by an adopter. */
  readonly isPrivate: boolean;
  /** The parsed manifest, for callers that read fields the graph does not model. */
  readonly manifest: Readonly<Record<string, unknown>>;
  /**
   * Manifest names of the workspace packages this one declares, by kind.
   * `runtime` is `dependencies` + `peerDependencies` + `optionalDependencies`
   * (what compiled `src/` may import); `dev` is `devDependencies`.
   */
  readonly workspaceDeps: Readonly<Record<DependencyKind, readonly string[]>>;
}

/** The whole graph plus a name index. */
export interface WorkspaceGraph {
  /** Every package, sorted by directory name. */
  readonly packages: readonly WorkspacePackage[];
  /** Manifest name → package. */
  readonly byName: ReadonlyMap<string, WorkspacePackage>;
}

/** Which manifest fields feed each {@link DependencyKind}. */
const FIELDS_BY_KIND: Readonly<Record<DependencyKind, readonly (typeof DEPENDENCY_FIELDS)[number][]>> = {
  runtime: ['dependencies', 'peerDependencies', 'optionalDependencies'],
  dev: ['devDependencies'],
};

/**
 * Names declared under `fields` whose specifier uses the workspace protocol.
 * Sorted, so every derived artifact is byte-stable across runs.
 */
function workspaceNamesIn(manifest: Record<string, unknown>, fields: readonly string[]): string[] {
  const names = new Set<string>();
  for (const field of fields) {
    const block = manifest[field];
    if (typeof block !== 'object' || block === null) continue;
    for (const [name, specifier] of Object.entries(block as Record<string, unknown>)) {
      if (typeof specifier === 'string' && specifier.startsWith(WORKSPACE_PROTOCOL)) {
        names.add(name);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Read one package directory into a {@link WorkspacePackage}, or `undefined`
 * when it holds no manifest (not every directory under `packages/` is a
 * package — `packages/README.md` is a file, and a scratch directory is not a
 * workspace). A manifest that is present but unreadable or not JSON throws.
 */
function readPackage(packagesDir: string, dir: string): WorkspacePackage | undefined {
  const manifestPath = safePath.join(packagesDir, dir, 'package.json');
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw new Error(
      `Cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const name = manifest['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${manifestPath} declares no "name"; every workspace package must be nameable`);
  }

  return {
    dir,
    name,
    isPrivate: manifest['private'] === true,
    manifest,
    workspaceDeps: {
      runtime: workspaceNamesIn(manifest, FIELDS_BY_KIND.runtime),
      dev: workspaceNamesIn(manifest, FIELDS_BY_KIND.dev),
    },
  };
}

/**
 * Read the graph under `<repoRoot>/packages`.
 *
 * @param repoRoot - Absolute path of the monorepo root
 * @returns Every package, keyed both ways
 * @throws When a manifest is unreadable, unparseable, nameless, or two
 *   directories declare the same name — each of which would make some derived
 *   list wrong about a package that exists
 */
export function readWorkspaceGraph(repoRoot: string): WorkspaceGraph {
  const packagesDir = safePath.join(repoRoot, 'packages');
  const dirs = readdirSync(packagesDir, { withFileTypes: true })
    // Followed: a workspace package reached through a link is still a package.
    .filter((entry) => direntKindFollowingSync(packagesDir, entry) === 'directory')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const packages: WorkspacePackage[] = [];
  const byName = new Map<string, WorkspacePackage>();
  for (const dir of dirs) {
    const pkg = readPackage(packagesDir, dir);
    if (pkg === undefined) continue;
    const clash = byName.get(pkg.name);
    if (clash !== undefined) {
      throw new Error(
        `packages/${clash.dir} and packages/${dir} both declare "name": "${pkg.name}"; ` +
          'a workspace name must map to exactly one directory',
      );
    }
    byName.set(pkg.name, pkg);
    packages.push(pkg);
  }

  return { packages, byName };
}

/**
 * The workspace packages `pkg` depends on, as graph nodes — dependencies whose
 * name no package in the graph carries are ignored (a `workspace:` specifier
 * naming nothing is a Bun install error long before it is this module's
 * problem).
 */
export function workspaceDependenciesOf(
  pkg: WorkspacePackage,
  graph: WorkspaceGraph,
  kinds: readonly DependencyKind[] = ['runtime', 'dev'],
): WorkspacePackage[] {
  const names = new Set<string>();
  for (const kind of kinds) for (const name of pkg.workspaceDeps[kind]) names.add(name);
  return [...names]
    .map((name) => graph.byName.get(name))
    .filter((dep): dep is WorkspacePackage => dep !== undefined)
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The edges among `nodes`: what each still waits on, and who waits on each. */
function buildEdges(
  graph: WorkspaceGraph,
  nodes: readonly WorkspacePackage[],
  kinds: readonly DependencyKind[],
): { remainingDeps: Map<string, Set<string>>; dependents: Map<string, Set<string>> } {
  const inSubset = new Set(nodes.map((pkg) => pkg.dir));
  const remainingDeps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const pkg of nodes) {
    const deps = workspaceDependenciesOf(pkg, graph, kinds).filter((dep) => inSubset.has(dep.dir));
    remainingDeps.set(pkg.dir, new Set(deps.map((dep) => dep.dir)));
    for (const dep of deps) {
      const set = dependents.get(dep.dir) ?? new Set<string>();
      set.add(pkg.dir);
      dependents.set(dep.dir, set);
    }
  }
  return { remainingDeps, dependents };
}

/**
 * Dependencies before dependents, ties broken alphabetically by directory.
 *
 * Kahn's algorithm with a sorted ready-queue, so the result is a single
 * deterministic order rather than "some valid order" — a derived list that
 * changes between runs would make every `--check` flap.
 *
 * @param graph - The graph to order
 * @param options - `kinds` selects which edges count (default: runtime only,
 *   which is what a publish order needs); `subset` restricts the nodes ordered
 *   (edges to packages outside the subset are ignored)
 * @returns The packages in dependency order
 * @throws On a cycle, naming every package still unordered — a cycle has no
 *   valid order, and a partial answer would publish half the packages
 */
export function topologicalOrder(
  graph: WorkspaceGraph,
  options: { readonly kinds?: readonly DependencyKind[]; readonly subset?: ReadonlySet<string> } = {},
): WorkspacePackage[] {
  const nodes = graph.packages.filter((pkg) => options.subset?.has(pkg.dir) ?? true);
  const { remainingDeps, dependents } = buildEdges(graph, nodes, options.kinds ?? ['runtime']);

  const byDir = new Map(nodes.map((pkg) => [pkg.dir, pkg] as const));
  const ready = nodes.filter((pkg) => remainingDeps.get(pkg.dir)?.size === 0).map((pkg) => pkg.dir);
  const ordered: WorkspacePackage[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => a.localeCompare(b));
    const dir = ready.shift();
    const pkg = dir === undefined ? undefined : byDir.get(dir);
    if (dir === undefined || pkg === undefined) break;
    ordered.push(pkg);
    for (const dependent of dependents.get(dir) ?? []) {
      const remaining = remainingDeps.get(dependent);
      remaining?.delete(dir);
      if (remaining?.size === 0) ready.push(dependent);
    }
  }

  if (ordered.length !== nodes.length) {
    const stuck = nodes.filter((pkg) => (remainingDeps.get(pkg.dir)?.size ?? 0) > 0).map((pkg) => pkg.dir);
    throw new Error(
      `Workspace dependency cycle among: ${stuck.join(', ')}. ` +
        'A cycle has no publish order and no tsc --build order; break it in package.json.',
    );
  }

  return ordered;
}

/**
 * The directories of every non-private package, dependencies first.
 *
 * This is the publish order. `resolve-workspace-deps` pins every internal
 * dependency to an exact version before `npm publish`, so a package published
 * before one of its dependencies is uninstallable until that dependency lands —
 * which is why the order is derived from the runtime edges and never typed in.
 *
 * @param repoRoot - Absolute path of the monorepo root
 * @returns Directory names under `packages/`, in the order to publish them
 */
export function publishedPackagesInDependencyOrder(repoRoot: string): string[] {
  const graph = readWorkspaceGraph(repoRoot);
  const published = new Set(graph.packages.filter((pkg) => !pkg.isPrivate).map((pkg) => pkg.dir));
  return topologicalOrder(graph, { subset: published }).map((pkg) => pkg.dir);
}

/**
 * Whether a package takes part in the TypeScript project-references build:
 * it has a `tsconfig.json` and a `build` script. The umbrella package has a
 * tsconfig and nothing to compile, and a fixture directory may have neither.
 */
export function isTypeScriptProject(pkg: WorkspacePackage, repoRoot: string): boolean {
  const scripts = pkg.manifest['scripts'];
  const hasBuild =
    typeof scripts === 'object' && scripts !== null && typeof (scripts as Record<string, unknown>)['build'] === 'string';
  return hasBuild && existsSync(safePath.join(repoRoot, 'packages', pkg.dir, 'tsconfig.json'));
}
