/**
 * The workspace graph is the single owner of "what depends on what"; every
 * derived list (tsconfig references, publish order, postinstall links) reads it.
 * These cases pin the reading rules and the ordering guarantees on fixture
 * trees, and one case pins the REAL tree's order against the two defects that
 * motivated the module.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import {
  isTypeScriptProject,
  publishedPackagesInDependencyOrder,
  readWorkspaceGraph,
  topologicalOrder,
  workspaceDependenciesOf,
} from '../src/workspace-graph.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

const SCOPE = '@scope';
const WORKSPACE_STAR = 'workspace:*';

interface FixturePackage {
  dir: string;
  name?: string;
  isPrivate?: boolean;
  deps?: string[];
  devDeps?: string[];
  peerDeps?: string[];
  optionalDeps?: string[];
  scripts?: Record<string, string>;
  tsconfig?: boolean;
  rawManifest?: string;
}

function workspaceBlock(names: string[] | undefined): Record<string, string> | undefined {
  if (names === undefined) return undefined;
  return Object.fromEntries(names.map((name) => [`${SCOPE}/${name}`, WORKSPACE_STAR]));
}

/** Write a `packages/` tree under `root` from a compact description. */
function writeFixtureTree(root: string, packages: FixturePackage[]): void {
  for (const pkg of packages) {
    const dir = safePath.join(root, 'packages', pkg.dir);
    // eslint-disable-next-line local/no-fs-mkdirSync -- fixture path is a temp dir; realpath is not read back
    mkdirSync(dir, { recursive: true });
    const manifest =
      pkg.rawManifest ??
      JSON.stringify({
        name: pkg.name ?? `${SCOPE}/${pkg.dir}`,
        version: '0.0.0',
        ...(pkg.isPrivate ? { private: true } : {}),
        ...(pkg.scripts ? { scripts: pkg.scripts } : {}),
        dependencies: workspaceBlock(pkg.deps),
        devDependencies: workspaceBlock(pkg.devDeps),
        peerDependencies: workspaceBlock(pkg.peerDeps),
        optionalDependencies: workspaceBlock(pkg.optionalDeps),
      });
    writeFileSync(safePath.join(dir, 'package.json'), manifest);
    if (pkg.tsconfig) writeFileSync(safePath.join(dir, 'tsconfig.json'), '{}');
  }
}

describe('readWorkspaceGraph', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir({ prefix: 'workspace-graph-' });
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('reads every package directory, sorted, and skips directories with no manifest', () => {
    writeFixtureTree(root, [{ dir: 'b' }, { dir: 'a' }]);
    // eslint-disable-next-line local/no-fs-mkdirSync -- fixture path is a temp dir; realpath is not read back
    mkdirSync(safePath.join(root, 'packages', 'scratch'));

    const graph = readWorkspaceGraph(root);

    expect(graph.packages.map((pkg) => pkg.dir)).toEqual(['a', 'b']);
    expect(graph.byName.get(`${SCOPE}/a`)?.dir).toBe('a');
  });

  it('splits workspace dependencies by kind and ignores non-workspace specifiers', () => {
    writeFixtureTree(root, [
      { dir: 'core' },
      { dir: 'peer' },
      { dir: 'opt' },
      { dir: 'tooling' },
      { dir: 'app', deps: ['core'], peerDeps: ['peer'], optionalDeps: ['opt'], devDeps: ['tooling'] },
    ]);
    const external = safePath.join(root, 'packages', 'app', 'package.json');
    const manifest = JSON.parse(readFileSync(external, 'utf8')) as Record<string, Record<string, string>>;
    manifest['dependencies'] = { ...manifest['dependencies'], lodash: '^4.0.0' };
    writeFileSync(external, JSON.stringify(manifest));

    const app = readWorkspaceGraph(root).byName.get(`${SCOPE}/app`);

    expect(app?.workspaceDeps.runtime).toEqual([`${SCOPE}/core`, `${SCOPE}/opt`, `${SCOPE}/peer`]);
    expect(app?.workspaceDeps.dev).toEqual([`${SCOPE}/tooling`]);
  });

  it('throws on a manifest that is present but not JSON, naming the file', () => {
    writeFixtureTree(root, [{ dir: 'ok' }, { dir: 'broken', rawManifest: '{ not json' }]);

    expect(() => readWorkspaceGraph(root)).toThrow(/packages\/broken\/package\.json is not valid JSON/);
  });

  it('throws on a nameless manifest', () => {
    writeFixtureTree(root, [{ dir: 'anon', rawManifest: '{"version":"1.0.0"}' }]);

    expect(() => readWorkspaceGraph(root)).toThrow(/declares no "name"/);
  });

  it('throws when two directories declare one name', () => {
    writeFixtureTree(root, [{ dir: 'one', name: '@scope/same' }, { dir: 'two', name: '@scope/same' }]);

    expect(() => readWorkspaceGraph(root)).toThrow(/packages\/one and packages\/two both declare/);
  });

  it('models a TypeScript project as "has a build script AND a tsconfig"', () => {
    writeFixtureTree(root, [
      { dir: 'lib', scripts: { build: 'tsc' }, tsconfig: true },
      { dir: 'umbrella', tsconfig: true },
      { dir: 'scripts-only', scripts: { build: 'tsc' } },
    ]);
    const graph = readWorkspaceGraph(root);

    const projects = graph.packages.filter((pkg) => isTypeScriptProject(pkg, root)).map((pkg) => pkg.dir);

    expect(projects).toEqual(['lib']);
  });
});

describe('topologicalOrder', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir({ prefix: 'workspace-order-' });
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('puts every dependency before its dependents and breaks ties alphabetically', () => {
    writeFixtureTree(root, [
      { dir: 'z-leaf' },
      { dir: 'a-leaf' },
      { dir: 'mid', deps: ['z-leaf'] },
      { dir: 'top', deps: ['mid', 'a-leaf'] },
    ]);

    const order = topologicalOrder(readWorkspaceGraph(root)).map((pkg) => pkg.dir);

    expect(order).toEqual(['a-leaf', 'z-leaf', 'mid', 'top']);
  });

  it('counts only runtime edges by default, so a dev-only dependency does not order', () => {
    writeFixtureTree(root, [{ dir: 'b-tool' }, { dir: 'a-lib', devDeps: ['b-tool'] }]);
    const graph = readWorkspaceGraph(root);

    expect(topologicalOrder(graph).map((pkg) => pkg.dir)).toEqual(['a-lib', 'b-tool']);
    expect(topologicalOrder(graph, { kinds: ['runtime', 'dev'] }).map((pkg) => pkg.dir)).toEqual(['b-tool', 'a-lib']);
  });

  it('restricts to a subset and ignores edges that leave it', () => {
    writeFixtureTree(root, [{ dir: 'private-dep', isPrivate: true }, { dir: 'pub', deps: ['private-dep'] }]);
    const graph = readWorkspaceGraph(root);

    const order = topologicalOrder(graph, { subset: new Set(['pub']) }).map((pkg) => pkg.dir);

    expect(order).toEqual(['pub']);
  });

  it('throws on a cycle, naming every member, rather than returning a partial order', () => {
    writeFixtureTree(root, [{ dir: 'ok' }, { dir: 'x', deps: ['y'] }, { dir: 'y', deps: ['x'] }]);

    expect(() => topologicalOrder(readWorkspaceGraph(root))).toThrow(/cycle among: x, y/);
  });

  it('exposes each package\'s resolved workspace dependencies, sorted by directory', () => {
    writeFixtureTree(root, [{ dir: 'q' }, { dir: 'p' }, { dir: 'app', deps: ['q', 'p'] }]);
    const graph = readWorkspaceGraph(root);
    const app = graph.byName.get(`${SCOPE}/app`);
    if (app === undefined) throw new Error('fixture missing app');

    expect(workspaceDependenciesOf(app, graph).map((dep) => dep.dir)).toEqual(['p', 'q']);
  });
});

describe('publishedPackagesInDependencyOrder on the real tree', () => {
  const order = publishedPackagesInDependencyOrder(PROJECT_ROOT);
  const graph = readWorkspaceGraph(PROJECT_ROOT);

  it('lists exactly the non-private packages', () => {
    const expected = graph.packages.filter((pkg) => !pkg.isPrivate).map((pkg) => pkg.dir).sort((a, b) => a.localeCompare(b));
    expect([...order].sort((a, b) => a.localeCompare(b))).toEqual(expected);
  });

  it('never publishes a package before a runtime dependency', () => {
    // The two defects the hand list carried: runtime-claude-agent-sdk before
    // claude-marketplace, and cli before gateway-mcp. Asserted as the general
    // property, so the next reordering is caught wherever it lands.
    const position = new Map(order.map((dir, index) => [dir, index] as const));
    const violations: string[] = [];
    for (const dir of order) {
      const pkg = graph.packages.find((candidate) => candidate.dir === dir);
      if (pkg === undefined) continue;
      for (const dep of workspaceDependenciesOf(pkg, graph, ['runtime'])) {
        if (!position.has(dep.dir)) continue;
        if ((position.get(dep.dir) ?? 0) > (position.get(dir) ?? 0)) violations.push(`${dir} before ${dep.dir}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('ends with the umbrella package, which depends on the CLI', () => {
    expect(order.at(-1)).toBe('vibe-agent-toolkit');
  });
});
