/**
 * The workspace resolve step (`workspace-packages.ts`) through the data stage it runs in: membership
 * per manager, the member each dependency names (by path or by name, never an install outcome), the
 * root as a name per manager, the pnpm-workspace.yaml consumer rules, defective
 * inputs, the outside-root refusal and `DATA_REQUEST_UNROUTED`. Store off unless an arm says so;
 * the store-on arms answer the same.
 */

import { describe, expect, it } from 'vitest';

import { type RowSetDemand, type DataStageResult } from '../src/projection/data-stage.js';
import { isStoredRowsEvicted } from '../src/projection/query-projection.js';
import { dataRoutingFor } from '../src/projection/router.js';
import { runStoredReads } from '../src/projection/stored-reads.js';

import { FakeFactStore, WIDE_STORE_BUDGETS } from './fake-fact-store.js';
import { evictingFirstDeclaredRead, stage, staged, type Realized } from './helpers/data-stage-fixture.js';

const WORKSPACE: RowSetDemand = { tables: [], dataRoutes: false, dataValues: false, tsRoutes: false, tsImports: false, workspace: true, tsconfig: false };
const ROOT_ID = 'root-1';
const ROOT_PKG = 'package.json';
const A = 'packages/a/package.json';
const B = 'packages/b/package.json';
const YAML = 'pnpm-workspace.yaml';

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
    const rows = await answered(twoMembers({ packageManager: 'yarn@1.22.22', private: true, workspaces: { packages: ['packages/*'], nohoist: ['**/x'] } }, '^1.0.0'));
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

  describe('no packageManager: the manager from which lockfile exists, always said', () => {
    const noManager = (range: string, ...lockfiles: string[]): Realized[] => twoMembers({ workspaces: ['packages/*'], private: true }, range, lockfiles.map((file) => text(file, 'x\n')));
    const conditionsOf = async (files: readonly Realized[]): Promise<string[]> => (await answered(files)).conditions.map(({ path, code }) => `${path} ${code}`);

    it('package-lock.json: npm, inferred and said; workspace:* names the member by name', async () => {
      const rows = await answered(noManager('workspace:*', 'package-lock.json'));
      expect(dependency(rows, A, 'b')).toMatchObject({ protocol: 'workspace', targetPath: B });
      expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_INFERRED`]);
    });

    it('yarn.lock alone: yarn 1, said twice (the manager, then its flavour); with .yarnrc.yml: yarn berry', async () => {
      expect(await conditionsOf(noManager('workspace:*', 'yarn.lock'))).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_INFERRED`, `${ROOT_PKG} WORKSPACE_MANAGER_INFERRED`]);
      const berry = await answered(noManager('workspace:*', 'yarn.lock', '.yarnrc.yml'));
      expect(dependency(berry, A, 'b').targetPath).toBe(B);
      expect(berry.conditions.find((row) => row.message.includes('yarn berry'))).toBeDefined();
    });

    it('no lockfile: WORKSPACE_MANAGER_UNKNOWN at the root package.json; a name still names its member', async () => {
      const rows = await answered(noManager('workspace:*'));
      expect(dependency(rows, A, 'b').targetPath).toBe(B);
      expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_UNKNOWN`]);
    });

    it('lockfiles of two managers: unknown', async () => {
      expect(await conditionsOf(noManager('^1.0.0', 'package-lock.json', 'bun.lock'))).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_UNKNOWN`]);
    });

    it('an unknown manager: a workspace: path and the root\'s name are null with WORKSPACE_MANAGER_UNKNOWN at the member', async () => {
      const rows = await answered([
        json(ROOT_PKG, { name: 'root', workspaces: ['packages/*'] }),
        json(A, { name: 'a', dependencies: { b: 'workspace:../b', root: 'workspace:*' } }),
        json(B, { name: 'b' }),
      ]);
      expect(dependency(rows, A, 'b').targetPath).toBeNull();
      expect(dependency(rows, A, 'root').targetPath).toBeNull();
      expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_UNKNOWN`, `${A} WORKSPACE_MANAGER_UNKNOWN`, `${A} WORKSPACE_MANAGER_UNKNOWN`]);
    });

    it('yarn with no version and no evidence of its flavour: unknown, said at the root', async () => {
      expect(await conditionsOf(twoMembers({ packageManager: 'yarn', workspaces: ['packages/*'] }, '^1.0.0'))).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_UNKNOWN`]);
    });
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

  it('pnpm: canonicalised patterns, negation', async () => {
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

  it('pnpm: a tests/ member is a member (pnpm ignores only node_modules and bower_components), and a workspace: range names it', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@10.20.0', dependencies: { e2e: 'workspace:*' } }),
      text(YAML, 'packages: [packages/*, tests/*]\n'),
      json('tests/e2e/package.json', { name: 'e2e' }),
    ];
    expect(dependency(await answered(files), ROOT_PKG, 'e2e').targetPath).toBe('tests/e2e/package.json');
  });

  describe('pnpm: no packages key, by pnpm version', () => {
    const nested = [
      json(A, { name: 'a' }),
      json('deep/er/package.json', { name: 'deep' }),
      json('fixtures/tests/package.json', { name: 'fixture' }),
      json('bower_components/z/package.json', { name: 'z' }),
    ];
    const layout = (packageManager: string | undefined, yaml: string): Realized[] => [json(ROOT_PKG, { name: 'root', packageManager }), text(YAML, yaml), ...nested];

    it('before 10.5, an empty file: every package.json, minus node_modules and bower_components', async () => {
      const rows = await answered(layout('pnpm@9.0.0', ''));
      expect(memberPaths(rows)).toEqual(['deep/er/package.json', 'fixtures/tests/package.json', ROOT_PKG, A]);
      expect(rows.conditions).toEqual([]);
    });

    it('before 10.5, a file with other keys: pnpm refuses it; the root only, and a WORKSPACE_PACKAGES_MALFORMED condition', async () => {
      const rows = await answered(layout('pnpm@10.4.1', 'catalog:\n  react: ^18.0.0\n'));
      expect(memberPaths(rows)).toEqual([ROOT_PKG]);
      expect(rows.conditions).toEqual([expect.objectContaining({ path: YAML, code: 'WORKSPACE_PACKAGES_MALFORMED' })]);
      expect(rows.conditions[0]?.message).toContain('pnpm 10.4.1');
    });

    it('from 10.5, and any later major: the root only, no condition', async () => {
      for (const packageManager of ['pnpm@10.5.0', 'pnpm@12.24.0']) {
        const rows = await answered(layout(packageManager, 'onlyBuiltDependencies: [esbuild]\n'));
        expect(memberPaths(rows)).toEqual([ROOT_PKG]);
        expect(rows.conditions).toEqual([]);
      }
    });

    it('an unknown version: the root only, with WORKSPACE_MANAGER_VERSION_UNKNOWN', async () => {
      const unknown = await answered(layout('pnpm', ''));
      expect(memberPaths(unknown)).toEqual([ROOT_PKG]);
      expect(unknown.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_VERSION_UNKNOWN`]);
      const inferred = await answered(layout(undefined, ''));
      expect(memberPaths(inferred)).toEqual([ROOT_PKG]);
      expect(inferred.conditions.map(({ code }) => code)).toEqual(['WORKSPACE_MANAGER_INFERRED', 'WORKSPACE_MANAGER_VERSION_UNKNOWN']);
    });

    it('an unknown version with a packages key: no version condition, nothing depends on it', async () => {
      expect((await answered([json(ROOT_PKG, { packageManager: 'pnpm' }), text(YAML, 'packages: [packages/*]\n'), json(A, { name: 'a' })])).conditions).toEqual([]);
    });
  });

  it('pnpm: a pnpm-workspace.yaml with no root package.json is a workspace with no root row', async () => {
    const rows = await answered([text(YAML, 'packages: [packages/*]\n'), json(A, { name: 'a', dependencies: { b: 'workspace:*' } }), json(B, { name: 'b' })]);
    expect(memberPaths(rows)).toEqual([A, B]);
    expect(dependency(rows, A, 'b').targetPath).toBe(B);
  });

  it('a malformed pattern list is a WORKSPACE_PACKAGES_MALFORMED condition, never a silent drop', async () => {
    const notArray = await answered([json(ROOT_PKG, { packageManager: 'pnpm@9.0.0' }), text(YAML, 'packages: packages/*\n'), json(A, { name: 'a' })]);
    expect(memberPaths(notArray)).toEqual([ROOT_PKG]);
    expect(notArray.conditions).toEqual([expect.objectContaining({ path: YAML, code: 'WORKSPACE_PACKAGES_MALFORMED' })]);
    const nonString = await answered([json(ROOT_PKG, { packageManager: 'npm@10.0.0', workspaces: ['packages/*', 7] }), json(A, { name: 'a' })]);
    expect(memberPaths(nonString)).toEqual([ROOT_PKG, A]);
    expect(nonString.conditions).toEqual([expect.objectContaining({ path: ROOT_PKG, code: 'WORKSPACE_PACKAGES_MALFORMED' })]);
  });

  it('two members with one name: each carries WORKSPACE_DUPLICATE_NAME naming the other, and a dependency on the name is null', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'npm@10.0.0', workspaces: ['packages/*'], dependencies: { dup: '*' } }),
      json(B, { name: 'dup' }),
      json(A, { name: 'dup' }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, ROOT_PKG, 'dup').targetPath).toBeNull();
    expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${A} WORKSPACE_DUPLICATE_NAME`, `${B} WORKSPACE_DUPLICATE_NAME`]);
    expect(rows.conditions[0]?.message).toContain(B);
  });

  it('pnpm: two members with one name are a duplicate too, whatever their versions', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@10.20.0' }),
      text(YAML, 'packages: ["packages/*"]\n'),
      json('packages/app/package.json', { name: 'app', dependencies: { foo: 'workspace:^2.0.0' } }),
      json(A, { name: 'foo', version: '1.0.0' }),
      json(B, { name: 'foo', version: '2.0.0' }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, 'packages/app/package.json', 'foo').targetPath).toBeNull();
    expect(rows.conditions.map(({ code }) => code)).toEqual(['WORKSPACE_DUPLICATE_NAME', 'WORKSPACE_DUPLICATE_NAME']);
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

describe('workspace dependencies: targetPath is the member a dependency names', () => {
  const npmRoot = { packageManager: 'npm@10.0.0', workspaces: ['packages/*'] };

  it('a plain range names the same-named member, whatever its version; a registry package names none', async () => {
    const rows = await answered(twoMembers(npmRoot, '^2.0.0'));
    expect(dependency(rows, A, 'b')).toEqual({ root: ROOT_ID, path: A, field: 'dependencies', name: 'b', range: '^2.0.0', targetPath: B, protocol: 'npm' });
    expect(dependency(rows, A, 'react')).toMatchObject({ targetPath: null, protocol: 'npm' });
    expect(rows.conditions).toEqual([]);
  });

  it('pnpm: a plain range names the member, with no link-workspace-packages read anywhere', async () => {
    const files = twoMembers({ packageManager: 'pnpm@9.0.0' }, '^1.0.0', [text(YAML, 'packages: ["packages/*"]\nlinkWorkspacePackages: false\n'), text('.npmrc', 'link-workspace-packages=false\n')]);
    const rows = await answered(files);
    expect(dependency(rows, A, 'b')).toMatchObject({ protocol: 'npm', targetPath: B });
    expect(rows.conditions).toEqual([]);
  });

  it.each(['npm@10.8.0', 'yarn@1.22.22', 'yarn@4.1.0', 'bun@1.3.9', 'pnpm@10.20.0'])('%s: workspace:* and workspace:^x name the member; protocol says workspace', async (packageManager) => {
    const yaml = packageManager.startsWith('pnpm') ? [text(YAML, 'packages: ["packages/*"]\n')] : [];
    const root = { packageManager, workspaces: ['packages/*'], private: true };
    for (const range of ['workspace:*', 'workspace:^9.0.0']) {
      const rows = await answered(twoMembers(root, range, yaml));
      expect(dependency(rows, A, 'b')).toMatchObject({ protocol: 'workspace', range, targetPath: B });
      expect(rows.conditions).toEqual([]);
    }
  });

  it('catalog: names the same-named member; the range stays as written and no catalog is read', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@9.5.0' }),
      text(YAML, 'packages: ["packages/*"]\ncatalog:\n  b: ^1.0.0\n'),
      json(A, { name: 'a', dependencies: { b: 'catalog:', react: 'catalog:legacy' } }),
      json(B, { name: 'b' }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, A, 'b')).toMatchObject({ protocol: 'catalog', range: 'catalog:', targetPath: B });
    expect(dependency(rows, A, 'react')).toMatchObject({ protocol: 'catalog', range: 'catalog:legacy', targetPath: null });
    expect(rows.conditions).toEqual([]);
  });

  it('npm:<name>@ and pnpm\'s workspace:<name>@ name <name>', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@10.20.0' }),
      text(YAML, 'packages: ["packages/*"]\n'),
      json(A, { name: 'a', dependencies: { alias: 'workspace:b@*', other: 'npm:b@^1.0.0', scoped: 'npm:@x/y@1' } }),
      json(B, { name: 'b' }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, A, 'alias')).toMatchObject({ protocol: 'workspace', targetPath: B });
    expect(dependency(rows, A, 'other')).toMatchObject({ protocol: 'npm', targetPath: B });
    expect(dependency(rows, A, 'scoped').targetPath).toBeNull();
  });

  it('link: and file: name the member at that directory, from the declaring package', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'npm@10.0.0', workspaces: ['packages/*'], dependencies: { up: 'file:./packages/b' } }),
      json(A, { name: 'a', dependencies: { b: 'link:../b', home: 'file:../..' } }),
      json(B, { name: 'b' }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, A, 'b')).toMatchObject({ protocol: 'link', targetPath: B });
    expect(dependency(rows, A, 'home')).toMatchObject({ protocol: 'file', targetPath: ROOT_PKG });
    expect(dependency(rows, ROOT_PKG, 'up')).toMatchObject({ protocol: 'file', targetPath: B });
  });

  it('a path that names no member is null with WORKSPACE_PATH_UNRESOLVED: a tarball, a non-member directory, an absolute path, one leaving the root', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'npm@10.0.0', workspaces: ['packages/*'] }),
      json(A, { name: 'a', dependencies: { t: 'file:../../vendor/t.tgz', v: 'file:../../vendor/v', abs: 'file:/opt/x', out: 'link:../../../x' } }),
    ];
    const rows = await answered(files);
    for (const name of ['t', 'v', 'abs', 'out']) expect(dependency(rows, A, name).targetPath).toBeNull();
    expect(rows.conditions.map(({ path, code, seq }) => `${path} ${code} ${String(seq)}`)).toEqual([0, 1, 2, 3].map((seq) => `${A} WORKSPACE_PATH_UNRESOLVED ${String(seq)}`));
  });

  it('pnpm: workspace:<path> resolves from the declaring package; workspace:packages/b is not a path', async () => {
    const rows = await answered([
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@10.20.0' }),
      text(YAML, 'packages: ["packages/*"]\n'),
      json(A, { name: 'a', dependencies: { b: 'workspace:../b', bad: 'workspace:./packages/b' } }),
      json(B, { name: 'b' }),
    ]);
    expect(dependency(rows, A, 'b').targetPath).toBe(B);
    expect(dependency(rows, A, 'bad').targetPath).toBeNull();
    expect(rows.conditions).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_PATH_UNRESOLVED' })]);
  });

  it('yarn berry: workspace:<path> resolves from the project root, and a path need not start with ./', async () => {
    const rows = await answered([
      json(ROOT_PKG, { name: 'root', packageManager: 'yarn@4.1.0', workspaces: ['packages/*'] }),
      json(A, { name: 'a', dependencies: { b: 'workspace:packages/b', rel: 'workspace:./packages/b', fromMember: 'workspace:../b' } }),
      json(B, { name: 'b' }),
    ]);
    expect(dependency(rows, A, 'b').targetPath).toBe(B);
    expect(dependency(rows, A, 'rel').targetPath).toBe(B);
    expect(dependency(rows, A, 'fromMember').targetPath).toBeNull();
    expect(rows.conditions).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_PATH_UNRESOLVED' })]);
  });

  it('bun: a workspace: name that a member carries wins; otherwise a path from the declaring package', async () => {
    const rows = await answered([
      json(ROOT_PKG, { name: 'root', packageManager: 'bun@1.3.9', workspaces: ['packages/*'] }),
      json(A, { name: 'a', dependencies: { b: 'workspace:../nowhere', pkg: 'workspace:../b' } }),
      json(B, { name: 'b' }),
    ]);
    expect(dependency(rows, A, 'b').targetPath).toBe(B);
    expect(dependency(rows, A, 'pkg').targetPath).toBe(B);
  });

  it.each(['npm@10.8.0', 'yarn@1.22.22'])('%s: a workspace: path has no path form there, so it is null with WORKSPACE_PATH_UNRESOLVED', async (packageManager) => {
    const rows = await answered(twoMembers({ packageManager, workspaces: ['packages/*'], private: true }, 'workspace:../b'));
    expect(dependency(rows, A, 'b').targetPath).toBeNull();
    expect(rows.conditions).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_PATH_UNRESOLVED' })]);
  });

  describe('the root as a name: only where the manager makes it a member', () => {
    const rooted = (packageManager: string, range: string): Realized[] => [
      json(ROOT_PKG, { name: 'acme', packageManager, workspaces: ['packages/*'], private: true }),
      text(YAML, 'packages: ["packages/*"]\n'),
      json(A, { name: 'a', dependencies: { acme: range } }),
    ];
    const target = async (files: readonly Realized[]): Promise<string | null> => dependency(await answered(files), A, 'acme').targetPath;

    it.each(['npm@10.8.0', 'yarn@1.22.22'])('%s: never', async (packageManager) => {
      expect(await target(rooted(packageManager, '*'))).toBeNull();
      expect(await target(rooted(packageManager, 'workspace:*'))).toBeNull();
    });

    it.each(['yarn@4.1.0', 'pnpm@10.20.0'])('%s: by any range', async (packageManager) => {
      expect(await target(rooted(packageManager, '*'))).toBe(ROOT_PKG);
      expect(await target(rooted(packageManager, 'workspace:*'))).toBe(ROOT_PKG);
    });

    it('bun: through workspace: only', async () => {
      expect(await target(rooted('bun@1.3.9', '*'))).toBeNull();
      expect(await target(rooted('bun@1.3.9', 'workspace:*'))).toBe(ROOT_PKG);
    });

    it('npm: a member named like the root is the only target, and no duplicate', async () => {
      const files = [...rooted('npm@10.8.0', '*'), json(B, { name: 'acme' })];
      const rows = await answered(files);
      expect(dependency(rows, A, 'acme').targetPath).toBe(B);
      expect(rows.conditions).toEqual([]);
    });

    it('pnpm: a member named like the root is a duplicate', async () => {
      const rows = await answered([...rooted('pnpm@10.20.0', 'workspace:*'), json(B, { name: 'acme' })]);
      expect(dependency(rows, A, 'acme').targetPath).toBeNull();
      expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${ROOT_PKG} WORKSPACE_DUPLICATE_NAME`, `${B} WORKSPACE_DUPLICATE_NAME`]);
    });
  });

  it('yarn 1 without private: true: no workspace, with WORKSPACE_NOT_DECLARED at the root package.json', async () => {
    const rows = await answered(twoMembers({ packageManager: 'yarn@1.22.22', workspaces: ['packages/*'] }, 'workspace:*'));
    expect(rows.packages).toEqual([]);
    expect(rows.conditions).toEqual([expect.objectContaining({ path: ROOT_PKG, code: 'WORKSPACE_NOT_DECLARED' })]);
    expect(memberPaths(await answered(twoMembers({ packageManager: 'yarn@1.22.22', workspaces: ['packages/*'], private: true }, '^1.0.0')))).toEqual([ROOT_PKG, A, B]);
  });
});

describe('defective inputs', () => {
  it('a defective member keeps its row, with nulls and a WORKSPACE_MEMBER_NO_ROWS condition; a name it may carry is unknown, said once for the root', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'bun@1.3.9', workspaces: ['packages/*'] }),
      json(A, { name: 'a', dependencies: { missing: 'workspace:*', b: 'workspace:*' } }),
      text(B, '{'),
    ];
    const rows = await answered(files);
    expect(rows.packages.find((row) => row.path === B)).toEqual({ root: ROOT_ID, path: B, dir: 'packages/b', name: null, version: null, private: null, workspaceRoot: false });
    expect(rows.dependencies.filter((row) => row.path === B)).toEqual([]);
    expect(dependency(rows, A, 'missing').targetPath).toBeNull();
    expect(rows.conditions.map(({ path, code }) => [path, code])).toEqual([
      [ROOT_PKG, 'WORKSPACE_TARGET_UNKNOWN'],
      [B, 'WORKSPACE_MEMBER_NO_ROWS'],
    ]);
    expect(rows.conditions.find((row) => row.code === 'WORKSPACE_MEMBER_NO_ROWS')?.message).toContain('DATA_PARSE_ERROR');
  });

  it('a defective root input in one root refuses that root only: the other answers, and the gap is a WORKSPACE_ROOT_REFUSED condition', async () => {
    const files: Realized[] = [
      text(ROOT_PKG, '{'),
      json(A, { name: 'a' }),
      { ...json(ROOT_PKG, { name: 'two', packageManager: 'npm@10.0.0', workspaces: ['packages/*'] }), root: 'root-2' },
      { ...json(A, { name: 'a2' }), root: 'root-2' },
    ];
    const rows = await answered(files);
    expect(rows.packages.map((row) => `${row.root} ${row.path}`)).toEqual([`root-2 ${ROOT_PKG}`, `root-2 ${A}`]);
    expect(rows.conditions).toEqual([expect.objectContaining({ root: ROOT_ID, path: ROOT_PKG, code: 'WORKSPACE_ROOT_REFUSED' })]);
    expect(rows.conditions[0]?.message).toMatch(/^WORKSPACE_ROOT_NO_ROWS: /);
  });

  it('every root refused: the family takes a refusal a rerun cannot answer before one it may', async () => {
    const files: Realized[] = [
      { path: ROOT_PKG, state: 'unreadable', faultClass: 'busy' },
      { ...text(ROOT_PKG, '{'), root: 'root-2' },
    ];
    const refusal = await refused(files);
    expect(refusal).toMatchObject({ root: 'root-2', code: 'WORKSPACE_ROOT_NO_ROWS', retryable: false });
  });
  it('a refused root input\'s remedy is to run again', async () => {
    const refusal = await refused([{ path: ROOT_PKG, state: 'unreadable', faultClass: 'busy' }, json(A, { name: 'a' })]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_ROOT_NO_ROWS', path: ROOT_PKG, retryable: true });
    expect(refusal.remedy).toBe('wait for whatever holds the file to release it, then run again');
  });

  it('a defective root package.json refuses the family, naming the file and its code', async () => {
    const refusal = await refused([text(ROOT_PKG, '{'), json(A, { name: 'a' })]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_ROOT_NO_ROWS', path: ROOT_PKG, retryable: false });
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

  it('a duplicated key outside packages does not refuse: the step reads only packages', async () => {
    const rows = await answered([root, text(YAML, 'packages: [a/*]\ncatalog:\n  react: ^18.0.0\n  react: ^17.0.0\nlinkWorkspacePackages: true\nlinkWorkspacePackages: false\n')]);
    expect(rows.packages).toHaveLength(1);
  });

  it('a duplicated key beneath packages refuses too', async () => {
    const refusal = await refused([root, text(YAML, 'packages:\n  sub: 1\n  sub: 2\n')]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_DUPLICATE_KEY' });
    expect(refusal.message).toContain('/packages/sub');
  });

  it('a << under catalog does not refuse; a << at the top of a file with no packages of its own does', async () => {
    expect((await answered([root, text(YAML, 'base: &base\n  react: ^18.0.0\npackages: [a/*]\ncatalog:\n  <<: *base\n')])).packages).toHaveLength(1);
    expect((await answered([root, text(YAML, 'base: &base\n  x: 1\npackages: [a/*]\n<<: *base\n')])).packages).toHaveLength(1);
    const refusal = await refused([root, text(YAML, 'base: &base\n  packages: [a/*]\n<<: *base\n')]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_MERGE_KEY', path: YAML });
  });
});

describe('workspace refusals from the run', () => {
  /** @returns The answer's conditions, after asserting it has no package rows */
  const undeclared = async (files: readonly Realized[], options: Parameters<typeof stage>[1] = {}): Promise<Answered['conditions']> => {
    const rows = await answered(files, options);
    expect(rows.packages).toEqual([]);
    return rows.conditions;
  };

  it('a package.json declaring workspace: while the analysis root declares no workspace is a WORKSPACE_ROOT_OUTSIDE_ROOT condition at it, naming exclude; nothing refuses', async () => {
    const conditions = await undeclared([json(ROOT_PKG, { name: 'solo' }), json(A, { name: 'a', dependencies: { b: 'workspace:*' } }), json(B, { name: 'b', dependencies: { a: 'workspace:*' } })]);
    expect(conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${A} WORKSPACE_ROOT_OUTSIDE_ROOT`, `${B} WORKSPACE_ROOT_OUTSIDE_ROOT`]);
    expect(conditions[0]?.message).toContain('resources.extractors.data.exclude');
  });

  it('pnpm with no pnpm-workspace.yaml is a WORKSPACE_NOT_DECLARED condition, not outside-root; from a pnpm-lock.yaml too, said at the root', async () => {
    const dependent = json(A, { name: 'a', dependencies: { b: 'workspace:*' } });
    const named = await undeclared([json(ROOT_PKG, { name: 'solo', packageManager: 'pnpm@9.0.0' }), dependent]);
    expect(named).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_NOT_DECLARED' })]);
    const locked = await undeclared([json(ROOT_PKG, { name: 'solo' }), dependent, text('pnpm-lock.yaml', 'x\n')]);
    expect(locked.map(({ path, code }) => `${path} ${code}`)).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_INFERRED`, `${A} WORKSPACE_NOT_DECLARED`]);
    expect(locked[1]?.message).toContain('pnpm-lock.yaml');
  });

  it('a pnpm-lock.yaml alone, with no workspace: user: the inference is still said, never silent', async () => {
    const conditions = await undeclared([json(ROOT_PKG, { name: 'solo', workspaces: ['packages/*'] }), json(A, { name: 'a' }), text('pnpm-lock.yaml', 'x\n')]);
    expect(conditions).toEqual([expect.objectContaining({ path: ROOT_PKG, code: 'WORKSPACE_MANAGER_INFERRED' })]);
    expect(conditions[0]?.message).toContain('declares no workspace');
  });

  it('an excluded fixture manifest is passed over: the condition goes away', async () => {
    const routing = dataRoutingFor({ resources: { extractors: { data: { exclude: ['packages/a/**'] } } } });
    expect(await undeclared([json(ROOT_PKG, { name: 'solo' }), json(A, { name: 'a', dependencies: { b: 'workspace:*' } })], { routing })).toEqual([]);
  });

  it('a nested fixture workspace under a non-workspace root refuses nothing', async () => {
    const rows = await answered([
      json(ROOT_PKG, { name: 'solo' }),
      json('fixtures/ws/package.json', { name: 'ws', workspaces: ['a'] }),
      json('fixtures/ws/a/package.json', { name: 'a', dependencies: { b: 'workspace:*' } }),
      text('fixtures/pn/pnpm-workspace.yaml', 'packages: [a]\n'),
      json('fixtures/pn/a/package.json', { name: 'pa', dependencies: { b: 'workspace:*' } }),
    ]);
    expect(rows).toMatchObject({ packages: [], dependencies: [], conditions: [] });
  });

  it('a root that declares no workspace below its repository top level is a WORKSPACE_ROOT_MAY_BE_ABOVE condition', async () => {
    const files = [json(ROOT_PKG, { name: 'solo', dependencies: { b: '^1.0.0' } })];
    const below = await answered(files, { repositoryTop: () => '/' });
    expect(below.packages).toEqual([]);
    expect(below.conditions).toEqual([expect.objectContaining({ path: '.', code: 'WORKSPACE_ROOT_MAY_BE_ABOVE' })]);
    expect((await answered(files, { repositoryTop: (rootPath) => rootPath })).conditions).toEqual([]);
  });

  it('with no root package.json at all, too', async () => {
    expect(await undeclared([json(A, { name: 'a', dependencies: { b: 'workspace:*' } })])).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_ROOT_OUTSIDE_ROOT' })]);
  });

  it('an excluded pnpm-workspace.yaml the step needs refuses DATA_REQUEST_UNROUTED', async () => {
    const routing = dataRoutingFor({ resources: { extractors: { data: { exclude: [YAML] } } } });
    const refusal = await refused([json(ROOT_PKG, { packageManager: 'pnpm@9.0.0' }), text(YAML, 'packages: [a/*]\n')], { routing });
    expect(refusal).toMatchObject({ code: 'DATA_REQUEST_UNROUTED', path: YAML });
    expect(refusal.message).toContain('resources.extractors.data.exclude');
    expect(refusal.remedy).toContain('resources.extractors.data');
    expect(refusal.remedy).not.toContain('rather than exclude');
    expect(refusal.remedy).toContain('only way');
    expect(refusal.retryable).toBe(false);
  });

  it('an excluded member package.json keeps its row with nulls and a WORKSPACE_MEMBER_EXCLUDED condition; nothing refuses', async () => {
    const routing = dataRoutingFor({ resources: { extractors: { data: { exclude: ['packages/b/**'] } } } });
    const rows = await answered(twoMembers({ packageManager: 'npm@10.0.0', workspaces: ['packages/*'] }, '^1.0.0'), { routing });
    expect(rows.packages.find((row) => row.path === B)).toMatchObject({ name: null, version: null, private: null });
    expect(rows.conditions.map(({ path, code }) => [path, code])).toEqual([[ROOT_PKG, 'WORKSPACE_TARGET_UNKNOWN'], [B, 'WORKSPACE_MEMBER_EXCLUDED']]);
  });
});

describe('workspace demand and backings', () => {
  const files = twoMembers({ packageManager: 'pnpm@9.0.0' }, 'workspace:*', [text(YAML, 'packages: ["packages/*"]\n')]);

  it('not demanded: no workspace answer', async () => {
    const result = staged(await stage(files, { demand: { tables: [], dataRoutes: true, dataValues: false, tsRoutes: false, tsImports: false, workspace: false, tsconfig: false } }));
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
    const seams = evictingFirstDeclaredRead(store);
    const error = await stage(files, { demand: WORKSPACE, store, reads: runStoredReads(), seams }).catch((caught: unknown) => caught);
    expect(isStoredRowsEvicted(error)).toBe(true);
  });
});

describe('workspace: the managers\' own specifier rules', () => {
  const npmAt = (packageManager: string | undefined, dependencies: Record<string, string>, extra: readonly Realized[] = []): Realized[] => [
    json(ROOT_PKG, { name: 'root', packageManager, workspaces: ['packages/*'], private: true }),
    json(A, { name: 'a', dependencies }),
    json(B, { name: 'b' }),
    ...extra,
  ];
  const codesOf = (rows: Answered): string[] => rows.conditions.map(({ path, code }) => `${path} ${code}`);

  it('a bare path is a path to the declaring manager, labelled file (pnpm: link, a tarball file)', async () => {
    const npm = await answered(npmAt('npm@10.8.0', { b: '../b', home: '~/x', t: './t.tgz' }));
    expect(dependency(npm, A, 'b')).toMatchObject({ protocol: 'file', targetPath: B });
    expect(dependency(npm, A, 'home')).toMatchObject({ protocol: 'file', targetPath: null });
    expect(dependency(npm, A, 't')).toMatchObject({ protocol: 'file', targetPath: null });
    expect(codesOf(npm)).toEqual([`${A} WORKSPACE_PATH_UNRESOLVED`, `${A} WORKSPACE_PATH_UNRESOLVED`]);
    const pnpm = await answered(npmAt('pnpm@10.20.0', { b: '../b', t: './t.tgz' }, [text(YAML, 'packages: ["packages/*"]\n')]));
    expect(dependency(pnpm, A, 'b')).toMatchObject({ protocol: 'link', targetPath: B });
    expect(dependency(pnpm, A, 't')).toMatchObject({ protocol: 'file', targetPath: null });
  });

  it('yarn 1 reads ~/ as no path (a name); yarn berry reads a drive letter only with a separator', async () => {
    const yarn1 = await answered(npmAt('yarn@1.22.22', { b: '~/b', c: '../b' }));
    expect(dependency(yarn1, A, 'b')).toMatchObject({ protocol: 'npm', targetPath: B });
    expect(dependency(yarn1, A, 'c')).toMatchObject({ protocol: 'file', targetPath: B });
    const berry = await answered(npmAt('yarn@4.1.0', { b: 'C:x' }));
    expect(dependency(berry, A, 'b')).toMatchObject({ protocol: 'npm', targetPath: B });
  });

  it('an unknown manager: a bare path all four read as a path resolves; one they disagree on is WORKSPACE_MANAGER_UNKNOWN', async () => {
    const rows = await answered(npmAt(undefined, { b: '../b', c: '~/b' }));
    expect(dependency(rows, A, 'b')).toMatchObject({ protocol: 'file', targetPath: B });
    expect(dependency(rows, A, 'c').targetPath).toBeNull();
    expect(codesOf(rows)).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_UNKNOWN`, `${A} WORKSPACE_MANAGER_UNKNOWN`]);
  });

  it('bun and pnpm: workspace:<alias>@<range> names <alias>, a scoped alias too; bun looks the member up by the alias', async () => {
    const scoped = json('packages/s/package.json', { name: '@x/y' });
    for (const packageManager of ['bun@1.3.9', 'pnpm@10.20.0']) {
      const rows = await answered(npmAt(packageManager, { alias: 'workspace:b@*', s: 'workspace:@x/y@^1' }, [scoped, text(YAML, 'packages: ["packages/*"]\n')]));
      expect(dependency(rows, A, 'alias').targetPath).toBe(B);
      expect(dependency(rows, A, 's').targetPath).toBe('packages/s/package.json');
    }
  });

  it('pnpm: an alias may not start with . _ or /, so workspace:_b@1 names the dependency key', async () => {
    const rows = await answered(npmAt('pnpm@10.20.0', { b: 'workspace:_x@1' }, [text(YAML, 'packages: ["packages/*"]\n')]));
    expect(dependency(rows, A, 'b').targetPath).toBe(B);
  });

  it('npm names a member with no name by its folder, a scoped folder too; the name column stays as written', async () => {
    const files = [
      json(ROOT_PKG, { packageManager: 'npm@10.8.0', workspaces: ['packages/*', 'packages/@s/*'] }),
      json(A, { dependencies: { b: '*', '@s/x': '*' } }),
      json(B, { name: '' }),
      json('packages/@s/x/package.json', { version: '1.0.0' }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, A, 'b').targetPath).toBe(B);
    expect(dependency(rows, A, '@s/x').targetPath).toBe('packages/@s/x/package.json');
    expect(rows.packages.find((row) => row.path === A)?.name).toBeNull();
    expect(rows.conditions).toEqual([]);
  });

  it('npm: a nameless member named by its folder duplicates a member carrying that name', async () => {
    const rows = await answered([
      json(ROOT_PKG, { packageManager: 'npm@10.8.0', workspaces: ['packages/*'], dependencies: { utils: '*' } }),
      json('packages/utils/package.json', {}),
      json(A, { name: 'utils' }),
    ]);
    expect(dependency(rows, ROOT_PKG, 'utils').targetPath).toBeNull();
    expect(codesOf(rows)).toEqual([`${A} WORKSPACE_DUPLICATE_NAME`, 'packages/utils/package.json WORKSPACE_DUPLICATE_NAME']);
  });

  it('every other manager: a member with rows and no name is WORKSPACE_MEMBER_NAMELESS, and nothing names it', async () => {
    const rows = await answered([json(ROOT_PKG, { packageManager: 'bun@1.3.9', workspaces: ['packages/*'] }), json(A, { dependencies: { b: '*' } }), json(B, {})]);
    expect(dependency(rows, A, 'b').targetPath).toBeNull();
    expect(codesOf(rows)).toEqual([`${A} WORKSPACE_MEMBER_NAMELESS`, `${B} WORKSPACE_MEMBER_NAMELESS`]);
  });

  it('an unknown manager: a nameless member is WORKSPACE_MEMBER_NAMELESS saying npm names it by folder; a dependency on the folder name is WORKSPACE_MANAGER_UNKNOWN', async () => {
    const rows = await answered([json(ROOT_PKG, { workspaces: ['packages/*'] }), json(A, { name: 'a', dependencies: { b: '*' } }), json(B, {})]);
    expect(dependency(rows, A, 'b').targetPath).toBeNull();
    expect(codesOf(rows)).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_UNKNOWN`, `${A} WORKSPACE_MANAGER_UNKNOWN`, `${B} WORKSPACE_MEMBER_NAMELESS`]);
    expect(rows.conditions.find((row) => row.code === 'WORKSPACE_MEMBER_NAMELESS')?.message).toContain('folder');
  });

  it('bun: a member sharing the root\'s name wins, with no duplicate', async () => {
    const rows = await answered([
      json(ROOT_PKG, { name: 'acme', packageManager: 'bun@1.3.9', workspaces: ['packages/*'] }),
      json(A, { name: 'a', dependencies: { acme: 'workspace:*' } }),
      json(B, { name: 'acme' }),
    ]);
    expect(dependency(rows, A, 'acme').targetPath).toBe(B);
    expect(rows.conditions).toEqual([]);
  });

  it('bun: link:<package name> is a bun link registration, never a path; an unknown manager cannot say', async () => {
    const bun = await answered(npmAt('bun@1.3.9', { b: 'link:b', c: 'link:../b' }));
    expect(dependency(bun, A, 'b')).toMatchObject({ protocol: 'link', targetPath: null });
    expect(dependency(bun, A, 'c').targetPath).toBe(B);
    expect(codesOf(bun)).toEqual([`${A} WORKSPACE_PATH_UNRESOLVED`]);
    expect(bun.conditions[0]?.message).toContain('bun link');
    const unknown = await answered(npmAt(undefined, { b: 'link:b' }));
    expect(dependency(unknown, A, 'b').targetPath).toBeNull();
    expect(codesOf(unknown)).toEqual([`${ROOT_PKG} WORKSPACE_MANAGER_UNKNOWN`, `${A} WORKSPACE_MANAGER_UNKNOWN`]);
  });

  it('yarn 1: private by JavaScript truthiness, and no WORKSPACE_NOT_DECLARED for an empty package list', async () => {
    const yarn1 = (root: Record<string, unknown>): Realized[] => twoMembers({ packageManager: 'yarn@1.22.22', ...root }, '^1.0.0');
    for (const value of ['yes', 1, {}]) expect(memberPaths(await answered(yarn1({ private: value, workspaces: ['packages/*'] })))).toEqual([ROOT_PKG, A, B]);
    for (const value of [0, '', null, false]) {
      expect(codesOf(await answered(yarn1({ private: value, workspaces: ['packages/*'] })))).toEqual([`${ROOT_PKG} WORKSPACE_NOT_DECLARED`]);
    }
    const empty = await answered(yarn1({ workspaces: [] }));
    expect(memberPaths(empty)).toEqual([ROOT_PKG]);
    expect(empty.conditions).toEqual([]);
  });

  it('a manifest read as JSONC is a WORKSPACE_READ_AS_JSONC condition, once per manifest', async () => {
    const routing = dataRoutingFor({ resources: { extractors: { data: { jsonc: ['**/*.json'] } } } });
    const rows = await answered(twoMembers({ packageManager: 'npm@10.8.0', workspaces: ['packages/*'] }, '^1.0.0'), { routing });
    expect(codesOf(rows)).toEqual([`${ROOT_PKG} WORKSPACE_READ_AS_JSONC`, `${A} WORKSPACE_READ_AS_JSONC`, `${B} WORKSPACE_READ_AS_JSONC`]);
    expect(rows.conditions[0]?.message).toContain('strict JSON');
  });

  it('the manager conditions sit at the root package.json; with none, at .', async () => {
    const rows = await answered([text(YAML, ''), json(A, { name: 'a' })]);
    expect(codesOf(rows)).toEqual(['. WORKSPACE_MANAGER_INFERRED', '. WORKSPACE_MANAGER_VERSION_UNKNOWN']);
  });
});
