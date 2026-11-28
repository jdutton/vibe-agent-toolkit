import { describe, expect, it } from 'vitest';

import { linkDirectoriesUnder, linkedPath, withCaseRule, workspaceLinks } from '../src/projection/workspace-links.js';
import type { WorkspaceDependencyRow, WorkspacePackageRow } from '../src/schemas/projection-workspace.js';

function pkg(dir: string, name: string | null = null): WorkspacePackageRow {
  return { root: 'r', path: dir === '.' ? 'package.json' : `${dir}/package.json`, dir, name, version: null, private: null, workspaceRoot: dir === '.' };
}

function dep(from: string, name: string, target: string | null, field = 'dependencies'): WorkspaceDependencyRow {
  return {
    root: 'r',
    path: from === '.' ? 'package.json' : `${from}/package.json`,
    field,
    name,
    range: 'workspace:*',
    targetPath: target === null ? null : `${target}/package.json`,
    protocol: 'workspace',
  };
}

const PACKAGES = [pkg('.'), pkg('packages/a', '@acme/a'), pkg('packages/b', 'b-lib'), pkg('packages/c', 'c')];

describe('workspaceLinks', () => {
  it('links a member-declared member at the declaring directory', () => {
    const table = workspaceLinks(PACKAGES, [dep('packages/a', 'b-lib', 'packages/b')], false);
    expect(linkedPath(table, 'packages/a/node_modules/b-lib/src/x.ts')).toBe('packages/b/src/x.ts');
    expect(linkedPath(table, 'packages/a/node_modules/b-lib')).toBe('packages/b');
    // location-based: a manifest that does not declare it has no link
    expect(linkedPath(table, 'packages/c/node_modules/b-lib/src/x.ts')).toBeUndefined();
    expect(linkedPath(table, 'node_modules/b-lib/src/x.ts')).toBeUndefined();
  });

  it('links a root-declared member at the root, visible from every member by ancestry', () => {
    const table = workspaceLinks(PACKAGES, [dep('.', 'b-lib', 'packages/b', 'devDependencies')], false);
    expect(linkedPath(table, 'node_modules/b-lib/index.ts')).toBe('packages/b/index.ts');
    expect(linkDirectoriesUnder(table, 'node_modules')).toEqual(['b-lib']);
  });

  it('names the link by the dependency key for an npm: alias', () => {
    const table = workspaceLinks(PACKAGES, [dep('packages/a', 'alias', 'packages/b')], false);
    expect(linkedPath(table, 'packages/a/node_modules/alias/x.ts')).toBe('packages/b/x.ts');
    expect(linkedPath(table, 'packages/a/node_modules/b-lib/x.ts')).toBeUndefined();
  });

  it('makes the @scope directory only for the scope that has a link', () => {
    const table = workspaceLinks(PACKAGES, [dep('packages/b', '@acme/a', 'packages/a')], false);
    expect(linkedPath(table, 'packages/b/node_modules/@acme/a/x.ts')).toBe('packages/a/x.ts');
    expect(linkDirectoriesUnder(table, 'packages/b/node_modules')).toEqual(['@acme']);
    expect(linkDirectoriesUnder(table, 'packages/b/node_modules/@acme')).toEqual(['a']);
    expect(linkDirectoriesUnder(table, 'packages/b/node_modules/@other')).toEqual([]);
    expect(linkedPath(table, 'packages/b/node_modules/@acme')).toBeUndefined();
    expect(linkedPath(table, 'packages/b/node_modules/@other/a/x.ts')).toBeUndefined();
  });

  it('makes no link for a dependency with a null targetPath', () => {
    const table = workspaceLinks(PACKAGES, [dep('packages/a', 'b-lib', null)], false);
    expect(linkDirectoriesUnder(table, 'packages/a/node_modules')).toEqual([]);
    expect(linkedPath(table, 'packages/a/node_modules/b-lib/x.ts')).toBeUndefined();
  });

  it('makes links only at workspace-manifest directories', () => {
    const table = workspaceLinks(PACKAGES, [dep('packages/a/sub', 'b-lib', 'packages/b')], false);
    expect(linkDirectoriesUnder(table, 'packages/a/sub/node_modules')).toEqual([]);
    expect(linkedPath(table, 'packages/a/sub/node_modules/b-lib/x.ts')).toBeUndefined();
  });

  it('never links a member to itself unless it declares itself', () => {
    expect(linkedPath(workspaceLinks(PACKAGES, [], false), 'packages/a/node_modules/@acme/a/x.ts')).toBeUndefined();
    const self = workspaceLinks(PACKAGES, [dep('packages/a', '@acme/a', 'packages/a')], false);
    expect(linkedPath(self, 'packages/a/node_modules/@acme/a/x.ts')).toBe('packages/a/x.ts');
  });

  it('maps a link to the root member as `.`', () => {
    const table = workspaceLinks(PACKAGES, [dep('packages/a', 'rootpkg', '.')], false);
    expect(linkedPath(table, 'packages/a/node_modules/rootpkg')).toBe('.');
    expect(linkedPath(table, 'packages/a/node_modules/rootpkg/x.ts')).toBe('x.ts');
  });

  it('treats a node_modules below a link as not a link', () => {
    const table = workspaceLinks(PACKAGES, [dep('packages/a', 'b-lib', 'packages/b')], false);
    expect(linkedPath(table, 'packages/a/node_modules/b-lib/node_modules/m/x.ts')).toBeUndefined();
  });

  it('is case-insensitive only when asked', () => {
    const deps = [dep('packages/a', 'b-lib', 'packages/b')];
    expect(linkedPath(workspaceLinks(PACKAGES, deps, false), 'Packages/A/Node_Modules/B-Lib/x.ts')).toBeUndefined();
    const folded = workspaceLinks(PACKAGES, deps, true);
    expect(linkedPath(folded, 'Packages/A/Node_Modules/B-Lib/x.ts')).toBe('packages/b/x.ts');
    expect(linkDirectoriesUnder(folded, 'PACKAGES/a/node_modules')).toEqual(['b-lib']);
  });

  it('is structured-clone safe plain data', () => {
    const table = workspaceLinks(PACKAGES, [dep('packages/a', 'b-lib', 'packages/b')], false);
    expect(structuredClone(table)).toEqual(table);
  });
});

describe('withCaseRule', () => {
  it('re-keys a table under another case rule, and returns one already keyed so unchanged', () => {
    const exact = workspaceLinks(PACKAGES, [dep('packages/a', 'b-lib', 'packages/b')], false);
    expect(linkedPath(exact, 'Packages/A/node_modules/b-lib/x.ts')).toBeUndefined();
    const folded = withCaseRule(exact, true);
    expect(linkedPath(folded, 'Packages/A/node_modules/B-Lib/x.ts')).toBe('packages/b/x.ts');
    expect(withCaseRule(folded, true)).toBe(folded);
    expect(linkedPath(withCaseRule(folded, false), 'Packages/A/node_modules/b-lib/x.ts')).toBeUndefined();
  });
});

