/**
 * The resolution host: a virtual isolated install over a root's git
 * content, its workspace link table, the output map's keys and served `package.json` texts. Every
 * answer is checked through the vendored TypeScript's own `resolveModuleName`, so the clauses are
 * the ones TypeScript actually asks.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { OutputMaps, type RunOutputMap } from '../src/projection/ts-output-map.js';
import { resolveHost, type ResolveHost } from '../src/projection/ts-resolve-host.js';
import { workspaceLinks, type WorkspaceLinkTable } from '../src/projection/workspace-links.js';
import type { WorkspaceDependencyRow, WorkspacePackageRow } from '../src/schemas/projection-workspace.js';
import type ts from '../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

import { parseInMemoryTsconfig } from './helpers/in-memory-tsconfig.js';

let typescript: typeof ts;

const ROOT = '/r';
const EXPORT_SOURCE = 'export const x = 1;\n';

/**
 * Four members: `a` declares `@acme/b` and `@acme/d`; `b` declares `@acme/c` and exports built
 * output under `dist`; `c` exports a source file and is declared by `b` only; `d` names built output
 * by its `types` field (the route that asks `directoryProbablyExists`), declared by `a` only.
 */
const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
  'packages/a/package.json': JSON.stringify({ name: '@acme/a', dependencies: { '@acme/b': 'workspace:*', '@acme/d': 'workspace:*' } }),
  'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }),
  'packages/a/src/x.ts': EXPORT_SOURCE,
  'packages/b/package.json': JSON.stringify({
    name: '@acme/b',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies: { '@acme/c': 'workspace:*' },
  }),
  'packages/b/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', outDir: 'dist', rootDir: 'src', declaration: true }, include: ['src'] }),
  'packages/b/src/index.ts': EXPORT_SOURCE,
  'packages/c/package.json': JSON.stringify({ name: '@acme/c', exports: { '.': './src/index.ts' } }),
  'packages/c/src/index.ts': EXPORT_SOURCE,
  'packages/d/package.json': JSON.stringify({ name: '@acme/d', types: './dist/index.d.ts' }),
  'packages/d/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src', declaration: true }, include: ['src'] }),
  'packages/d/src/index.ts': EXPORT_SOURCE,
};

const ABSOLUTE_FILES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(FILES).map(([path, text]) => [`${ROOT}/${path}`, text]));

function pkg(dir: string, name: string | null): WorkspacePackageRow {
  return { root: 'r', path: dir === '.' ? 'package.json' : `${dir}/package.json`, dir, name, version: null, private: null, workspaceRoot: dir === '.' };
}

function dep(from: string, name: string, target: string): WorkspaceDependencyRow {
  return { root: 'r', path: `${from}/package.json`, field: 'dependencies', name, range: 'workspace:*', targetPath: `${target}/package.json`, protocol: 'workspace' };
}

const PACKAGES = [pkg('.', 'root'), pkg('packages/a', '@acme/a'), pkg('packages/b', '@acme/b'), pkg('packages/c', '@acme/c'), pkg('packages/d', '@acme/d')];
const DEPENDENCIES = [dep('packages/a', '@acme/b', 'packages/b'), dep('packages/a', '@acme/d', 'packages/d'), dep('packages/b', '@acme/c', 'packages/c')];

let links: WorkspaceLinkTable;
let outputs: RunOutputMap;
let optionsA: ts.CompilerOptions;

beforeAll(async () => {
  typescript = await loadVendoredTypeScript();
  links = workspaceLinks(PACKAGES, DEPENDENCIES, false);
  const built = ['b', 'd'].map((member) => parseInMemoryTsconfig(typescript, ABSOLUTE_FILES, `${ROOT}/packages/${member}/tsconfig.json`));
  outputs = new OutputMaps(typescript, false, (name) => new Error(`lacks ${name}`)).combined(built);
  optionsA = parseInMemoryTsconfig(typescript, ABSOLUTE_FILES, `${ROOT}/packages/a/tsconfig.json`).options;
});

/** The host over the fixture, with `overrides` replacing its inputs. */
function hostOf(overrides: { outputs?: RunOutputMap; links?: WorkspaceLinkTable } = {}): ResolveHost {
  return resolveHost({
    root: ROOT,
    listing: Object.keys(FILES),
    links: overrides.links ?? links,
    outputs: overrides.outputs ?? outputs,
    packageJsonText: (path) => (path.endsWith('package.json') ? FILES[path] : undefined),
    useCaseSensitiveFileNames: true,
  });
}

function resolve(specifier: string, containing: string, host: ts.ModuleResolutionHost, options: ts.CompilerOptions = optionsA): ts.ResolvedModuleFull | undefined {
  return typescript.resolveModuleName(specifier, `${ROOT}/${containing}`, options, host).resolvedModule;
}

describe('resolveHost through resolveModuleName', () => {
  it('resolves a declared member through exports naming dist to the output-map key, by its real path', () => {
    const resolved = resolve('@acme/b', 'packages/a/src/x.ts', hostOf());
    expect(resolved?.resolvedFileName).toBe(`${ROOT}/packages/b/dist/index.d.ts`);
    // originalPath is set by TypeScript's resolver but absent from the public typings
    expect((resolved as { originalPath?: string } | undefined)?.originalPath).toBe(`${ROOT}/packages/a/node_modules/@acme/b/dist/index.d.ts`);
    expect(outputs.lookup(`${ROOT}/packages/b/dist/index.d.ts`)).toEqual({ kind: 'source', source: `${ROOT}/packages/b/src/index.ts` });
  });

  it('does not resolve a member the containing manifest does not declare', () => {
    expect(resolve('@acme/c', 'packages/a/src/x.ts', hostOf())).toBeUndefined();
  });

  it('keeps the linked spelling under preserveSymlinks (the step maps it afterwards)', () => {
    const resolved = resolve('@acme/b', 'packages/a/src/x.ts', hostOf(), { ...optionsA, preserveSymlinks: true });
    expect(resolved?.resolvedFileName).toBe(`${ROOT}/packages/a/node_modules/@acme/b/dist/index.d.ts`);
    expect(hostOf().realpath(resolved?.resolvedFileName ?? '')).toBe(`${ROOT}/packages/b/dist/index.d.ts`);
  });

  it('resolves a member whose types field names built output, and the red seed: without the output-map directory clause directoryProbablyExists fails first and fileExists is never asked', () => {
    const full = hostOf();
    expect(resolve('@acme/d', 'packages/a/src/x.ts', full)?.resolvedFileName).toBe(`${ROOT}/packages/d/dist/index.d.ts`);
    const noOutputDirs = hostOf({ outputs: new OutputMaps(typescript, false, (name) => new Error(name)).combined([]) });
    const asked: string[] = [];
    const seeded: ts.ModuleResolutionHost = {
      ...full,
      directoryExists: noOutputDirs.directoryExists,
      fileExists: (path) => {
        asked.push(path);
        return full.fileExists(path);
      },
    };
    expect(resolve('@acme/d', 'packages/a/src/x.ts', seeded)).toBeUndefined();
    expect(asked.filter((path) => path.includes('/dist/'))).toEqual([]);
  });

  it('a file of b reached from a\'s program resolves by b\'s declarations, and the reverse', () => {
    const host = hostOf();
    // b declares @acme/c, a does not
    expect(resolve('@acme/c', 'packages/b/src/index.ts', host)?.resolvedFileName).toBe(`${ROOT}/packages/c/src/index.ts`);
    expect(resolve('@acme/c', 'packages/a/src/x.ts', host)).toBeUndefined();
    // a declares @acme/d, b does not
    expect(resolve('@acme/d', 'packages/a/src/x.ts', host)?.resolvedFileName).toBe(`${ROOT}/packages/d/dist/index.d.ts`);
    expect(resolve('@acme/d', 'packages/b/src/index.ts', host)).toBeUndefined();
  });

  it('resolves nothing third-party: an undeclared package under any node_modules does not exist', () => {
    expect(resolve('react', 'packages/a/src/x.ts', hostOf())).toBeUndefined();
  });
});

describe('resolveHost members', () => {
  it('has <D>/node_modules only with a link beneath it', () => {
    const host = hostOf();
    expect(host.directoryExists(`${ROOT}/packages/a/node_modules`)).toBe(true);
    expect(host.directoryExists(`${ROOT}/packages/c/node_modules`)).toBe(false);
    expect(host.directoryExists(`${ROOT}/node_modules`)).toBe(false);
    expect(hostOf({ links: workspaceLinks(PACKAGES, [], false) }).directoryExists(`${ROOT}/packages/a/node_modules`)).toBe(false);
  });

  it('has the @scope directory only for a scope with a link', () => {
    const host = hostOf();
    expect(host.directoryExists(`${ROOT}/packages/a/node_modules/@acme`)).toBe(true);
    expect(host.directoryExists(`${ROOT}/packages/a/node_modules/@other`)).toBe(false);
    expect(host.getDirectories(`${ROOT}/packages/a/node_modules`)).toEqual(['@acme']);
    expect(host.getDirectories(`${ROOT}/packages/a/node_modules/@acme`)).toEqual(['b', 'd']);
  });

  it('answers through a link as at its target, and a nested node_modules below a link as absent', () => {
    const host = hostOf();
    expect(host.fileExists(`${ROOT}/packages/a/node_modules/@acme/b/src/index.ts`)).toBe(true);
    expect(host.directoryExists(`${ROOT}/packages/a/node_modules/@acme/b/dist`)).toBe(true);
    expect(host.directoryExists(`${ROOT}/packages/a/node_modules/@acme/b/node_modules`)).toBe(false);
    expect(host.fileExists(`${ROOT}/packages/a/node_modules/@acme/b/node_modules/@acme/c/src/index.ts`)).toBe(false);
    expect(host.realpath(`${ROOT}/packages/a/node_modules/@acme/b`)).toBe(`${ROOT}/packages/b`);
    expect(host.realpath(`${ROOT}/packages/a/src/x.ts`)).toBe(`${ROOT}/packages/a/src/x.ts`);
  });

  it('holds output-map keys as files and their directories, nothing else of the build', () => {
    const host = hostOf();
    expect(host.fileExists(`${ROOT}/packages/b/dist/index.d.ts`)).toBe(true);
    expect(host.fileExists(`${ROOT}/packages/b/dist/other.d.ts`)).toBe(false);
    expect(host.directoryExists(`${ROOT}/packages/b/dist`)).toBe(true);
    expect(host.directoryExists(`${ROOT}/packages/a/dist`)).toBe(false);
  });

  it('serves only package.json texts, through a link, from the served texts', () => {
    const host = hostOf();
    expect(host.readFile(`${ROOT}/packages/a/node_modules/@acme/b/package.json`)).toBe(FILES['packages/b/package.json']);
    expect(host.readFile(`${ROOT}/packages/b/package.json`)).toBe(FILES['packages/b/package.json']);
    expect(host.readFile(`${ROOT}/packages/b/src/index.ts`)).toBeUndefined();
    expect(host.readFile(`${ROOT}/packages/z/package.json`)).toBeUndefined();
  });

  it('lists directories of the virtual tree: git content, output dirs and node_modules where links are', () => {
    const host = hostOf();
    expect(host.getDirectories(`${ROOT}/packages/a`)).toEqual(['node_modules', 'src']);
    expect(host.getDirectories(`${ROOT}/packages/b`)).toEqual(['dist', 'node_modules', 'src']);
    expect(host.getDirectories(`${ROOT}/packages/a/node_modules/@acme/b`)).toEqual(['dist', 'src']);
    expect(host.getDirectories(`${ROOT}/packages/zz`)).toEqual([]);
  });

  it('holds git content under a node_modules that is no link as absent, as the tsconfig host does', () => {
    const host = resolveHost({ root: ROOT, listing: [...Object.keys(FILES), 'packages/c/node_modules/left-pad/index.ts'], links, outputs, packageJsonText: () => undefined, useCaseSensitiveFileNames: true });
    expect(host.fileExists(`${ROOT}/packages/c/node_modules/left-pad/index.ts`)).toBe(false);
    expect(host.directoryExists(`${ROOT}/packages/c/node_modules`)).toBe(false);
    expect(host.getDirectories(`${ROOT}/packages/c`)).toEqual(['src']);
    expect(host.contentPath(`${ROOT}/packages/c/node_modules/left-pad/index.ts`)).toBeUndefined();
  });

  it('answers nothing outside the root, and reports its root and case rule', () => {
    const host = hostOf();
    expect(host.fileExists('/elsewhere/package.json')).toBe(false);
    expect(host.directoryExists('/elsewhere')).toBe(false);
    expect(host.getCurrentDirectory()).toBe(ROOT);
    expect(host.useCaseSensitiveFileNames).toBe(true);
    expect(host.contentPath(`${ROOT}/packages/a/node_modules/@acme/b/src/index.ts`)).toBe('packages/b/src/index.ts');
    expect(host.contentPath(`${ROOT}/packages/b/dist/index.d.ts`)).toBeUndefined();
  });

  it('folds case when the file system ignores it, answering in the listed spelling', () => {
    const host = resolveHost({
      root: ROOT,
      listing: ['packages/B/Src/Index.ts'],
      links: workspaceLinks([], [], true),
      outputs: new OutputMaps(typescript, true, (name) => new Error(name)).combined([]),
      packageJsonText: () => undefined,
      useCaseSensitiveFileNames: false,
    });
    expect(host.fileExists(`${ROOT}/packages/b/src/index.ts`)).toBe(true);
    expect(host.directoryExists(`${ROOT}/PACKAGES/b`)).toBe(true);
    expect(host.contentPath(`${ROOT}/packages/b/src/index.ts`)).toBe('packages/B/Src/Index.ts');
  });

  it('is disk-free: the module imports nothing from node:fs and takes TypeScript only as a type', () => {
    const source = readFileSync(new URL('../src/projection/ts-resolve-host.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+'(?:node:)?fs(?:\/promises)?'/);
    expect(source).not.toMatch(/vendored-typescript/);
    expect(source).toMatch(/import type ts from '\.\.\/vendor\/typescript\.cjs'/);
  });
});
