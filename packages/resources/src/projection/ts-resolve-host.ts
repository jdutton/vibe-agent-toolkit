/**
 * The resolution host: the `ModuleResolutionHost` the resolve step
 * hands TypeScript's `resolveModuleName`. It is a **virtual isolated install**: the tree an isolated
 * (pnpm) install would present, built from the root's git content, its workspace link table, the
 * output map's keys and the served `package.json` texts, with nothing third-party in it. Nothing
 * reads disk, and every answer is synchronous, because TypeScript's resolution is.
 *
 * - `fileExists(p)`: `p`, mapped through a link, is git content or an output-map key.
 * - `directoryExists(d)`: a git-content file or an output-map key lies beneath `d` (mapped through a
 *   link); or `d` is `<D>/node_modules` with a link, or `<D>/node_modules/@scope` with a link
 *   `@scope/...`. Without the output-map clause TypeScript's `directoryProbablyExists` fails before it
 *   asks `fileExists`; without the `node_modules` clauses
 *   `loadModuleFromImmediateNodeModulesDirectory` records only failures.
 * - `readFile(p)`: only a git-content `package.json`, mapped through a link, served by the caller.
 * - `realpath(p)`: through a link, as the symlink would; identity otherwise.
 * - Nothing else under any `node_modules` exists, and a `node_modules` below a link is not a link.
 *
 * One host serves every owning manifest of a root: the link table is location-based, and
 * TypeScript walks only a containing file's ancestors. The caches are the step's, per
 * `(config, owning manifest)`.
 *
 * Case folding is `toLowerCase()`, the fold the output map uses.
 */

import { compareCodeUnits, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type ts from '../vendor/typescript.cjs';

import type { RunOutputMap } from './ts-output-map.js';
import { linkDirectoriesUnder, linkedPath, withCaseRule, type WorkspaceLinkTable } from './workspace-links.js';

const NODE_MODULES = 'node_modules';
const PACKAGE_JSON = 'package.json';
const NODE_MODULES_SEGMENT = /(?:^|\/)node_modules(?:\/|$)/;

/** What the host is built from. */
export interface ResolveHostInput {
  /** The analysis root, absolute, as TypeScript spells the paths it asks about. */
  readonly root: string;
  /** The root's git content, root-relative. */
  readonly listing: readonly string[];
  /** The root's workspace link table (empty when the workspace step refused). */
  readonly links: WorkspaceLinkTable;
  /** The run's output map over its emitting demanded configs. */
  readonly outputs: RunOutputMap;
  /** A git-content `package.json`'s text by its listed root-relative path, from held `json` rows. */
  readonly packageJsonText: (path: string) => string | undefined;
  readonly useCaseSensitiveFileNames: boolean;
}

/** The host: TypeScript's members, plus the canonical git-content path of an answer. */
export interface ResolveHost extends ts.ModuleResolutionHost {
  readonly useCaseSensitiveFileNames: boolean;
  directoryExists(directoryName: string): boolean;
  realpath(path: string): string;
  getDirectories(path: string): string[];
  getCurrentDirectory(): string;
  /**
   * @param path - An absolute path TypeScript answered, possibly spelled through a link
   * @returns Its listed root-relative git-content spelling, or undefined when it is not git content
   */
  contentPath(path: string): string | undefined;
}

/** Where a path asked about lands in the virtual tree. */
type Place =
  /** A real (non-`node_modules`) location, absolute; `linked` when reached through a link. */
  | { readonly kind: 'tree'; readonly path: string; readonly linked: boolean }
  /** At or under a `<D>/node_modules` that is not a link: only link directories exist there. */
  | { readonly kind: 'nodeModules'; readonly relative: string };

function withoutTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

function parentOf(path: string): string | undefined {
  const slash = path.lastIndexOf('/');
  return slash <= 0 || slash === path.indexOf('/') ? undefined : path.slice(0, slash);
}

/** The directory index: each directory (folded, absolute) to its subdirectory names. */
class DirectoryIndex {
  readonly #fold: (path: string) => string;
  readonly #children = new Map<string, Set<string>>();

  constructor(fold: (path: string) => string) {
    this.#fold = fold;
  }

  /** Record every ancestor directory of the absolute file `path`. */
  addFile(path: string): void {
    let child = path;
    let parent = parentOf(child);
    while (parent !== undefined) {
      const key = this.#fold(parent);
      const known = this.#children.get(key);
      if (child !== path) {
        const name = child.slice(parent.length + 1);
        if (known?.has(name)) return;
        (known ?? this.#set(key)).add(name);
      } else if (known === undefined) {
        this.#set(key);
      }
      child = parent;
      parent = parentOf(child);
    }
  }

  #set(key: string): Set<string> {
    const names = new Set<string>();
    this.#children.set(key, names);
    return names;
  }

  has(path: string): boolean {
    return this.#children.has(this.#fold(path));
  }

  children(path: string): readonly string[] {
    return [...(this.#children.get(this.#fold(path)) ?? [])];
  }
}

/**
 * Build the host for one root.
 *
 * @param input - The root's listing, links, output map and served `package.json` texts
 * @returns The host
 */
export function resolveHost(input: ResolveHostInput): ResolveHost {
  const caseSensitive = input.useCaseSensitiveFileNames;
  const fold = (path: string): string => (caseSensitive ? path : path.toLowerCase());
  const root = withoutTrailingSlash(toForwardSlash(input.root));
  const rootKey = fold(root);
  const links = withCaseRule(input.links, !caseSensitive);
  const files = new Map<string, string>();
  const directories = new DirectoryIndex(fold);
  for (const listed of input.listing) {
    const path = `${root}/${toForwardSlash(listed)}`;
    files.set(fold(path), listed);
    directories.addFile(path);
  }
  for (const output of input.outputs.outputs()) directories.addFile(output);
  const linkHomes = new Set(Object.values(links.links).map((link) => fold(link.nodeModules)));

  const absolute = (relative: string): string => (relative === '.' || relative === '' ? root : `${root}/${relative}`);
  const relativeOf = (path: string): string | undefined => {
    const key = fold(path);
    if (key === rootKey) return '.';
    return key.startsWith(`${rootKey}/`) ? path.slice(root.length + 1) : undefined;
  };
  const place = (asked: string): Place => {
    const path = toForwardSlash(asked);
    const relative = relativeOf(path);
    if (relative === undefined) return { kind: 'tree', path, linked: false };
    const mapped = linkedPath(links, relative);
    if (mapped !== undefined) return { kind: 'tree', path: absolute(mapped), linked: true };
    if (NODE_MODULES_SEGMENT.test(relative)) return { kind: 'nodeModules', relative };
    return { kind: 'tree', path, linked: false };
  };
  const nodeModulesHere = (at: Place & { kind: 'tree' }): boolean => {
    if (at.linked) return false;
    const relative = relativeOf(at.path);
    return relative !== undefined && linkHomes.has(fold(relative === '.' ? NODE_MODULES : `${relative}/${NODE_MODULES}`));
  };
  const contentPath = (asked: string): string | undefined => {
    const at = place(asked);
    return at.kind === 'tree' ? files.get(fold(at.path)) : undefined;
  };

  return {
    useCaseSensitiveFileNames: caseSensitive,
    getCurrentDirectory: () => root,
    contentPath,
    fileExists: (asked) => {
      const at = place(asked);
      return at.kind === 'tree' && (files.has(fold(at.path)) || input.outputs.has(at.path));
    },
    directoryExists: (asked) => {
      const at = place(asked);
      if (at.kind === 'nodeModules') return linkDirectoriesUnder(links, at.relative).length > 0;
      return directories.has(at.path) || nodeModulesHere(at);
    },
    readFile: (asked) => {
      const listed = contentPath(asked);
      if (listed === undefined || (listed !== PACKAGE_JSON && !listed.endsWith(`/${PACKAGE_JSON}`))) return undefined;
      return input.packageJsonText(listed);
    },
    realpath: (asked) => {
      const at = place(asked);
      return at.kind === 'tree' && at.linked ? at.path : asked;
    },
    getDirectories: (asked) => {
      const at = place(asked);
      if (at.kind === 'nodeModules') return linkDirectoriesUnder(links, at.relative);
      const names = [...directories.children(at.path)];
      if (nodeModulesHere(at)) names.push(NODE_MODULES);
      return names.sort(compareCodeUnits);
    },
  };
}
