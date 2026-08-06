import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveFromImportMeta } from '../src/fs.js';

type ExportEntry = string | { types: string; import: string };

interface Manifest {
  engines?: Record<string, string>;
  exports: Record<string, ExportEntry>;
}

function asConditions(entry: ExportEntry | undefined): { types?: string; import?: string } {
  return typeof entry === 'object' ? entry : {};
}

const manifestPath = resolveFromImportMeta(import.meta.url, '..', 'package.json');
// eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from import.meta.url
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

describe('utils package manifest', () => {
  it('declares the Node floor so adopters get an install-time signal', () => {
    expect(manifest.engines?.node).toBe('>=22.0.0');
  });

  it.each([
    ['.', 'index'],
    ['./path', 'path'],
    ['./fs', 'fs'],
    ['./process', 'process'],
    ['./git', 'git'],
    ['./glob', 'glob'],
    ['./zod', 'zod'],
    ['./template', 'template-entry'],
    ['./yaml', 'yaml'],
    ['./testing', 'testing'],
    ['./asset', 'asset'],
    ['./crawl', 'crawl'],
  ])('exports %s from the %s entry module', (key, base) => {
    const entry = manifest.exports[key];
    expect(entry).toBeDefined();
    const conditions = asConditions(entry);
    expect(conditions.import).toBe(`./dist/${base}.js`);
    expect(conditions.types).toBe(`./dist/${base}.d.ts`);
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
   * `./project` was removed deliberately. Validating against the package's primary
   * real-world consumer found ZERO replaceable call sites for its four exports:
   * `findNodeWorkspaceRoot` returns `null` from every directory in that repo (no
   * `package.json` there carries a `"workspaces"` key — it is a pnpm workspace),
   * `findConfigFile` takes no filename parameter and every site there already
   * knows its own root, and `findProjectRoot`'s config-then-`.git` ladder
   * contradicts all six of that repo's own marker walk-ups — one of which is a
   * published runtime package, where depending on `.git` would be a bug. The two
   * sites that genuinely want a `.git` walk-up are served by `gitFindRoot` on
   * `./git`. The functions remain on the `.` barrel for VAT's own internals.
   */
  it('exports exactly the recorded key set', () => {
    expect(Object.keys(manifest.exports).sort((a, b) => a.localeCompare(b))).toEqual([
      '.',
      './asset',
      './crawl',
      './fs',
      './git',
      './glob',
      './package.json',
      './path',
      './process',
      './template',
      './testing',
      './yaml',
      './zod',
    ]);
  });

  it('no longer exports ./project — its four functions stay on the `.` barrel', () => {
    expect(manifest.exports['./project']).toBeUndefined();
  });
});
