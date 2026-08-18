import * as fs from 'node:fs';

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { prepareForBuild, pruneStaleEmit, parseArgs } from '../src/tsc-clean-build.js';

/* eslint-disable security/detect-non-literal-fs-filename -- test file with dynamic temp paths */

const EMPTY_MODULE = 'export {};';

/** Writes the four-file group tsc emits for one source module, plus its source. */
function emitGroup(
  packageRoot: string,
  name: string,
  options: { withSource: boolean; sourceRelative?: string },
): { js: string; declaration: string } {
  const distDir = safePath.join(packageRoot, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const sourceRelative = options.sourceRelative ?? `../src/${name}.ts`;

  const js = safePath.join(distDir, `${name}.js`);
  const declaration = safePath.join(distDir, `${name}.d.ts`);
  fs.writeFileSync(js, EMPTY_MODULE);
  fs.writeFileSync(safePath.join(distDir, `${name}.js.map`), '{}');
  fs.writeFileSync(declaration, EMPTY_MODULE);
  fs.writeFileSync(
    safePath.join(distDir, `${name}.d.ts.map`),
    JSON.stringify({ version: 3, file: `${name}.d.ts`, sources: [sourceRelative], mappings: '' }),
  );

  if (options.withSource) {
    const source = safePath.resolve(distDir, sourceRelative);
    fs.mkdirSync(safePath.join(source, '..'), { recursive: true });
    fs.writeFileSync(source, EMPTY_MODULE);
  }
  return { js, declaration };
}

describe('pruneStaleEmit', () => {
  const suite = setupSyncTempDirSuite('tsc-clean-build');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('removes the whole emit group for a source that no longer exists', () => {
    const orphan = emitGroup(tempDir, 'orphaned-from-deleted-source', { withSource: false });

    const removed = pruneStaleEmit(tempDir);

    expect(fs.existsSync(orphan.js)).toBe(false);
    expect(fs.existsSync(orphan.declaration)).toBe(false);
    expect(removed).toHaveLength(4);
  });

  it('keeps output whose source still exists', () => {
    const live = emitGroup(tempDir, 'index', { withSource: true });

    expect(pruneStaleEmit(tempDir)).toEqual([]);
    expect(fs.existsSync(live.js)).toBe(true);
  });

  it('prunes only the dead group when live and dead output sit side by side', () => {
    const live = emitGroup(tempDir, 'index', { withSource: true });
    const orphan = emitGroup(tempDir, 'removed', { withSource: false });

    pruneStaleEmit(tempDir);

    expect(fs.existsSync(live.js)).toBe(true);
    expect(fs.existsSync(orphan.js)).toBe(false);
  });

  it('leaves output that no declaration map claims — later build steps write into dist too', () => {
    const distDir = safePath.join(tempDir, 'dist');
    fs.mkdirSync(safePath.join(distDir, 'bin'), { recursive: true });
    // prepare-bin.ts's extensionless shim, copy-yaml-assets.ts's assets, and the
    // JSON schemas generate:schemas writes all land here after tsc has run.
    const shim = safePath.join(distDir, 'bin', 'vat');
    const asset = safePath.join(distDir, 'template.yaml');
    const schema = safePath.join(distDir, 'resource.schema.json');
    for (const file of [shim, asset, schema]) fs.writeFileSync(file, 'x');

    expect(pruneStaleEmit(tempDir)).toEqual([]);
    for (const file of [shim, asset, schema]) expect(fs.existsSync(file)).toBe(true);
  });

  it('leaves output alone when the declaration map is unreadable rather than guessing', () => {
    const distDir = safePath.join(tempDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(safePath.join(distDir, 'index.js'), EMPTY_MODULE);
    fs.writeFileSync(safePath.join(distDir, 'index.d.ts.map'), 'not json');

    expect(pruneStaleEmit(tempDir)).toEqual([]);
    expect(fs.existsSync(safePath.join(distDir, 'index.js'))).toBe(true);
  });

  it('is a no-op when dist does not exist', () => {
    expect(pruneStaleEmit(tempDir)).toEqual([]);
  });

  it('does not touch files outside dist', () => {
    const source = safePath.join(tempDir, 'src-marker.ts');
    fs.writeFileSync(source, 'export const x = 1;');
    emitGroup(tempDir, 'gone', { withSource: false });

    pruneStaleEmit(tempDir);

    expect(fs.existsSync(source)).toBe(true);
  });
});

describe('prepareForBuild', () => {
  const suite = setupSyncTempDirSuite('tsc-prepare-build');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('never deletes dist — a concurrent reader must keep seeing the previous build', () => {
    const live = emitGroup(tempDir, 'index', { withSource: true });

    prepareForBuild(tempDir);

    expect(fs.existsSync(safePath.join(tempDir, 'dist'))).toBe(true);
    expect(fs.existsSync(live.js)).toBe(true);
  });

  it('keeps the tsbuildinfo when dist is present, so an unchanged rebuild rewrites nothing', () => {
    emitGroup(tempDir, 'index', { withSource: true });
    const buildinfo = safePath.join(tempDir, 'tsconfig.tsbuildinfo');
    fs.writeFileSync(buildinfo, '{}');

    prepareForBuild(tempDir);

    expect(fs.existsSync(buildinfo)).toBe(true);
  });

  it('drops the tsbuildinfo when dist is missing, so tsc cannot skip a re-emit', () => {
    const buildinfo = safePath.join(tempDir, 'tsconfig.tsbuildinfo');
    fs.writeFileSync(buildinfo, '{}');

    prepareForBuild(tempDir);

    expect(fs.existsSync(buildinfo)).toBe(false);
  });
});

describe('parseArgs', () => {
  it('defaults to the tsc compiler with no flags', () => {
    expect(parseArgs([])).toEqual({ compiler: 'tsc', compilerArgs: [] });
  });

  it('passes through compiler args unchanged', () => {
    expect(parseArgs(['--pretty'])).toEqual({ compiler: 'tsc', compilerArgs: ['--pretty'] });
  });

  it('extracts a --compiler= flag and strips it from the passed-through args', () => {
    expect(parseArgs(['--compiler=tspc', '--pretty'])).toEqual({
      compiler: 'tspc',
      compilerArgs: ['--pretty'],
    });
  });

  it("refuses --build, which emits into other packages' dist outside turbo's ordering", () => {
    expect(() => parseArgs(['--build'])).toThrow(/--build/);
  });
});
