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
    ['./project', 'project'],
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
});
