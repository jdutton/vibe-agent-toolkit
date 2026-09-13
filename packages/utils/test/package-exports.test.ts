import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveFromImportMeta } from '../src/fs.js';
import { safePath, toForwardSlash } from '../src/path.js';

/**
 * A value in the `exports` map: either a bare target, or conditions.
 *
 * The fourteen compiled entries use `{types, import}` (ESM, emitted by `tsc`).
 * `./eslint` uses `{types, default}` — it is hand-written CommonJS, and `default`
 * rather than `import` is what lets both `require()` and `import` reach it.
 */
type ExportEntry = string | { types?: string; import?: string; default?: string };

interface Manifest {
  engines?: Record<string, string>;
  exports: Record<string, ExportEntry>;
  files?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function asConditions(entry: ExportEntry | undefined): { types?: string; import?: string; default?: string } {
  return typeof entry === 'object' ? entry : {};
}

const manifestPath = resolveFromImportMeta(import.meta.url, '..', 'package.json');
// eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from import.meta.url
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

/** What `files: ["dist"]` publishes. */
const distDir = resolveFromImportMeta(import.meta.url, '..', 'dist');

/**
 * The `src/` file a compiled output was emitted from.
 *
 * @param distRelative - Path of an output, relative to `dist/`, forward slashes
 * @returns The source path relative to `src/`, or `null` for a non-module file
 */
function sourceOf(distRelative: string): string | null {
  for (const suffix of ['.d.ts', '.js']) {
    if (distRelative.endsWith(suffix)) {
      return `${distRelative.slice(0, -suffix.length)}.ts`;
    }
  }
  return null;
}

/**
 * Compiled outputs that no source file backs.
 *
 * @param distRelatives - Every path under `dist/`, relative and forward-slashed
 * @param hasSource - Whether a `src/`-relative path exists
 * @returns The orphaned outputs, sorted, so a failure names them
 */
function orphanedOutputs(
  distRelatives: string[],
  hasSource: (srcRelative: string) => boolean,
): string[] {
  return distRelatives
    .filter((relative) => {
      const source = sourceOf(relative);
      return source !== null && !hasSource(source);
    })
    .sort((a, b) => a.localeCompare(b));
}

describe('utils package manifest', () => {
  it('declares the Node floor so adopters get an install-time signal', () => {
    expect(manifest.engines?.node).toBe('>=22.13.0');
  });

  it.each([
    ['.', 'index'],
    ['./path', 'path'],
    ['./fs', 'fs'],
    ['./text', 'text'],
    ['./process', 'process'],
    ['./git', 'git'],
    ['./glob', 'glob'],
    ['./zod', 'zod'],
    ['./yaml', 'yaml'],
    ['./testing', 'testing'],
    ['./asset', 'asset'],
    ['./crawl', 'crawl'],
    ['./project', 'project'],
  ])('exports %s from the %s entry module', (key, base) => {
    const entry = manifest.exports[key];
    expect(entry).toBeDefined();
    const conditions = asConditions(entry);
    expect(conditions.import).toBe(`./dist/${base}.js`);
    expect(conditions.types).toBe(`./dist/${base}.d.ts`);
  });

  /**
   * `./eslint` is the one entry that is NOT compiled from `src/`: it is
   * hand-written CommonJS shipped verbatim. It therefore breaks in ways the
   * `it.each` above cannot see — a `dist/` path here, or an `eslint` directory
   * missing from `files`, would both publish an entry that fails to resolve.
   */
  it('exports ./eslint from the shipped CommonJS rule pack, not from dist', () => {
    expect(asConditions(manifest.exports['./eslint']).default).toBe('./eslint/index.cjs');
  });

  /**
   * `.d.cts`, not `.d.ts`. Under `moduleResolution: node16`/`nodenext` TypeScript
   * matches the declaration's extension to the module format of the file it
   * describes, and `index.cjs` is CommonJS inside a `"type": "module"` package. A
   * `.d.ts` here would resolve for `bundler` users and fail for `nodenext` ones —
   * the split that makes this worth pinning rather than spot-checking.
   */
  it('ships hand-written types for ./eslint, in CommonJS declaration form', () => {
    expect(asConditions(manifest.exports['./eslint']).types).toBe('./eslint/index.d.cts');
  });

  it('ships the eslint directory in the tarball', () => {
    expect(manifest.files).toContain('eslint');
  });

  /**
   * ESLint is a peer, and an OPTIONAL one.
   *
   * Optional because an ESLint plugin is data rather than code that runs: the rule
   * modules export plain objects and never `require('eslint')`, so all fourteen
   * other code entries resolve fine with no ESLint anywhere in the tree. (Fourteen,
   * not fifteen: the map has 16 keys, and `./package.json` is a data file rather
   * than an entry point.) Without
   * `peerDependenciesMeta`, every consumer taking this package for `safePath.join()`
   * would get an unmet-peer warning for a package it will never load.
   */
  it('declares eslint as an optional peer dependency', () => {
    expect(manifest.peerDependencies?.['eslint']).toBe('>=9.0.0');
    expect(manifest.peerDependenciesMeta?.['eslint']?.optional).toBe(true);
  });

  // Adopters reach for this for version reporting, resolution assertions, and
  // "which build am I on?" checks. Without the explicit export, `require`/
  // `import` of it throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  it('exports ./package.json so adopters can read the manifest', () => {
    expect(manifest.exports['./package.json']).toBe('./package.json');
  });

  /**
   * The exports map is a published contract, so its key set is pinned rather than
   * only spot-checked: the `it.each` above proves each listed key points at the
   * right file, but says nothing about a key nobody listed. Adding an entry here
   * is cheap; removing one is a breaking change that needs a CHANGELOG note.
   *
   * **Pin the MEMBERS, never the count.** An adopter diffing two previews of this
   * package caught what our own review missed: the key count stayed at 14 across a
   * release in which `./project` went out and `./eslint` came in. A cardinality
   * assertion is satisfied by any swap; only the member list notices that the
   * occupants changed completely.
   *
   * `./project` was withdrawn and then restored, and the round trip is worth
   * recording. The withdrawal measured whether the four functions were USEFUL to
   * the package's primary real-world consumer, and they largely are not:
   * `findNodeWorkspaceRoot` returns `null` from every directory in that repo (no
   * `package.json` there carries a `"workspaces"` key — it is a pnpm workspace),
   * `findConfigFile` takes no filename parameter and every site there already
   * knows its own root, and `findProjectRoot`'s config-then-`.git` ladder
   * contradicts all six of that repo's own marker walk-ups.
   *
   * That was the wrong question. What decides whether an ENTRY should exist is how
   * heavy the only remaining door is. With `./project` gone the sole route to these
   * functions was the `.` barrel, which then reached five third-party packages —
   * so a consumer avoiding the barrel on graph-weight grounds (the entire premise
   * of this layout) could not reach a capability whose own code imports nothing but
   * `node:fs` and `node:path`. The functions are still VAT-shaped, and README.md
   * says so; the entry exists so that reaching them does not cost that graph.
   *
   * The barrel now reaches NO third-party package (`subpath-purity.test.ts` pins
   * that by equality), which does not retire the argument — it generalizes it.
   * Every domain that carries weight is an entry here, and the reason `./project`
   * came back is the reason `./crawl`, `./git`, `./process`, `./skill-test` and
   * `./yaml` exist: a capability's cost should be what it needs, not what its
   * neighbours need.
   */
  it('exports exactly the recorded key set', () => {
    expect(Object.keys(manifest.exports).sort((a, b) => a.localeCompare(b))).toEqual([
      '.',
      './asset',
      './crawl',
      './eslint',
      './fs',
      './git',
      './glob',
      './package.json',
      './path',
      './process',
      './project',
      './skill-test',
      './testing',
      './text',
      './yaml',
      './zod',
    ]);
  });

  /**
   * Every entry module must have a source file.
   *
   * This is the FORWARD direction — it iterates the keys the manifest declares.
   * It catches a key pointing at a module that was never written or was renamed
   * out from under it, and it cannot, by construction, catch a key that is GONE.
   * The reverse direction is `ships no compiled module whose source has been
   * withdrawn` below, and that is the one the `./project` incident needed.
   */
  it('every dist-backed entry resolves to a real source file', () => {
    const srcDir = resolveFromImportMeta(import.meta.url, '..', 'src');
    const DIST = './dist/';
    const missing: string[] = [];

    for (const [key, entry] of Object.entries(manifest.exports)) {
      const target = asConditions(entry).import;
      if (!target?.startsWith(DIST)) continue;
      const relative = `${target.slice(DIST.length, -'.js'.length)}.ts`;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from srcDir
      if (!existsSync(safePath.join(srcDir, relative))) missing.push(key);
    }

    expect(missing).toEqual([]);
  });

  /**
   * The tarball ships no room whose door is bricked up.
   *
   * `tsc --build --clean` cannot delete an output whose source is already gone —
   * the regenerated `.tsbuildinfo` no longer lists it — and the root's
   * `build:packages` runs a bare `tsc --build`, which emits into every package's
   * `dist/` without the `rimraf` the per-package script does. So a withdrawn
   * module leaves its compiled `.js` and `.d.ts` behind, and `files: ["dist"]`
   * then publishes a module with no source. That is exactly what happened when
   * `./project` was withdrawn: the key left the manifest, `dist/project.js` kept
   * shipping, and the tarball carried it for a full release cycle. An adopter
   * found it, not us.
   *
   * ⛔ The forward test above could never have found it. It walks the keys that
   * EXIST, and a withdrawal is precisely the absence of a key — the incident is
   * structurally invisible from that side. This test asks the opposite question,
   * of the artifact rather than of the manifest, so it needs no list of what
   * used to be there and has nothing to keep in sync. It sees the withdrawal of
   * an internal module too, not only of an exported entry: `src/template.ts`,
   * `src/template-entry.ts` and all of `src/link-auth/` left in this same
   * release, and only one of them was ever an export key.
   */
  it('ships no compiled module whose source has been withdrawn', () => {
    const srcDir = resolveFromImportMeta(import.meta.url, '..', 'src');
    expect(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from import.meta.url
      existsSync(distDir),
      `${distDir} does not exist — build the package before running this test`,
    ).toBe(true);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from import.meta.url
    const outputs = readdirSync(distDir, { recursive: true, withFileTypes: false })
      .map((entry) => toForwardSlash(String(entry)));

    const orphans = orphanedOutputs(outputs, (relative) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from srcDir
      existsSync(safePath.join(srcDir, relative)),
    );

    expect(orphans).toEqual([]);
  });
});

/**
 * The detector above, exercised on inputs it can be given deliberately.
 *
 * Reading the real `dist/` proves the package is currently clean; it cannot
 * prove the reading would notice if it were not, because a correct build leaves
 * nothing to notice. These cases supply the orphan the filesystem will not.
 */
describe('orphanedOutputs', () => {
  it('reports both artifacts of a module whose source is gone', () => {
    expect(
      orphanedOutputs(
        ['path.js', 'path.d.ts', 'template.js', 'template.d.ts'],
        (relative) => relative === 'path.ts',
      ),
    ).toEqual(['template.d.ts', 'template.js']);
  });

  it('reports a withdrawn module nested in a subdirectory', () => {
    expect(orphanedOutputs(['link-auth/resolve.js'], () => false)).toEqual([
      'link-auth/resolve.js',
    ]);
  });

  it('reports nothing when every output is backed by a source file', () => {
    expect(orphanedOutputs(['fs.js', 'fs.d.ts'], () => true)).toEqual([]);
  });

  it('leaves source maps to the module they belong to', () => {
    // A map is not a module: flagging `template.js` already names the problem,
    // and `.js.map` / `.d.ts.map` have no `.ts` of their own to look for.
    expect(orphanedOutputs(['template.js.map', 'template.d.ts.map'], () => false)).toEqual([]);
  });
});
