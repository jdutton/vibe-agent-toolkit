/**
 * The test-tree scan reads syntax, not spelling: a path counts where a call
 * builds and uses it, however it is spelled, and nowhere else. The real-tree
 * case pins reaches the repository is known to have, so a spelling the scan
 * stops recognising is a red here rather than a silently smaller population.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workingTreePackageFiles } from '../src/built-output-edges.js';
import { scanTestTree } from '../src/built-output-scan.js';
import { PROJECT_ROOT } from '../src/common.js';
import { readWorkspaceGraph, type WorkspaceGraph, type WorkspacePackage } from '../src/workspace-graph.js';

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

describe('scanTestTree on fixture sources', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir({ prefix: 'built-output-scan-' });
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  const scan = (text: string, extra: Record<string, string> = {}): ReturnType<typeof scanTestTree> =>
    scanTestTree(root, graphOf('alpha', 'beta'), writeFiles(root, { [SITE]: text, ...extra }));

  it.each([
    ['a ../ literal in resolve', "spawn(NODE, [safePath.resolve(here, '../../../alpha/dist/bin.js')]);", 'dist/bin.js'],
    ['an aliased resolver', "const BIN = pathResolve(here, '../../../alpha/dist/bin.js');", 'dist/bin.js'],
    ['repo-rooted segments',"safePath.join(root, 'packages', 'alpha', 'dist');", 'dist'],
    ['a multi-hop segment before the package', "safePath.join(here, '../../..', 'alpha', 'dist', 'x.js');", 'dist/x.js'],
    ['a joined package segment', "safePath.join(root, 'packages/alpha', 'dist');", 'dist'],
    ['a template literal', 'execFileSync(`${root}/packages/alpha/dist/x.js`);', 'dist/x.js'],
    ['a same-file const', "const DIR = 'packages/alpha/dist';\nconst BIN = safePath.join(root, DIR, 'bin.js');", 'dist/bin.js'],
    ['a const of a const', "const UP = '../../..';\nconst BIN = `${UP}/alpha/dist/a.js`;\nspawnSync(NODE, [BIN]);", 'dist/a.js'],
    ['new URL', "const URL_ = new URL('../../../alpha/dist/x.js', import.meta.url).href;", 'dist/x.js'],
    ['vi.mock', "vi.mock('../../alpha/dist/y.js', () => ({}));", 'dist/y.js'],
    ['a dynamic import', "await import('../../../alpha/dist/z.js');", 'dist/z.js'],
    ['an unknown tail', "safePath.join(root, 'packages', 'alpha', 'dist', name, 'x');", 'dist'],
  ])('counts %s', (_label, text, subpath) => {
    expect(scan(text).reaches).toEqual([{ site: SITE, dir: 'alpha', subpath }]);
  });

  it.each([
    ['a comment', "// safePath.join(root, 'packages/alpha/dist')\n/* spawn('../../alpha/dist/x') */"],
    ['plain test data', "expect(filter('packages/alpha/dist/index.js')).toBe(false);"],
    ['a path no call uses', "const NEEDLE = '../../alpha/dist/x.js';\nexpect(urls).toContain(NEEDLE);"],
    ['a temp tree', "safePath.join(tempDir, 'dist', 'bin');"],
    ['a package-relative dist', "pathResolve(testDir, '../../dist/bin.js');"],
    ['a directory that is not a package', "safePath.join(root, 'packages', 'nope', 'dist');"],
  ])('ignores %s', (_label, text) => {
    expect(scan(text)).toMatchObject({ reaches: [], unresolved: [] });
  });

  it('ignores fixture and golden trees and non-source files', () => {
    const reached = "safePath.join(root, 'packages', 'alpha', 'dist');";
    const result = scan('expect(1).toBe(1);', {
      'packages/beta/test/fixtures/p/a.test.ts': reached,
      'packages/beta/test/golden/b.ts': reached,
      'packages/beta/test/notes.md': reached,
    });

    expect(result.reaches).toEqual([]);
  });

  it('reports a dist path whose package segment is not static', () => {
    const result = scan("const PACKAGES = safePath.join(ROOT, '..');\nsafePath.join(PACKAGES, bundle.pkg, 'dist', 'skills');");

    expect(result.reaches).toEqual([]);
    expect(result.unresolved).toEqual([{ site: SITE, expression: "safePath.join(PACKAGES, bundle.pkg, 'dist', 'skills')" }]);
  });

  it('records relative imports between test-tree files, across packages, and the test entries', () => {
    const helper = 'packages/alpha/test/system/common.ts';
    const result = scan("import { x } from '../../alpha/test/system/common.js';\nimport { y } from 'vitest';", { [helper]: 'export const x = 1;' });

    expect(result.imports.get(SITE)).toEqual([helper]);
    expect(result.entries).toEqual([SITE]);
  });
});

describe('scanTestTree on the real tree', () => {
  const result = scanTestTree(PROJECT_ROOT, readWorkspaceGraph(PROJECT_ROOT), workingTreePackageFiles(PROJECT_ROOT));

  it('finds the reaches this repository is known to have', () => {
    expect(result.reaches).toEqual(
      expect.arrayContaining([
        { site: 'packages/rag-lancedb/test/system/cli-dogfooding.system.test.ts', dir: 'cli', subpath: 'dist/bin.js' },
        { site: 'packages/resources/test/system/external-url-validation.system.test.ts', dir: 'cli', subpath: 'dist/bin/vat.js' },
        { site: 'packages/resources/test/integration/git-crawl-io-cost.integration.test.ts', dir: 'lab', subpath: 'dist/facets/io/counter.cjs' },
        { site: 'packages/vat-development-agents/test/system/packaged-output-drift.system.test.ts', dir: 'vat-development-agents', subpath: 'dist/skills' },
        { site: 'packages/vat-development-agents/test/system/packaged-output-drift.system.test.ts', dir: 'vat-example-cat-agents', subpath: 'dist/skills' },
        { site: 'packages/cli/test/system/test-common.ts', dir: 'utils', subpath: 'dist/testing/fault-fs-preload.js' },
      ]),
    );
  });

  it('reads no reach in plain test data, and no dist path it cannot resolve', () => {
    expect(result.reaches.filter((reach) => reach.site === 'packages/discovery/test/pattern-filter.test.ts')).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});
