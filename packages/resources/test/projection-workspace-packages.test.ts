/**
 * The workspace resolve step (`workspace-packages.ts`) through the data stage it runs in: membership
 * per manager, linking per manager, catalogs, the pnpm-workspace.yaml consumer rules, defective
 * inputs, the outside-root refusal and `DATA_REQUEST_UNROUTED`. Store off unless an arm says so;
 * the store-on arms answer the same.
 */

import { describe, expect, it } from 'vitest';

import { NO_DATA_STAGE_SEAMS, type DataDemand, type DataStageResult, type DataStageSeams } from '../src/projection/data-stage.js';
import { isStoredRowsEvicted } from '../src/projection/query-projection.js';
import { dataRoutingFor } from '../src/projection/router.js';
import { runStoredReads } from '../src/projection/stored-reads.js';

import { FakeFactStore, WIDE_STORE_BUDGETS } from './fake-fact-store.js';
import { stage, staged, type Realized } from './helpers/data-stage-fixture.js';

const WORKSPACE: DataDemand = { tables: [], routes: false, values: false, workspace: true };
const ROOT_ID = 'root-1';
const ROOT_PKG = 'package.json';
const A = 'packages/a/package.json';
const B = 'packages/b/package.json';
const YAML = 'pnpm-workspace.yaml';
const NPMRC = '.npmrc';

type Staged = Extract<DataStageResult, { outcome: 'staged' }>;
type Workspace = NonNullable<Staged['workspace']>;
type Answered = Extract<Workspace, { outcome: 'rows' }>;
type Refused = Extract<Workspace, { outcome: 'refused' }>;

/** @returns A realization holding `value` as JSON */
function json(path: string, value: unknown): Realized {
  return { path, text: `${JSON.stringify(value)}\n` };
}

/** @returns A realization holding `text` */
function text(path: string, body: string): Realized {
  return { path, text: body };
}

/** Run the stage with the workspace demanded and return its workspace answer. */
async function workspaceOf(files: readonly Realized[], options: Parameters<typeof stage>[1] = {}): Promise<Workspace> {
  const result = staged(await stage(files, { demand: WORKSPACE, ...options }));
  if (result.workspace === undefined) throw new Error('the workspace was demanded and not answered');
  return result.workspace;
}

/** @returns The answered rows, failing on a refusal */
async function answered(files: readonly Realized[], options: Parameters<typeof stage>[1] = {}): Promise<Answered> {
  const workspace = await workspaceOf(files, options);
  if (workspace.outcome !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(workspace)}`);
  return workspace;
}

/** @returns The refusal, failing on rows */
async function refused(files: readonly Realized[], options: Parameters<typeof stage>[1] = {}): Promise<Refused['refusal']> {
  const workspace = await workspaceOf(files, options);
  if (workspace.outcome !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(workspace)}`);
  return workspace.refusal;
}

/** @returns Each member's path, sorted */
function memberPaths(rows: Answered): string[] {
  return rows.packages.map((row) => row.path).toSorted((left, right) => left.localeCompare(right));
}

/** @returns The one dependency `name` of `path`'s `field` */
function dependency(rows: Answered, path: string, name: string, field = 'dependencies'): Answered['dependencies'][number] {
  const found = rows.dependencies.find((row) => row.path === path && row.name === name && row.field === field);
  if (found === undefined) throw new Error(`no dependency ${name} of ${path}`);
  return found;
}

/** Two members, `a` depending on `b` with `range`, under the root `root`. */
function twoMembers(root: Record<string, unknown>, range: string, extra: readonly Realized[] = []): Realized[] {
  return [
    json(ROOT_PKG, { name: 'root', ...root }),
    json(A, { name: 'a', version: '1.0.0', dependencies: { b: range, react: '^18.0.0' } }),
    json(B, { name: 'b', version: '1.2.0', private: true }),
    ...extra,
  ];
}

describe('workspace membership', () => {
  it('npm: package.json#workspaces names the members; the root is the workspace root', async () => {
    const rows = await answered(twoMembers({ packageManager: 'npm@10.8.0', workspaces: ['packages/*'] }, '^1.0.0', [json('other/c/package.json', { name: 'c' })]));
    expect(memberPaths(rows)).toEqual([ROOT_PKG, A, B]);
    expect(rows.packages.find((row) => row.path === ROOT_PKG)).toEqual({ root: ROOT_ID, path: ROOT_PKG, dir: '.', name: 'root', version: null, private: null, workspaceRoot: true });
    expect(rows.packages.find((row) => row.path === B)).toEqual({ root: ROOT_ID, path: B, dir: 'packages/b', name: 'b', version: '1.2.0', private: true, workspaceRoot: false });
    expect(rows.conditions).toEqual([]);
  });

  it('yarn: workspaces as { packages: [...] }', async () => {
    const rows = await answered(twoMembers({ packageManager: 'yarn@1.22.22', workspaces: { packages: ['packages/*'], nohoist: ['**/x'] } }, '^1.0.0'));
    expect(memberPaths(rows)).toEqual([ROOT_PKG, A, B]);
  });

  it('bun: package.json#workspaces, like npm', async () => {
    const rows = await answered(twoMembers({ packageManager: 'bun@1.3.9', workspaces: ['packages/*'] }, 'workspace:*'));
    expect(memberPaths(rows)).toEqual([ROOT_PKG, A, B]);
    expect(dependency(rows, A, 'b')).toMatchObject({ protocol: 'workspace', targetPath: B, range: 'workspace:*' });
  });

  it('no packageManager and no pnpm-workspace.yaml: the workspaces field', async () => {
    const rows = await answered(twoMembers({ workspaces: ['packages/a'] }, '^1.0.0'));
    expect(memberPaths(rows)).toEqual([ROOT_PKG, A]);
  });

  it('no packageManager and a pnpm-workspace.yaml: pnpm, the workspaces field ignored', async () => {
    const rows = await answered(twoMembers({ workspaces: ['packages/a'] }, '^1.0.0', [text(YAML, 'packages:\n  - packages/b\n')]));
    expect(memberPaths(rows)).toEqual([ROOT_PKG, B]);
  });

  it('packageManager npm beside a pnpm-workspace.yaml: the workspaces field, and the YAML is not read', async () => {
    // An excluded YAML would refuse if it were read.
    const routing = dataRoutingFor({ resources: { extractors: { data: { exclude: [YAML] } } } });
    const rows = await answered(twoMembers({ packageManager: 'npm@10.0.0', workspaces: ['packages/a'] }, '^1.0.0', [text(YAML, 'packages: [packages/b]\n')]), { routing });
    expect(memberPaths(rows)).toEqual([ROOT_PKG, A]);
  });

  it('pnpm: canonicalised patterns, negation, implicit ignores', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@9.0.0' }),
      text(YAML, 'packages:\n  - ./packages/*\n  - "!packages/skip"\n  - tools/../libs/*/\n  - "../outside/*"\n'),
      json(A, { name: 'a' }),
      json('packages/skip/package.json', { name: 'skip' }),
      json('libs/x/package.json', { name: 'x' }),
      json('libs/x/test/package.json', { name: 'x-test' }),
      json('tools/y/package.json', { name: 'y' }),
    ];
    expect(memberPaths(await answered(files))).toEqual(['libs/x/package.json', ROOT_PKG, A]);
  });

  it('pnpm: no packages key means every package.json, minus the implicit ignores', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@9.0.0' }),
      text(YAML, 'catalog:\n  react: ^18.0.0\n'),
      json(A, { name: 'a' }),
      json('deep/er/package.json', { name: 'deep' }),
      json('fixtures/tests/package.json', { name: 'fixture' }),
      json('bower_components/z/package.json', { name: 'z' }),
    ];
    expect(memberPaths(await answered(files))).toEqual(['deep/er/package.json', ROOT_PKG, A]);
  });

  it('a duplicated "name" in a member: no refusal, the last value is its name', async () => {
    const files = [json(ROOT_PKG, { name: 'root', workspaces: ['packages/*'] }), text(A, '{"name": "first", "name": "second"}\n')];
    const rows = await answered(files);
    expect(rows.packages.find((row) => row.path === A)?.name).toBe('second');
  });

  it('a root with no workspace declaration has no rows', async () => {
    const rows = await answered([json(ROOT_PKG, { name: 'solo', dependencies: { react: '^18.0.0' } })]);
    expect(rows).toMatchObject({ packages: [], dependencies: [], conditions: [] });
  });
});

describe('workspace dependencies', () => {
  const npmRoot = { packageManager: 'npm@10.0.0', workspaces: ['packages/*'] };

  it('npm: a plain range links a same-named member it satisfies; a registry package links nothing', async () => {
    const rows = await answered(twoMembers(npmRoot, '^1.0.0'));
    expect(dependency(rows, A, 'b')).toEqual({ root: ROOT_ID, path: A, field: 'dependencies', name: 'b', range: '^1.0.0', targetPath: B, protocol: 'npm' });
    expect(dependency(rows, A, 'react').targetPath).toBeNull();
  });

  it('npm: a plain range the member\'s version does not satisfy links nothing', async () => {
    expect(dependency(await answered(twoMembers(npmRoot, '^2.0.0')), A, 'b').targetPath).toBeNull();
  });

  it('workspace:* and workspace:<alias>@ link by name; link: and file: by directory', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', ...npmRoot }),
      json(A, { name: 'a', dependencies: { b: 'workspace:^', alias: 'workspace:b@*' }, devDependencies: { local: 'link:../b', vendored: 'file:../../vendor/v' } }),
      json(B, { name: 'b', version: '1.0.0' }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, A, 'b')).toMatchObject({ protocol: 'workspace', targetPath: B });
    expect(dependency(rows, A, 'alias')).toMatchObject({ protocol: 'workspace', targetPath: B });
    expect(dependency(rows, A, 'local', 'devDependencies')).toMatchObject({ protocol: 'link', targetPath: B });
    expect(dependency(rows, A, 'vendored', 'devDependencies')).toMatchObject({ protocol: 'file', targetPath: null });
  });

  it('pnpm: workspace:<relative path> links by directory', async () => {
    const files = twoMembers({ packageManager: 'pnpm@9.0.0' }, 'workspace:../b', [text(YAML, 'packages: ["packages/*"]\n')]);
    expect(dependency(await answered(files), A, 'b')).toMatchObject({ protocol: 'workspace', targetPath: B });
  });

  describe('pnpm: link-workspace-packages decides a plain range', () => {
    const pnpm = (yaml: string, npmrc?: string): Realized[] => twoMembers({ packageManager: 'pnpm@9.0.0' }, '^1.0.0', [
      text(YAML, `packages: ["packages/*"]\n${yaml}`),
      ...(npmrc === undefined ? [] : [text(NPMRC, npmrc)]),
    ]);
    const target = async (files: readonly Realized[]): Promise<string | null> => dependency(await answered(files), A, 'b').targetPath;

    it('off by default', async () => expect(await target(pnpm(''))).toBeNull());
    it('on in pnpm-workspace.yaml', async () => expect(await target(pnpm('link-workspace-packages: true\n'))).toBe(B));
    it('on in pnpm-workspace.yaml, camelCase', async () => expect(await target(pnpm('linkWorkspacePackages: deep\n'))).toBe(B));
    it('on in .npmrc', async () => expect(await target(pnpm('', 'link-workspace-packages=true\n'))).toBe(B));
    it('pnpm-workspace.yaml wins over .npmrc', async () => expect(await target(pnpm('link-workspace-packages: false\n', 'link-workspace-packages=true\n'))).toBeNull());
    it('${VAR} in .npmrc is stored literally and is not true', async () => expect(await target(pnpm('', 'link-workspace-packages=${LINK}\n'))).toBeNull());
  });

  it('pnpm: catalog: and catalog:<name> resolve their range from pnpm-workspace.yaml', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@9.0.0' }),
      text(YAML, 'packages: ["packages/*"]\ncatalog:\n  react: ^18.2.0\ncatalogs:\n  legacy:\n    react: ^16.14.0\n'),
      json(A, { name: 'a', dependencies: { react: 'catalog:' }, devDependencies: { react: 'catalog:legacy' }, peerDependencies: { vue: 'catalog:' } }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, A, 'react')).toMatchObject({ protocol: 'catalog', range: '^18.2.0', targetPath: null });
    expect(dependency(rows, A, 'react', 'devDependencies')).toMatchObject({ protocol: 'catalog', range: '^16.14.0' });
    expect(dependency(rows, A, 'vue', 'peerDependencies')).toMatchObject({ protocol: 'catalog', range: 'catalog:' });
    expect(rows.conditions).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_CATALOG_UNRESOLVED', seq: 0 })]);
  });

  describe('catalogs in the root package.json (bun)', () => {
    /** A root (bun unless `root` says otherwise) and member `a` depending on `react` with `range`. */
    const catalogRoot = (root: Record<string, unknown>, range: string): Realized[] => [
      json(ROOT_PKG, { name: 'root', packageManager: 'bun@1.3.9', workspaces: ['packages/*'], ...root }),
      json(A, { name: 'a', dependencies: { react: range } }),
    ];
    const react = async (files: readonly Realized[]): Promise<Answered['dependencies'][number]> => dependency(await answered(files), A, 'react');
    const unresolved = async (files: readonly Realized[]): Promise<string> => {
      const rows = await answered(files);
      expect(dependency(rows, A, 'react')).toMatchObject({ protocol: 'catalog', range: 'catalog:', targetPath: null });
      const [condition] = rows.conditions;
      expect(condition).toMatchObject({ path: A, code: 'WORKSPACE_CATALOG_UNRESOLVED' });
      expect(condition?.message).not.toContain('pnpm');
      return condition?.message ?? '';
    };

    it('workspaces.catalog answers catalog:', async () => {
      expect(await react(catalogRoot({ workspaces: { packages: ['packages/*'], catalog: { react: '^18.2.0' } } }, 'catalog:'))).toMatchObject({ protocol: 'catalog', range: '^18.2.0' });
    });

    it('workspaces.catalogs.<name> answers catalog:<name>', async () => {
      expect(await react(catalogRoot({ workspaces: { packages: ['packages/*'], catalogs: { legacy: { react: '^16.14.0' } } } }, 'catalog:legacy'))).toMatchObject({ protocol: 'catalog', range: '^16.14.0' });
    });

    it('a top-level catalog answers catalog:', async () => {
      expect(await react(catalogRoot({ catalog: { react: '^18.2.0' } }, 'catalog:'))).toMatchObject({ protocol: 'catalog', range: '^18.2.0' });
    });

    it('the workspaces form wins over the top-level form', async () => {
      const root = { workspaces: { packages: ['packages/*'], catalog: { react: '^18.2.0' } }, catalog: { react: '^17.0.0' } };
      expect(await react(catalogRoot(root, 'catalog:'))).toMatchObject({ range: '^18.2.0' });
    });

    it('no packageManager and no pnpm-workspace.yaml: the root package.json catalogs are read as bun reads them', async () => {
      expect(await react(catalogRoot({ packageManager: undefined, catalog: { react: '^18.2.0' } }, 'catalog:'))).toMatchObject({ range: '^18.2.0' });
    });

    it('a missing entry is WORKSPACE_CATALOG_UNRESOLVED naming bun', async () => {
      expect(await unresolved(catalogRoot({ catalog: { vue: '^3.0.0' } }, 'catalog:'))).toContain('bun');
    });

    it('npm defines no catalogs: unresolved, naming npm', async () => {
      expect(await unresolved(catalogRoot({ packageManager: 'npm@10.8.0', catalog: { react: '^18.2.0' } }, 'catalog:'))).toContain('npm');
    });
  });
});

describe('defective inputs', () => {
  it('a defective member keeps its row, with nulls and a WORKSPACE_MEMBER_NO_ROWS condition; a name it may carry is unknown', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', workspaces: ['packages/*'] }),
      json(A, { name: 'a', dependencies: { missing: 'workspace:*', b: 'workspace:*' } }),
      text(B, '{'),
    ];
    const rows = await answered(files);
    expect(rows.packages.find((row) => row.path === B)).toEqual({ root: ROOT_ID, path: B, dir: 'packages/b', name: null, version: null, private: null, workspaceRoot: false });
    expect(rows.dependencies.filter((row) => row.path === B)).toEqual([]);
    expect(dependency(rows, A, 'missing').targetPath).toBeNull();
    expect(rows.conditions.map(({ path, code }) => [path, code])).toEqual([
      [A, 'WORKSPACE_TARGET_UNKNOWN'],
      [A, 'WORKSPACE_TARGET_UNKNOWN'],
      [B, 'WORKSPACE_MEMBER_NO_ROWS'],
    ]);
    expect(rows.conditions.find((row) => row.code === 'WORKSPACE_MEMBER_NO_ROWS')?.message).toContain('DATA_PARSE_ERROR');
  });

  it('a defective root package.json refuses the family, naming the file and its code', async () => {
    const refusal = await refused([text(ROOT_PKG, '{'), json(A, { name: 'a' })]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_ROOT_NO_ROWS', path: ROOT_PKG });
    expect(refusal.message).toContain('DATA_PARSE_ERROR');
  });

  it('a defective pnpm-workspace.yaml refuses the family', async () => {
    const refusal = await refused([json(ROOT_PKG, { packageManager: 'pnpm@9.0.0' }), text(YAML, 'packages: [\n')]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_ROOT_NO_ROWS', path: YAML });
  });
});

describe('pnpm-workspace.yaml consumer rules', () => {
  const root = json(ROOT_PKG, { packageManager: 'pnpm@9.0.0' });

  it('a duplicated read key refuses WORKSPACE_DUPLICATE_KEY, naming the key and its lines', async () => {
    const refusal = await refused([root, text(YAML, 'packages:\n  - a/*\npackages:\n  - b/*\n')]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_DUPLICATE_KEY', path: YAML });
    expect(refusal.message).toContain('/packages');
    expect(refusal.message).toContain('lines 1 and 3');
  });

  it('a duplicated key beneath a read key refuses too', async () => {
    const refusal = await refused([root, text(YAML, 'catalog:\n  react: ^18.0.0\n  react: ^17.0.0\n')]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_DUPLICATE_KEY' });
    expect(refusal.message).toContain('/catalog/react');
  });

  it('a duplicated key the step does not read does not refuse', async () => {
    expect((await answered([root, text(YAML, 'packages: [a/*]\nonlyBuiltDependencies: [x]\nonlyBuiltDependencies: [y]\n')])).packages).toHaveLength(1);
  });

  it('a read key reached through << refuses WORKSPACE_MERGE_KEY', async () => {
    const refusal = await refused([root, text(YAML, 'base: &base\n  react: ^18.0.0\ncatalog:\n  <<: *base\n')]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_MERGE_KEY', path: YAML });
  });
});

describe('workspace refusals from the run', () => {
  it('a package.json declaring workspace: while the analysis root declares no workspace refuses WORKSPACE_ROOT_OUTSIDE_ROOT', async () => {
    const refusal = await refused([json(ROOT_PKG, { name: 'solo' }), json(A, { name: 'a', dependencies: { b: 'workspace:*' } })]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_ROOT_OUTSIDE_ROOT', path: A });
  });

  it('with no root package.json at all, too', async () => {
    const refusal = await refused([json(A, { name: 'a', dependencies: { b: 'workspace:*' } })]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_ROOT_OUTSIDE_ROOT', path: A });
  });

  it('an excluded pnpm-workspace.yaml the step needs refuses DATA_REQUEST_UNROUTED', async () => {
    const routing = dataRoutingFor({ resources: { extractors: { data: { exclude: [YAML] } } } });
    const refusal = await refused([json(ROOT_PKG, { packageManager: 'pnpm@9.0.0' }), text(YAML, 'packages: [a/*]\n')], { routing });
    expect(refusal).toMatchObject({ code: 'DATA_REQUEST_UNROUTED', path: YAML });
    expect(refusal.message).toContain('resources.extractors.data.exclude');
    expect(refusal.remedy).toContain('resources.extractors.data');
  });

  it('an excluded member package.json refuses DATA_REQUEST_UNROUTED', async () => {
    const routing = dataRoutingFor({ resources: { extractors: { data: { exclude: ['packages/b/**'] } } } });
    const refusal = await refused(twoMembers({ workspaces: ['packages/*'] }, '^1.0.0'), { routing });
    expect(refusal).toMatchObject({ code: 'DATA_REQUEST_UNROUTED', path: B });
  });
});

describe('workspace demand and backings', () => {
  const files = twoMembers({ packageManager: 'pnpm@9.0.0' }, 'workspace:*', [text(YAML, 'packages: ["packages/*"]\n'), text(NPMRC, 'link-workspace-packages=true\n')]);

  it('not demanded: no workspace answer', async () => {
    const result = staged(await stage(files, { demand: { tables: [], routes: true, values: false, workspace: false } }));
    expect(result.workspace).toBeUndefined();
  });

  it('store on, cold and warm, answers as store off', async () => {
    const off = await answered(files);
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    expect(await answered(files, { store, reads: runStoredReads() })).toEqual(off);
    expect(await answered(files, { store, reads: runStoredReads() })).toEqual(off);
  });

  it('store on: a row set evicted before a declared read throws the row-set eviction for the lane to retry', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const seams: DataStageSeams = {
      ...NO_DATA_STAGE_SEAMS,
      beforeDeclaredRead: (ids) => {
        const [first] = ids;
        if (first !== undefined) store.forgetRowSet(first);
      },
    };
    const error = await stage(files, { demand: WORKSPACE, store, reads: runStoredReads(), seams }).catch((caught: unknown) => caught);
    expect(isStoredRowsEvicted(error)).toBe(true);
  });
});
