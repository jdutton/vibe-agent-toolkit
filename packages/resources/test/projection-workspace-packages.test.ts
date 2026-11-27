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

  describe('no packageManager: the manager from which lockfile exists, always said', () => {
    const noManager = (range: string, ...lockfiles: string[]): Realized[] => twoMembers({ workspaces: ['packages/*'] }, range, lockfiles.map((file) => text(file, 'x\n')));
    const conditionsOf = async (files: readonly Realized[]): Promise<string[]> => (await answered(files)).conditions.map(({ path, code }) => `${path} ${code}`);

    it('package-lock.json: npm, so workspace: is WORKSPACE_PROTOCOL_UNSUPPORTED', async () => {
      const rows = await answered(noManager('workspace:*', 'package-lock.json'));
      expect(dependency(rows, A, 'b').targetPath).toBeNull();
      expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual(['. WORKSPACE_MANAGER_INFERRED', `${A} WORKSPACE_PROTOCOL_UNSUPPORTED`]);
    });

    it('yarn.lock alone: yarn 1, so workspace: is unsupported; with .yarnrc.yml: yarn berry, so it links', async () => {
      expect(await conditionsOf(noManager('workspace:*', 'yarn.lock'))).toEqual(['. WORKSPACE_MANAGER_INFERRED', '. WORKSPACE_MANAGER_INFERRED', `${A} WORKSPACE_PROTOCOL_UNSUPPORTED`]);
      const berry = await answered(noManager('workspace:*', 'yarn.lock', '.yarnrc.yml'));
      expect(dependency(berry, A, 'b').targetPath).toBe(B);
      expect(berry.conditions.find((row) => row.message.includes('yarn berry'))).toBeDefined();
    });

    it('no lockfile: WORKSPACE_MANAGER_UNKNOWN, and a workspace: dependency links nothing; a plain range still links', async () => {
      const rows = await answered(noManager('workspace:*'));
      expect(dependency(rows, A, 'b').targetPath).toBeNull();
      expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual(['. WORKSPACE_MANAGER_UNKNOWN', `${A} WORKSPACE_MANAGER_UNKNOWN`]);
      expect(dependency(await answered(noManager('^1.0.0')), A, 'b').targetPath).toBe(B);
    });

    it('lockfiles of two managers: unknown', async () => {
      expect(await conditionsOf(noManager('^1.0.0', 'package-lock.json', 'bun.lock'))).toEqual(['. WORKSPACE_MANAGER_UNKNOWN']);
    });

    it('a catalog: dependency under an unknown manager links nothing, said', async () => {
      const rows = await answered([json(ROOT_PKG, { workspaces: ['packages/*'], catalog: { react: '^18.0.0' } }), json(A, { name: 'a', dependencies: { react: 'catalog:' } })]);
      expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual(['. WORKSPACE_MANAGER_UNKNOWN', `${A} WORKSPACE_MANAGER_UNKNOWN`]);
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

  it('pnpm: a tests/ member is a member (pnpm ignores only node_modules and bower_components), and a workspace: range links it', async () => {
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

    it('from 10.5: the root only, no condition', async () => {
      const rows = await answered(layout('pnpm@10.5.0', 'onlyBuiltDependencies: [esbuild]\n'));
      expect(memberPaths(rows)).toEqual([ROOT_PKG]);
      expect(rows.conditions).toEqual([]);
    });

    it('an unknown version reads as the newest, the root only, with WORKSPACE_MANAGER_VERSION_UNCHECKED', async () => {
      const unknown = await answered(layout('pnpm', ''));
      expect(memberPaths(unknown)).toEqual([ROOT_PKG]);
      expect(unknown.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual(['. WORKSPACE_MANAGER_VERSION_UNCHECKED']);
      const inferred = await answered(layout(undefined, ''));
      expect(memberPaths(inferred)).toEqual([ROOT_PKG]);
      expect(inferred.conditions.map(({ code }) => code)).toEqual(['WORKSPACE_MANAGER_INFERRED', 'WORKSPACE_MANAGER_VERSION_UNCHECKED']);
    });

    it('a version past the newest checked major (pnpm 12) reads as the newest, said', async () => {
      const rows = await answered(layout('pnpm@12.24.0', ''));
      expect(memberPaths(rows)).toEqual([ROOT_PKG]);
      expect(rows.conditions).toEqual([expect.objectContaining({ path: '.', code: 'WORKSPACE_MANAGER_VERSION_UNCHECKED' })]);
      expect(rows.conditions[0]?.message).toContain('12.24.0');
      expect((await answered(layout('pnpm@11.9.0', ''))).conditions).toEqual([]);
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

  it('npm: two members with one name: the first by path links, the other is a WORKSPACE_DUPLICATE_NAME condition naming both', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'npm@10.0.0', workspaces: ['packages/*'], dependencies: { dup: '*' } }),
      json(B, { name: 'dup' }),
      json(A, { name: 'dup' }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, ROOT_PKG, 'dup').targetPath).toBe(A);
    expect(rows.conditions).toEqual([expect.objectContaining({ path: B, code: 'WORKSPACE_DUPLICATE_NAME' })]);
    expect(rows.conditions[0]?.message).toContain(A);
  });

  it('member order is by code unit, not locale: an upper-case path sorts first', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', workspaces: ['packages/*'], dependencies: { dup: '*' } }),
      json('packages/a/package.json', { name: 'dup' }),
      json('packages/B/package.json', { name: 'dup' }),
    ];
    expect(dependency(await answered(files), ROOT_PKG, 'dup').targetPath).toBe('packages/B/package.json');
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
      json(ROOT_PKG, { name: 'root', packageManager: 'bun@1.3.9', workspaces: ['packages/*'] }),
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
    const pnpm = (yaml: string, npmrc?: string, packageManager = 'pnpm@9.0.0'): Realized[] => twoMembers({ packageManager }, '^1.0.0', [
      text(YAML, `packages: ["packages/*"]\n${yaml}`),
      ...(npmrc === undefined ? [] : [text(NPMRC, npmrc)]),
    ]);
    const target = async (files: readonly Realized[]): Promise<string | null> => dependency(await answered(files), A, 'b').targetPath;
    const codes = async (files: readonly Realized[]): Promise<string[]> => (await answered(files)).conditions.map(({ path, code }) => `${path} ${code}`);

    it('off by default', async () => expect(await target(pnpm(''))).toBeNull());
    it('on by default under pnpm 8', async () => {
      const files = twoMembers({ packageManager: 'pnpm@8.15.0' }, '^1.0.0', [text(YAML, 'packages: ["packages/*"]\n')]);
      expect(await target(files)).toBe(B);
    });
    it('pnpm 11 never reads it from .npmrc', async () => {
      const files = twoMembers({ packageManager: 'pnpm@11.0.0' }, '^1.0.0', [text(YAML, 'packages: ["packages/*"]\n'), text(NPMRC, 'link-workspace-packages=true\n')]);
      expect(await target(files)).toBeNull();
    });
    it('on in .npmrc', async () => expect(await target(pnpm('', 'link-workspace-packages=true\n'))).toBe(B));
    it('${VAR} in .npmrc is stored literally and is not true', async () => expect(await target(pnpm('', 'link-workspace-packages=${LINK}\n'))).toBeNull());

    it('from pnpm 10.5, camelCase in pnpm-workspace.yaml is read, and wins over .npmrc', async () => {
      expect(await target(pnpm('linkWorkspacePackages: deep\n', undefined, 'pnpm@10.5.0'))).toBe(B);
      expect(await target(pnpm('linkWorkspacePackages: false\n', 'link-workspace-packages=true\n', 'pnpm@10.8.0'))).toBeNull();
    });

    it('before pnpm 10.5, pnpm-workspace.yaml settings are never read: .npmrc decides, and the yaml key is WORKSPACE_SETTING_IGNORED', async () => {
      const files = pnpm('linkWorkspacePackages: false\n', 'link-workspace-packages=true\n', 'pnpm@10.4.0');
      expect(await target(files)).toBe(B);
      expect(await codes(files)).toEqual([`${YAML} WORKSPACE_SETTING_IGNORED`]);
      expect(await target(pnpm('linkWorkspacePackages: true\n'))).toBeNull();
    });

    it.each(['pnpm@9.0.0', 'pnpm@10.8.0', 'pnpm@11.1.0'])('%s: a kebab-case key in pnpm-workspace.yaml is never read, and is WORKSPACE_SETTING_IGNORED', async (packageManager) => {
      const files = pnpm('link-workspace-packages: true\n', undefined, packageManager);
      expect(await target(files)).toBeNull();
      expect(await codes(files)).toEqual([`${YAML} WORKSPACE_SETTING_IGNORED`]);
      // pnpm 9 with the yaml off and .npmrc on: pnpm links, since the yaml is not read.
      expect(await target(pnpm('link-workspace-packages: false\n', 'link-workspace-packages=true\n'))).toBe(B);
    });

    it('an excluded root .npmrc is a WORKSPACE_SETTING_UNKNOWN condition, not a refusal: a plain range that would link is null with WORKSPACE_TARGET_UNKNOWN', async () => {
      const routing = dataRoutingFor({ resources: { extractors: { data: { exclude: ['**/.npmrc'] } } } });
      const rows = await answered(pnpm('', 'link-workspace-packages=true\n//registry.example/:_authToken=x\n'), { routing });
      expect(memberPaths(rows)).toEqual([ROOT_PKG, A, B]);
      expect(dependency(rows, A, 'b').targetPath).toBeNull();
      expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${NPMRC} WORKSPACE_SETTING_UNKNOWN`, `${A} WORKSPACE_TARGET_UNKNOWN`]);
      expect(rows.conditions[0]?.message).not.toContain('rather than exclude');
    });
  });

  it('pnpm: catalog: and catalog:<name> resolve their range from pnpm-workspace.yaml', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@9.5.0' }),
      text(YAML, 'packages: ["packages/*"]\ncatalog:\n  react: ^18.2.0\ncatalogs:\n  legacy:\n    react: ^16.14.0\n'),
      json(A, { name: 'a', dependencies: { react: 'catalog:' }, devDependencies: { react: 'catalog:legacy' }, peerDependencies: { vue: 'catalog:' } }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, A, 'react')).toMatchObject({ protocol: 'catalog', range: '^18.2.0', targetPath: null });
    expect(dependency(rows, A, 'react', 'devDependencies')).toMatchObject({ protocol: 'catalog', range: '^16.14.0' });
    expect(dependency(rows, A, 'vue', 'peerDependencies')).toMatchObject({ protocol: 'catalog', range: 'catalog:' });
    expect(rows.conditions).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_CATALOG_UNRESOLVED', seq: 0 })]);
  });

  it('pnpm: catalog and catalogs.default both set: pnpm refuses the file, so every default catalog: dependency links nothing, with WORKSPACE_CATALOG_CONFLICT', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@9.5.0' }),
      text(YAML, 'packages: ["packages/*"]\ncatalog:\n  react: ^18.2.0\ncatalogs:\n  default:\n    react: ^17.0.0\n    vue: ^3.0.0\n'),
      json(A, { name: 'a', dependencies: { react: 'catalog:', vue: 'catalog:default' } }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, A, 'react')).toMatchObject({ range: 'catalog:', targetPath: null });
    expect(dependency(rows, A, 'vue')).toMatchObject({ range: 'catalog:default', targetPath: null });
    expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${A} WORKSPACE_CATALOG_CONFLICT`, `${A} WORKSPACE_CATALOG_CONFLICT`, `${YAML} WORKSPACE_CATALOG_CONFLICT`]);
  });

  it('pnpm before 9.5: catalog: is WORKSPACE_PROTOCOL_UNSUPPORTED, and the yaml catalogs are not read', async () => {
    const files = [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@9.4.0' }),
      text(YAML, 'packages: ["packages/*"]\ncatalog:\n  react: ^18.2.0\n'),
      json(A, { name: 'a', dependencies: { react: 'catalog:' } }),
    ];
    const rows = await answered(files);
    expect(dependency(rows, A, 'react')).toMatchObject({ protocol: 'catalog', range: 'catalog:', targetPath: null });
    expect(rows.conditions).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_PROTOCOL_UNSUPPORTED' })]);
    expect(rows.conditions[0]?.message).toContain('9.5.0');
  });

  describe('pnpm: a name links when exactly one member of it satisfies the range', () => {
    const dupes = (range: string, extra: Record<string, unknown> = {}): Realized[] => [
      json(ROOT_PKG, { name: 'root', packageManager: 'pnpm@10.20.0' }),
      text(YAML, 'packages: ["packages/*"]\nlinkWorkspacePackages: true\n'),
      json('packages/app/package.json', { name: 'app', dependencies: { foo: range } }),
      json(A, { name: 'foo', version: '1.0.0' }),
      json(B, { name: 'foo', version: '2.0.0', ...extra }),
    ];
    const foo = async (files: readonly Realized[]): Promise<{ target: string | null; codes: string[] }> => {
      const rows = await answered(files);
      return { target: dependency(rows, 'packages/app/package.json', 'foo').targetPath, codes: rows.conditions.map(({ code }) => code) };
    };

    it('one of two same-named members satisfies: it links, and two names are no condition under pnpm', async () => {
      expect(await foo(dupes('workspace:^2.0.0'))).toEqual({ target: B, codes: [] });
      expect(await foo(dupes('^1.0.0'))).toEqual({ target: A, codes: [] });
    });

    it('both satisfy: null and WORKSPACE_TARGET_AMBIGUOUS', async () => {
      expect(await foo(dupes('workspace:*'))).toEqual({ target: null, codes: ['WORKSPACE_TARGET_AMBIGUOUS'] });
    });

    it('none satisfies: null and WORKSPACE_TARGET_UNSATISFIED', async () => {
      expect(await foo(dupes('workspace:^3.0.0'))).toEqual({ target: null, codes: ['WORKSPACE_TARGET_UNSATISFIED'] });
      expect(await foo(dupes('^3.0.0'))).toEqual({ target: null, codes: ['WORKSPACE_TARGET_UNSATISFIED'] });
    });

    it('a lone member the workspace: range does not satisfy links nothing', async () => {
      const files = twoMembers({ packageManager: 'pnpm@10.20.0' }, 'workspace:^2.0.0', [text(YAML, 'packages: ["packages/*"]\n')]);
      expect(dependency(await answered(files), A, 'b').targetPath).toBeNull();
    });
  });

  it.each(['npm@10.8.0', 'yarn@1.22.22'])('%s: a workspace: range links nothing, with a WORKSPACE_PROTOCOL_UNSUPPORTED condition', async (packageManager) => {
    const rows = await answered(twoMembers({ packageManager, workspaces: ['packages/*'] }, 'workspace:*'));
    expect(dependency(rows, A, 'b')).toMatchObject({ protocol: 'workspace', targetPath: null });
    expect(rows.conditions).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_PROTOCOL_UNSUPPORTED' })]);
  });

  it('yarn 4: a workspace: range links', async () => {
    expect(dependency(await answered(twoMembers({ packageManager: 'yarn@4.1.0', workspaces: ['packages/*'] }, 'workspace:*')), A, 'b').targetPath).toBe(B);
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

    it('no packageManager and a bun.lock: bun, inferred and said; the root package.json catalogs are read', async () => {
      const rows = await answered([...catalogRoot({ packageManager: undefined, catalog: { react: '^18.2.0' } }, 'catalog:'), text('bun.lock', '{}\n')]);
      expect(dependency(rows, A, 'react')).toMatchObject({ range: '^18.2.0' });
      expect(rows.conditions).toEqual([expect.objectContaining({ path: '.', code: 'WORKSPACE_MANAGER_INFERRED' })]);
      expect(rows.conditions[0]?.message).toContain('bun.lock');
    });

    it('a name in both catalog and catalogs.default: bun refuses it, so it links nothing; the other names resolve', async () => {
      const files = [
        json(ROOT_PKG, { name: 'root', packageManager: 'bun@1.3.9', workspaces: ['packages/*'], catalog: { react: '^18.2.0' }, catalogs: { default: { react: '^17.0.0', vue: '^3.0.0' } } }),
        json(A, { name: 'a', dependencies: { react: 'catalog:', vue: 'catalog:' } }),
      ];
      const rows = await answered(files);
      expect(dependency(rows, A, 'react')).toMatchObject({ range: 'catalog:', targetPath: null });
      expect(dependency(rows, A, 'vue')).toMatchObject({ range: '^3.0.0' });
      expect(rows.conditions.map(({ path, code }) => `${path} ${code}`)).toEqual([`${ROOT_PKG} WORKSPACE_CATALOG_CONFLICT`, `${A} WORKSPACE_CATALOG_CONFLICT`]);
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
      json(ROOT_PKG, { name: 'root', packageManager: 'bun@1.3.9', workspaces: ['packages/*'] }),
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

  it('a refused root input\'s remedy is to run again', async () => {
    const refusal = await refused([{ path: ROOT_PKG, state: 'unreadable', faultClass: 'busy' }, json(A, { name: 'a' })]);
    expect(refusal).toMatchObject({ code: 'WORKSPACE_ROOT_NO_ROWS', path: ROOT_PKG, retryable: true });
    expect(refusal.remedy).toContain('run VAT again');
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

  it('pnpm with no pnpm-workspace.yaml is a WORKSPACE_NOT_DECLARED condition, not outside-root; from a pnpm-lock.yaml too', async () => {
    const dependent = json(A, { name: 'a', dependencies: { b: 'workspace:*' } });
    const named = await undeclared([json(ROOT_PKG, { name: 'solo', packageManager: 'pnpm@9.0.0' }), dependent]);
    expect(named).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_NOT_DECLARED' })]);
    const locked = await undeclared([json(ROOT_PKG, { name: 'solo' }), dependent, text('pnpm-lock.yaml', 'x\n')]);
    expect(locked).toEqual([expect.objectContaining({ path: A, code: 'WORKSPACE_NOT_DECLARED' })]);
    expect(locked[0]?.message).toContain('pnpm-lock.yaml');
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
    expect(refusal.retryable).toBe(false);
  });

  it('an excluded member package.json keeps its row with nulls and a WORKSPACE_MEMBER_EXCLUDED condition; nothing refuses', async () => {
    const routing = dataRoutingFor({ resources: { extractors: { data: { exclude: ['packages/b/**'] } } } });
    const rows = await answered(twoMembers({ packageManager: 'npm@10.0.0', workspaces: ['packages/*'] }, '^1.0.0'), { routing });
    expect(rows.packages.find((row) => row.path === B)).toMatchObject({ name: null, version: null, private: null });
    expect(rows.conditions.map(({ path, code }) => [path, code])).toEqual([[A, 'WORKSPACE_TARGET_UNKNOWN'], [A, 'WORKSPACE_TARGET_UNKNOWN'], [B, 'WORKSPACE_MEMBER_EXCLUDED']]);
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
