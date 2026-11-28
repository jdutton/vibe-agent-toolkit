/**
 * The tsconfig parse job answers as TypeScript on disk does: over a real tree, `ts.sys` and the
 * job's listing-only host give the same files (less the literal entries the job reports as outside
 * git content) and the same error codes. Every file of a fixture is git content here, and every
 * JSON file is held, a config or the `package.json` TypeScript reads for a package-name `extends`.
 *
 * The linked fixtures lay a tree out as an isolated install does: each link a real directory
 * symlink (a junction on Windows) at `<D>/node_modules/<name>` to a member's directory, from a link
 * list written by hand per fixture (never computed by `workspaceLinks`, so the rule and its oracle
 * are not one function). TypeScript on disk follows the links; the job answers from the listing and
 * the same list. Both must give the same files (the disk's through `realpath`, since the job answers
 * canonical paths), the same `extends` chain and the same error codes; and the job without the links
 * must NOT (TS6053 where the disk resolves), so the fixtures can tell a linked host from one with no links.
 */

import { rmSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PARSE_LIMITS } from '../../src/parse-limits.js';
import { parseTsconfigs, type ParsedTsconfig } from '../../src/projection/tsconfig-parse.js';
import { NO_WORKSPACE_LINKS, type WorkspaceLink, type WorkspaceLinkTable } from '../../src/projection/workspace-links.js';
import type ts from '../../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../../src/vendored-typescript.js';

let typescript: typeof ts;

beforeAll(async () => {
  typescript = await loadVendoredTypeScript();
});

/** Fixtures the job and TypeScript on disk must answer alike: path to file text, and the config parsed. */
const DISK_FIXTURES: ReadonlyArray<{ readonly files: Readonly<Record<string, string>>; readonly config: string }> = [
  {
    config: 'pkg/tsconfig.json',
    files: {
      'pkg/tsconfig.json': '{"extends":["../base1.json","../base2"],"compilerOptions":{"allowJs":true}}',
      'base1.json': '{"extends":"./base0.json","include":["${configDir}/src","${configDir}/.config/**/*"]}',
      'base0.json': '{"compilerOptions":{"outDir":"${configDir}/dist"}}',
      'base2.json': '{"compilerOptions":{"strict":true}}',
      'pkg/src/a.ts': '', 'pkg/src/a.js': '', 'pkg/src/b.d.ts': '', 'pkg/src/c.js': '', 'pkg/.config/d.ts': '',
      'pkg/src/.hidden/e.ts': '', 'pkg/dist/f.ts': '',
    },
  },
  {
    config: 'tsconfig.json',
    files: {
      'tsconfig.json': '{"compilerOptions":{"declarationDir":"types"},"exclude":["skip"],"files":["x.ts","gone.ts"]}',
      'x.ts': '', 'skip/y.ts': '', 'types/z.d.ts': '', 'lib/w.tsx': '', 'package.json': '{"name":"p"}',
    },
  },
  {
    config: 'tsconfig.json',
    files: { 'tsconfig.json': '{"extends":"@scope/base/tsconfig.json","include":["nothing"]}', 'package.json': '{"name":"p"}', 'a.ts': '' },
  },
];

/** One link of a linked fixture, by hand: where the install puts it (`<D>/node_modules/<name>`) and the member directory it names. */
interface HandLink {
  readonly at: string;
  readonly target: string;
}

/** The members of the linked fixtures: a scoped base with two configs (one named by `exports`) and sources. */
const LINKED_MEMBERS: Readonly<Record<string, string>> = {
  'package.json': '{"name":"root","private":true}',
  'packages/base/package.json': '{"name":"@acme/base","exports":{"./strict":"./configs/strict.json","./tsconfig.json":"./tsconfig.json"}}',
  'packages/base/tsconfig.json': '{"compilerOptions":{"outDir":"./dist","strict":true}}',
  'packages/base/configs/strict.json': '{"extends":"../tsconfig.json","compilerOptions":{"noUncheckedIndexedAccess":true}}',
  'packages/base/src/x.ts': '', 'packages/base/src/deep/y.ts': '',
  'packages/app/package.json': '{"name":"app"}',
  'packages/app/src/a.ts': '',
  'packages/other/package.json': '{"name":"other"}',
  'packages/other/src/o.ts': '',
};

/** Linked fixtures: the files, the hand-written links, and the config parsed. */
const LINKED_FIXTURES: ReadonlyArray<{ readonly name: string; readonly files: Readonly<Record<string, string>>; readonly links: readonly HandLink[]; readonly config: string }> = [
  {
    name: 'a member extends a declared member\'s config by package name',
    config: 'packages/app/tsconfig.json',
    files: { ...LINKED_MEMBERS, 'packages/app/tsconfig.json': '{"extends":"@acme/base/tsconfig.json","include":["src"]}' },
    links: [{ at: 'packages/app/node_modules/@acme/base', target: 'packages/base' }],
  },
  {
    name: 'an extends named by the linked package.json#exports, chaining inside the member',
    config: 'packages/app/tsconfig.json',
    files: { ...LINKED_MEMBERS, 'packages/app/tsconfig.json': '{"extends":"@acme/base/strict","include":["src"]}' },
    links: [{ at: 'packages/app/node_modules/@acme/base', target: 'packages/base' }],
  },
  {
    name: 'a root-declared member resolves from a member that declares nothing',
    config: 'packages/other/tsconfig.json',
    files: { ...LINKED_MEMBERS, 'packages/other/tsconfig.json': '{"extends":"@acme/base/tsconfig.json","include":["src"]}' },
    links: [{ at: 'node_modules/@acme/base', target: 'packages/base' }],
  },
  {
    name: 'a literal include through a link lists the member\'s files',
    config: 'tsconfig.json',
    files: { ...LINKED_MEMBERS, 'tsconfig.json': '{"include":["node_modules/@acme/base/src"]}' },
    links: [{ at: 'node_modules/@acme/base', target: 'packages/base' }],
  },
];

/**
 * The job's link table for a hand-written list: the table's plain-data shape, filled directly.
 *
 * @param links - The links
 * @returns The table, keyed by spelling
 */
function handTable(links: readonly HandLink[]): WorkspaceLinkTable {
  const table: Record<string, WorkspaceLink> = {};
  for (const { at, target } of links) {
    const cut = at.lastIndexOf('node_modules') + 'node_modules'.length;
    const name = at.slice(cut + 1);
    const slash = name.startsWith('@') ? name.indexOf('/') : -1;
    table[at] = { path: at, target, nodeModules: at.slice(0, cut), name: name.slice(slash + 1), ...(slash > 0 ? { scope: name.slice(0, slash) } : {}) };
  }
  return { ignoreCase: false, links: table };
}

/** Write a fixture's files under `root`. */
function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSyncReal(safePath.resolve(root, path, '..'), { recursive: true });
    writeFileSync(safePath.join(root, path), text);
  }
}

/** TypeScript's own parse of `config` on disk, through `ts.sys`. */
function parsedOnDisk(root: string, config: string): ts.ParsedCommandLine & { readonly extended: readonly string[] } {
  const fileName = safePath.join(root, config);
  const sourceFile = typescript.readJsonConfigFile(fileName, typescript.sys.readFile);
  const parsed = typescript.parseJsonSourceFileConfigFileContent(sourceFile, typescript.sys, safePath.resolve(fileName, '..'), undefined, fileName);
  const extended = (sourceFile as unknown as { extendedSourceFiles?: readonly string[] }).extendedSourceFiles ?? [];
  return Object.assign(parsed, { extended });
}

/** The job's one config over the fixture, every JSON file held. */
function parsedByJob(root: string, files: Readonly<Record<string, string>>, config: string, links: WorkspaceLinkTable): ParsedTsconfig | undefined {
  const texts = Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.json')));
  const answer = parseTsconfigs(
    typescript,
    { root, configs: [config], texts, listing: Object.keys(files), links, useCaseSensitiveFileNames: typescript.sys.useCaseSensitiveFileNames },
    DEFAULT_PARSE_LIMITS,
  );
  expect(answer.outcome).toBe('parsed');
  return answer.outcome === 'parsed' ? answer.configs[0] : undefined;
}

/** A disk path as the job answers it: root-relative through `realpath`. */
function canonicalOnDisk(root: string, name: string): string {
  return safePath.relative(typescript.sys.realpath?.(root) ?? root, typescript.sys.realpath?.(name) ?? name);
}

describe('the tsconfig parse job against TypeScript on disk', () => {
  const base = safePath.join(normalizedTmpdir(), `vat-tsconfig-oracle-${String(process.pid)}`);
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it.each(DISK_FIXTURES.map((fixture, index) => [index, fixture] as const))('fixture %i: the same files and error codes as ts.sys over the same tree', (_index, fixture) => {
    const root = safePath.join(base, `fixture-${String(_index)}`);
    writeTree(root, fixture.files);
    const onDisk = parsedOnDisk(root, fixture.config);
    const config = parsedByJob(root, fixture.files, fixture.config, NO_WORKSPACE_LINKS);
    const outsideGit = new Set(config?.reachesOutsideGit.map((entry) => entry.path));
    expect(config?.fileNames).toEqual(onDisk.fileNames.map((name) => safePath.relative(root, name)).filter((name) => !outsideGit.has(name)));
    expect(config?.errors.map((error) => error.code)).toEqual(onDisk.errors.map((error) => error.code));
  });

  it.for(LINKED_FIXTURES.map((fixture, index) => [index, fixture] as const))('linked fixture %i: the same files, chain and error codes as ts.sys over an isolated install', ([index, fixture], context) => {
    const capability = symlinkCapability();
    if (capability === null) {
      context.skip('this host cannot create directory symlinks or junctions');
      return;
    }
    const root = safePath.join(base, `linked-${String(index)}`);
    writeTree(root, fixture.files);
    for (const link of fixture.links) {
      const at = safePath.join(root, link.at);
      mkdirSyncReal(safePath.resolve(at, '..'), { recursive: true });
      createSymlink(capability, safePath.join(root, link.target), at, 'junction');
    }
    const onDisk = parsedOnDisk(root, fixture.config);
    expect(onDisk.errors.map((error) => error.code), `premise: ${fixture.name} resolves on disk`).toEqual([]);
    const config = parsedByJob(root, fixture.files, fixture.config, handTable(fixture.links));
    expect(config?.fileNames, fixture.name).toEqual(onDisk.fileNames.map((name) => canonicalOnDisk(root, name)));
    expect(config?.extends, fixture.name).toEqual(onDisk.extended.map((name) => canonicalOnDisk(root, name)));
    expect(config?.errors.map((error) => error.code), fixture.name).toEqual([]);
    // Without the links the job is a host with no links: it cannot see what the disk resolves.
    const unlinked = parsedByJob(root, fixture.files, fixture.config, NO_WORKSPACE_LINKS);
    expect(unlinked?.errors.length === 0 && unlinked.fileNames.length === config?.fileNames.length, `${fixture.name}: the links decide the answer`).toBe(false);
  });
});
