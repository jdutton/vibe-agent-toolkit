/**
 * The workspace link table: the `node_modules` entries an isolated install of a root's workspace
 * presents, as pure data computed from the `workspace_packages` and `workspace_dependencies` rows.
 *
 * One rule, location-based: a link exists at `<D>/node_modules/<name>` when `D` is the
 * directory of a workspace manifest (a `workspace_packages` row, the root included) that declares
 * `<name>` in any dependency field with a non-null `targetPath`; its target is the directory of that
 * `targetPath`. The key is the dependency's key, so an `npm:` alias links under the alias. A member
 * never links to itself unless it declares itself, and a manifest that is not a member has no links.
 *
 * Links never cross analysis roots: the rows are one root's, and a root whose workspace step refused
 * has none, so the table is empty. A path below a link that itself names `node_modules` is not a link
 * (answers name the member's git-content path, never a `node_modules` spelling).
 *
 * The table is plain data (structured-clone safe) so the worker's tsconfig host and the main
 * thread's resolution host read one table.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';

import type { WorkspaceDependencyRow, WorkspacePackageRow } from '../schemas/projection-workspace.js';

const NODE_MODULES = 'node_modules';
const NESTED_NODE_MODULES = /(?:^|\/)node_modules(?:\/|$)/;

/** One link: `path` is `<D>/node_modules/<name>`; `target` is the member's directory. */
export interface WorkspaceLink {
  readonly path: string;
  readonly target: string;
  /** The `<D>/node_modules` directory holding the link. */
  readonly nodeModules: string;
  /** The `@scope` directory name when the dependency is scoped. */
  readonly scope?: string;
  /** The last segment of the link path. */
  readonly name: string;
}

export interface WorkspaceLinkTable {
  readonly ignoreCase: boolean;
  /** Keyed by the (case-folded when `ignoreCase`) link path. */
  readonly links: Readonly<Record<string, WorkspaceLink>>;
}

/** The table of a root with no links: no workspace, or one whose workspace step refused. */
export const NO_WORKSPACE_LINKS: WorkspaceLinkTable = Object.freeze({ ignoreCase: false, links: Object.freeze({}) });

function fold(table: WorkspaceLinkTable, path: string): string {
  return table.ignoreCase ? path.toLowerCase() : path;
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

function joinDir(dir: string, rest: string): string {
  return dir === '.' ? rest : `${dir}/${rest}`;
}

function linkOf(dir: string, name: string, target: string): WorkspaceLink {
  const nodeModules = joinDir(dir, NODE_MODULES);
  const slash = name.indexOf('/');
  const scoped = name.startsWith('@') && slash > 0;
  return {
    path: `${nodeModules}/${name}`,
    target,
    nodeModules,
    ...(scoped ? { scope: name.slice(0, slash) } : {}),
    name: scoped ? name.slice(slash + 1) : name,
  };
}

/** Build one root's link table. */
export function workspaceLinks(
  packages: readonly WorkspacePackageRow[],
  dependencies: readonly WorkspaceDependencyRow[],
  ignoreCase: boolean,
): WorkspaceLinkTable {
  const dirOfManifest = new Map<string, string>();
  for (const row of packages) dirOfManifest.set(row.path, row.dir);
  const links: Record<string, WorkspaceLink> = {};
  const table: WorkspaceLinkTable = { ignoreCase, links };
  for (const row of dependencies) {
    const dir = dirOfManifest.get(row.path);
    if (dir === undefined || row.targetPath === null) continue;
    const link = linkOf(dir, row.name, dirnameOf(row.targetPath));
    links[fold(table, link.path)] = link;
  }
  return table;
}

/**
 * The target-side path for a path through a link (`<D>/node_modules/n/src/x.ts` to
 * `<target>/src/x.ts`), or undefined when the path is not through a link. The link itself maps to
 * its target directory; a `node_modules` segment below the link voids it.
 */
export function linkedPath(table: WorkspaceLinkTable, path: string): string | undefined {
  let end = path.indexOf('/');
  while (end !== -1) {
    const link = Object.hasOwn(table.links, fold(table, path.slice(0, end))) ? table.links[fold(table, path.slice(0, end))] : undefined;
    if (link) return throughLink(link, path.slice(end + 1));
    end = path.indexOf('/', end + 1);
  }
  const whole = fold(table, path);
  return Object.hasOwn(table.links, whole) ? table.links[whole]?.target : undefined;
}

function throughLink(link: WorkspaceLink, rest: string): string | undefined {
  if (NESTED_NODE_MODULES.test(rest)) return undefined;
  return link.target === '.' ? rest : `${link.target}/${rest}`;
}

/**
 * The entry names links create directly under `dir`: the link names under a `<D>/node_modules`
 * (an `@scope` directory counted once) and the scoped names under `<D>/node_modules/@scope`.
 * Sorted, spelled as declared; empty when `dir` holds no link directory.
 */
export function linkDirectoriesUnder(table: WorkspaceLinkTable, dir: string): string[] {
  const wanted = fold(table, dir);
  const names = new Set<string>();
  for (const link of Object.values(table.links)) {
    if (link.scope === undefined) {
      if (fold(table, link.nodeModules) === wanted) names.add(link.name);
    } else if (fold(table, link.nodeModules) === wanted) {
      names.add(link.scope);
    } else if (fold(table, `${link.nodeModules}/${link.scope}`) === wanted) {
      names.add(link.name);
    }
  }
  return [...names].sort(compareCodeUnits);
}

/**
 * The same links keyed under another case rule: the job's host folds by TypeScript's own platform
 * rule, which the main thread that built the table cannot ask. Two links differing only in case
 * collapse to one under `ignoreCase`, as they would on such a file system.
 *
 * @param table - A link table
 * @param ignoreCase - The case rule to key it by
 * @returns `table` itself when it is already keyed so, else a re-keyed copy
 */
export function withCaseRule(table: WorkspaceLinkTable, ignoreCase: boolean): WorkspaceLinkTable {
  if (table.ignoreCase === ignoreCase) return table;
  const links: Record<string, WorkspaceLink> = {};
  const keyed: WorkspaceLinkTable = { ignoreCase, links };
  for (const link of Object.values(table.links)) links[fold(keyed, link.path)] = link;
  return keyed;
}

