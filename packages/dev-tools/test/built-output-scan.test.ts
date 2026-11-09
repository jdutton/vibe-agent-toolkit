/**
 * The test-tree scan reads syntax, not spelling: every expression a path sink
 * receives that has a `dist` segment is RESOLVED (a reach), TEMP, or
 * UNRESOLVED (a finding) — never skipped. A path call or temp source counts
 * only through its import, so every fixture imports what it calls. Each
 * fixture names one form; the real tree is pinned by the integration tier
 * (`built-output-scan.integration.test.ts`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { judgeScriptWord, scanTestTree } from '../src/built-output-scan.js';
import type { WorkspaceGraph, WorkspacePackage } from '../src/workspace-graph.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

/** A workspace graph of `dirs`, as far as the scan reads one. */
function graphOf(...dirs: string[]): WorkspaceGraph {
  const packages: WorkspacePackage[] = dirs.map((dir) => ({
    dir,
    name: `@scope/${dir}`,
    isPrivate: true,
    manifest: {},
    workspaceDeps: { runtime: [], dev: [] },
  }));
  return { packages, byName: new Map(packages.map((pkg) => [pkg.name, pkg] as const)) };
}

/** Write `files` (repo-relative → text) under `root`; returns their paths. */
function writeFiles(root: string, files: Record<string, string>): string[] {
  for (const [rel, text] of Object.entries(files)) {
    const file = safePath.join(root, rel);
    // eslint-disable-next-line local/no-fs-mkdirSync -- fixture path is a temp dir; realpath is not read back
    mkdirSync(safePath.join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  return Object.keys(files);
}

// `alpha` and `beta` are not packages of this repository.
const SITE = 'packages/beta/test/x.test.ts';
/** Every fixture below starts from the test file's own directory, `packages/beta/test`, with the path and temp sources imported. */
const PRELUDE = [
  "import { safePath } from '@vibe-agent-toolkit/utils';",
  "import { createTempDir, underTemp } from '@vibe-agent-toolkit/utils/testing';",
  "import os from 'node:os';",
  "import { mkdtempSync, readFileSync } from 'node:fs';",
  "import { execSync, spawn, spawnSync } from 'node:child_process';",
  'const here = import.meta.dirname;',
  "const ROOT = safePath.join(here, '..', '..', '..');",
  '',
].join('\n');

describe('scanTestTree on fixture sources', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir({ prefix: 'built-output-scan-' });
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  const scan = (text: string, extra: Record<string, string> = {}): ReturnType<typeof scanTestTree> =>
    scanTestTree(root, graphOf('alpha', 'beta'), writeFiles(root, { [SITE]: PRELUDE + text, ...extra }));
  /** The reaches, without the site fields every fixture shares, and the findings. */
  const reachesOf = (text: string): { reaches: Array<{ dir: string; subpath: string; open: boolean }>; findings: readonly unknown[] } => {
    const { reaches, findings } = scan(text);
    return { reaches: reaches.map(({ dir, subpath, open }) => ({ dir, subpath, open })), findings };
  };

  it.each([
    ['a ../ literal in resolve', "spawn(NODE, [safePath.resolve(here, '../../alpha/dist/bin.js')]);", 'alpha', 'dist/bin.js', false],
    ['repo-rooted segments', "safePath.join(ROOT, 'packages', 'alpha', 'dist');", 'alpha', 'dist', true],
    ['a joined package segment', "safePath.join(ROOT, 'packages/alpha', 'dist');", 'alpha', 'dist', true],
    ['a template literal', 'execFileSync(`${ROOT}/packages/alpha/dist/x.js`);', 'alpha', 'dist/x.js', false],
    ['a const of a const', "const UP = '../..';\nconst BIN = `${here}/${UP}/alpha/dist/a.js`;\nspawnSync(NODE, [BIN]);", 'alpha', 'dist/a.js', false],
    ['a let, past its placeholder', "let DIR = '';\nDIR = 'packages/alpha/dist/skills';\nsafePath.join(ROOT, DIR);", 'alpha', 'dist/skills', true],
    ['new URL', "new URL('../../alpha/dist/x.js', import.meta.url);", 'alpha', 'dist/x.js', false],
    ['vi.mock', "vi.mock('../../alpha/dist/y.js', () => ({}));", 'alpha', 'dist/y.js', false],
    ['a dynamic import of a relative literal', "await import('../../alpha/dist/z.js');", 'alpha', 'dist/z.js', false],
    ['a workspace package specifier', "await import('@scope/alpha/dist/z.js');", 'alpha', 'dist/z.js', false],
    ['an install link', "safePath.join(ROOT, 'node_modules/@scope/alpha/dist');", 'alpha', 'dist', true],
    ['its own package, from its directory', "safePath.resolve(here, '../dist/bin.js');", 'beta', 'dist/bin.js', false],
    ['its own package, from the working directory', "readFileSync('dist/index.js');", 'beta', 'dist/index.js', false],
    ['a helper called with a literal', "function bin(pkg: string) { return safePath.join(ROOT, 'packages', pkg, 'dist'); }\nbin('alpha');", 'alpha', 'dist', true],
    ['a describe.each table', "describe.each([{ pkg: 'alpha' }])('$pkg', (b) => { safePath.join(ROOT, 'packages', b.pkg, 'dist', 'skills'); });", 'alpha', 'dist/skills', true],
    ['an object spread', "const BASE = { pkg: 'alpha' };\nconst O = { ...BASE };\nsafePath.join(ROOT, 'packages', O.pkg, 'dist', 'x.js');", 'alpha', 'dist/x.js', false],
    ['a namespace import of node:path', "import * as nodePath from 'node:path';\nnodePath.join(ROOT, 'packages', 'alpha', 'dist');", 'alpha', 'dist', true],
    ['a default import of path', "import path from 'path';\npath.resolve(ROOT, 'packages/alpha/dist/x.js');", 'alpha', 'dist/x.js', false],
    ['require.resolve of a package specifier', "require.resolve('@scope/alpha/dist/r.js');", 'alpha', 'dist/r.js', false],
    ['import.meta.resolve of a relative specifier', "import.meta.resolve('../../alpha/dist/m.js');", 'alpha', 'dist/m.js', false],
    ['a promisified launch', "import { promisify } from 'node:util';\nimport { execFile } from 'node:child_process';\nawait promisify(execFile)('node', [`${ROOT}/packages/alpha/dist/p.js`]);", 'alpha', 'dist/p.js', false],
    ['a string appended to a known path', "readFileSync(ROOT + '/packages/alpha/dist/x.js');", 'alpha', 'dist/x.js', false],
    ['a local function named like a temp source', "function tmpdir() { return ROOT; }\nsafePath.join(tmpdir(), 'packages', 'alpha', 'dist');", 'alpha', 'dist', true],
    ['a default-imported tmpdir is still temp, past a sibling read', "safePath.join(os.tmpdir(), 'dist');\nsafePath.join(ROOT, 'packages', 'alpha', 'dist');", 'alpha', 'dist', true],
  ])('resolves %s, and leaves nothing unresolved', (_label, text, dir, subpath, open) => {
    expect(reachesOf(text)).toEqual({ reaches: [{ dir, subpath, open }], findings: [] });
  });

  it.each([
    ['a comment', "// safePath.join(ROOT, 'packages/alpha/dist')\n/* spawn('../../alpha/dist/x') */"],
    ['plain test data', "expect(filter('packages/alpha/dist/index.js')).toBe(false);"],
    ['a path no call uses', "const NEEDLE = '../../alpha/dist/x.js';\nexpect(urls).toContain(NEEDLE);"],
    ['a join bound to no path module', "const local = { join: (...p: string[]) => p.join('/') };\nlocal.join(ROOT, 'packages', 'alpha', 'dist');"],
    ['an absolute path', "readFileSync('/opt/packages/alpha/dist/x.js');"],
    ['os.tmpdir()', "safePath.join(os.tmpdir(), 'packages', 'alpha', 'dist');"],
    ['mkdtempSync', "const dir = mkdtempSync('x-');\nsafePath.join(dir, 'packages', 'alpha', 'dist');"],
    ['a temp-dir helper', "const dir = createTempDir('x-');\nsafePath.join(dir, 'dist', 'bin');"],
    ['a path declared under a temp dir', "const dir = createTempDir('x-');\nsafePath.join(underTemp(tree.root, dir), 'pkg', 'dist');"],
    ['a let reset only to temp dirs', "let dir = createTempDir('x-');\ndir = createTempDir('y-');\nsafePath.join(dir, 'dist');"],
  ])('finds no reach and nothing unresolved in %s', (_label, text) => {
    expect(scan(text)).toMatchObject({ reaches: [], findings: [] });
  });

  it.each([
    ['an unknown tail', "safePath.join(ROOT, 'packages', 'alpha', 'dist', name, 'x');"],
    ['a directory that is not a package', "safePath.join(ROOT, 'packages', 'nope', 'dist');"],
    ['a dist segment spelled in another case', "safePath.join(ROOT, 'packages', 'alpha', 'Dist');"],
    ['a value a cycle guard cut short', "function up(dir: string): string { return up(dir); }\nsafePath.join(up(ROOT), 'packages', 'alpha', 'dist');"],
    ['relative text after a `+`, which is no absolute path', "readFileSync('a' + '/packages/alpha/dist/x.js');"],
    ['a `..` climbing out of a temp dir', "const dir = createTempDir('x-');\nsafePath.join(dir, '..', '..', 'packages', 'alpha', 'dist');"],
    ['a relative path a launch resolves from its `cwd` option', "spawnSync('node', ['dist/bin.js'], { cwd: elsewhere });"],
    ['a relative path a shell option hands to a shell', "spawn('node', ['dist/bin.js'], { shell: true });"],
    ['a command string a shell parses', "execSync('node dist/bin.js');"],
    ['an untraceable parameter', "export function f(dir: string) { return safePath.join(dir, 'dist'); }"],
    ['a non-static package segment', "safePath.join(ROOT, 'packages', bundle.pkg, 'dist', 'skills');"],
    ['a let given an unknown value', "let dir = createTempDir('x-');\ndir = elsewhere();\nsafePath.join(dir, 'dist');"],
    ['a let built up by a compound assignment', "let dir = createTempDir('x-');\ndir += '-x';\nsafePath.join(dir, 'dist');"],
    ['a package directory that matches only ignoring case', "safePath.join(ROOT, 'packages', 'Alpha', 'dist');"],
  ])('reports %s at its file and line, and counts no reach', (_label, text) => {
    const result = scan(text);

    expect(result.reaches).toEqual([]);
    expect(result.findings.map((finding) => finding.site)).toEqual([`${SITE}:${(PRELUDE + text).split('\n').length.toString()}`]);
  });

  it('scans a root vitest setup file: from its own directory, the repo root, but not from a working directory it cannot know', () => {
    const setup = [
      "import { readFileSync } from 'node:fs';",
      "readFileSync('packages/alpha/dist/x.js');",
      "readFileSync(`${import.meta.dirname}/packages/alpha/dist/s.js`);",
    ].join('\n');
    // A package-root setup file is a setup; a setup-named helper deeper in a test tree is a helper.
    const result = scan('expect(1).toBe(1);', { 'vitest.setup.ts': setup, 'packages/beta/vitest.setup.ts': '', 'packages/beta/test/helpers/global-setup.ts': '' });

    expect(result.setups).toEqual(['packages/beta/vitest.setup.ts', 'vitest.setup.ts']);
    expect(result.findings.map((finding) => finding.site)).toEqual(['vitest.setup.ts:2']);
    expect(result.reaches).toMatchObject([{ site: 'vitest.setup.ts', dir: 'alpha', subpath: 'dist/s.js' }]);
  });

  it('throws when a listed file is one the parser never read', () => {
    expect(() => scanTestTree(root, graphOf('alpha', 'beta'), ['packages/beta/test/missing.test.ts'])).toThrow(/read back 0 of 1 scanned files; not read: packages\/beta\/test\/missing\.test\.ts/);
  });

  it('reports a file that does not parse, rather than skipping it', () => {
    expect(scan('const = ;').findings.map((finding) => finding.message.slice(0, 29))).toContain('does not parse, so the rule c');
  });

  it('ignores fixture and golden trees and non-source files', () => {
    const reached = "safePath.join(import.meta.dirname, '../../../../alpha/dist');";
    const result = scan('expect(1).toBe(1);', {
      'packages/beta/test/fixtures/p/a.test.ts': reached,
      'packages/beta/test/golden/b.ts': reached,
      'packages/beta/test/notes.md': reached,
    });

    expect(result.reaches).toEqual([]);
  });

  it('records relative imports between test-tree files, across packages, and the test entries', () => {
    const helper = 'packages/alpha/test/system/common.ts';
    const result = scan("import { x } from '../../alpha/test/system/common.js';\nimport { y } from 'vitest';", { [helper]: 'export const x = 1;' });

    expect(result.imports.get(SITE)).toEqual([helper]);
    expect(result.entries).toEqual([SITE]);
  });
});

describe('judgeScriptWord', () => {
  const graph = graphOf('alpha', 'beta');

  it.each([
    ['a sibling binary', '../alpha/dist/bin/vat.js', { reach: { dir: 'alpha', subpath: 'dist/bin/vat.js', open: false } }],
    ['its own output', 'dist/src/run.js', { reach: { dir: 'beta', subpath: 'dist/src/run.js', open: false } }],
    ['a word with no dist segment', 'build', undefined],
    ['an absolute path', '/opt/alpha/dist/x.js', undefined],
  ])('judges %s relative to the package directory', (_label, word, verdict) => {
    expect(judgeScriptWord(word, 'beta', graph)).toEqual(verdict);
  });

  it.each([
    ['a word the shell expands', '$DIR/dist/x.js', 'beta'],
    ['a relative word after a `cd`', 'dist/x.js', undefined],
    ['a dist segment spelled in another case', '../alpha/Dist/x.js', 'beta'],
    ['a word that lands on no package', '../../dist/x.js', 'beta'],
  ])('cannot judge %s', (_label, word, owner) => {
    expect(judgeScriptWord(word, owner, graph)).toHaveProperty('unresolved');
  });
});
