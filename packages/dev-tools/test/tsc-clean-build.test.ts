import * as fs from 'node:fs';

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

import {
  discardStaging,
  prepareForBuild,
  promoteStagedEmit,
  pruneStaleEmit,
  parseArgs,
  stagingDir,
} from '../src/tsc-clean-build.js';

/* eslint-disable security/detect-non-literal-fs-filename -- test file with dynamic temp paths */

const EMPTY_MODULE = 'export {};';
const BARREL_JS = 'index.js';
const BUILDINFO = 'tsconfig.tsbuildinfo';
const REBUILT_BARREL = 'export const rebuilt = 1;';

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
    fs.writeFileSync(safePath.join(distDir, BARREL_JS), EMPTY_MODULE);
    fs.writeFileSync(safePath.join(distDir, 'index.d.ts.map'), 'not json');

    expect(pruneStaleEmit(tempDir)).toEqual([]);
    expect(fs.existsSync(safePath.join(distDir, BARREL_JS))).toBe(true);
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
    const buildinfo = safePath.join(tempDir, BUILDINFO);
    fs.writeFileSync(buildinfo, '{}');

    prepareForBuild(tempDir);

    expect(fs.existsSync(buildinfo)).toBe(true);
  });

  it('drops the tsbuildinfo when dist is missing, so tsc cannot skip a re-emit', () => {
    const buildinfo = safePath.join(tempDir, BUILDINFO);
    fs.writeFileSync(buildinfo, '{}');

    prepareForBuild(tempDir);

    expect(fs.existsSync(buildinfo)).toBe(false);
  });
});

/**
 * The compiler emits into `stagingDir(packageRoot)`; these write there directly so a
 * promotion can be exercised without paying for a real `tsc` run. The real thing is
 * covered end to end by `test/integration/dist-visibility.integration.test.ts`.
 */
function stage(packageRoot: string, relativePath: string, contents = EMPTY_MODULE): string {
  const file = safePath.join(stagingDir(packageRoot), relativePath);
  fs.mkdirSync(safePath.join(file, '..'), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function distPath(packageRoot: string, relativePath: string): string {
  return safePath.join(packageRoot, 'dist', relativePath);
}

/** Only run where the OS actually enforces directory permissions. */
const skipUnlessRealPermissions =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

describe('promoteStagedEmit', () => {
  const suite = setupSyncTempDirSuite('tsc-promote-staged');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('moves staged output into dist, creating the directories it needs', () => {
    stage(tempDir, BARREL_JS, 'export const promoted = 1;');
    stage(tempDir, 'deep/nested/module.js');

    const promoted = promoteStagedEmit(tempDir);

    expect(fs.readFileSync(distPath(tempDir, BARREL_JS), 'utf8')).toBe('export const promoted = 1;');
    expect(fs.existsSync(distPath(tempDir, 'deep/nested/module.js'))).toBe(true);
    expect(promoted).toHaveLength(2);
    // The staged copies are moved, not copied — nothing is left to promote twice.
    expect(fs.existsSync(safePath.join(stagingDir(tempDir), BARREL_JS))).toBe(false);
  });

  it('replaces an existing dist file by swapping the inode, never by truncating it', () => {
    emitGroup(tempDir, 'index', { withSource: true });
    const before = fs.statSync(distPath(tempDir, BARREL_JS)).ino;
    stage(tempDir, BARREL_JS, REBUILT_BARREL);

    promoteStagedEmit(tempDir);

    const after = fs.statSync(distPath(tempDir, BARREL_JS));
    expect(after.ino).not.toBe(before);
    expect(fs.readFileSync(distPath(tempDir, BARREL_JS), 'utf8')).toBe(REBUILT_BARREL);
  });

  it('promotes every barrel after the modules it re-exports, deepest path first', () => {
    for (const relativePath of [BARREL_JS, 'sub/index.js', 'sub/deep.js', 'module-0.js']) {
      stage(tempDir, relativePath);
    }

    const order = promoteStagedEmit(tempDir).map((file) =>
      safePath.relative(safePath.join(tempDir, 'dist'), file),
    );

    expect(order).toEqual(['sub/deep.js', 'module-0.js', 'sub/index.js', BARREL_JS]);
  });

  it('drops a staged tsbuildinfo rather than filing it where nothing looks for it', () => {
    stage(tempDir, BUILDINFO, '{}');
    stage(tempDir, BARREL_JS);

    const promoted = promoteStagedEmit(tempDir);

    expect(promoted).toHaveLength(1);
    expect(fs.existsSync(distPath(tempDir, BUILDINFO))).toBe(false);
  });

  it('does nothing when the compiler emitted nothing — an unchanged rebuild', () => {
    const live = emitGroup(tempDir, 'index', { withSource: true });
    const before = fs.statSync(live.js).mtimeMs;

    expect(promoteStagedEmit(tempDir)).toEqual([]);
    expect(fs.statSync(live.js).mtimeMs).toBe(before);
  });

  it.skipIf(skipUnlessRealPermissions)(
    'copies in place, loudly, when the rename keeps being refused',
    () => {
      // Stands in for the Windows hazard the retry exists for: a rename onto a
      // destination another process holds open fails EPERM/EBUSY there. An
      // unwritable dist directory is the POSIX way to make rename(2) keep failing.
      emitGroup(tempDir, 'index', { withSource: true });
      stage(tempDir, BARREL_JS, REBUILT_BARREL);
      const distDir = safePath.join(tempDir, 'dist');
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      fs.chmodSync(distDir, 0o500); // r-x: traversable, not writable

      // `mockRestore()` also resets the recorded calls, so read them before it runs.
      let warned = '';
      try {
        promoteStagedEmit(tempDir);
      } finally {
        fs.chmodSync(distDir, 0o700);
        warned = warn.mock.calls.map((call) => String(call[0])).join('');
        warn.mockRestore();
      }

      expect(fs.readFileSync(distPath(tempDir, BARREL_JS), 'utf8')).toBe(REBUILT_BARREL);
      expect(warned).toContain('copying in place instead');
    },
    30_000,
  );

  it('propagates a rename failure that no amount of waiting would clear', () => {
    fs.mkdirSync(distPath(tempDir, BARREL_JS), { recursive: true });
    fs.writeFileSync(distPath(tempDir, `${BARREL_JS}/occupant`), EMPTY_MODULE);
    stage(tempDir, BARREL_JS);

    expect(() => promoteStagedEmit(tempDir)).toThrow();
  });
});

describe('discardStaging', () => {
  const suite = setupSyncTempDirSuite('tsc-discard-staging');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('removes output a killed build left staged, so the next build cannot publish it', () => {
    stage(tempDir, BARREL_JS);

    discardStaging(tempDir);

    expect(fs.existsSync(stagingDir(tempDir))).toBe(false);
    expect(promoteStagedEmit(tempDir)).toEqual([]);
  });

  it('is a no-op when nothing was staged', () => {
    expect(() => {
      discardStaging(tempDir);
    }).not.toThrow();
  });

  it('stages beside dist, at the same depth, under a dot-prefixed name', () => {
    // All three are load-bearing: same filesystem (rename atomicity), same depth
    // (source-map `sources` and the default tsBuildInfoFile both stay valid), and
    // dot-prefixed (TypeScript wildcard includes skip dot directories).
    expect(safePath.relative(tempDir, stagingDir(tempDir))).toBe('.tsc-staging');
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
