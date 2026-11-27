/**
 * The vendored TypeScript ships in the published `resources` tarball, and loads from it.
 *
 * `npm pack` is the authority on what ships (its glob and ignore semantics are npm's, not ours), so
 * this packs the real package, extracts the tarball into a fresh directory, and asserts its file
 * list: the copy, its typings, its licence and notice under `dist/vendor/`; no source map under any
 * `vendor/`; and none of the build's ignored `src/vendor/` copies (the `files` negations). Then it
 * runs the same spawned plain-`node` load as the load test, from the EXTRACTED package.
 *
 * Resolution from the extracted package: its `dist/vendored-typescript.js` imports `./parse-cache.js`,
 * which imports this package's runtime dependencies (`@vibe-agent-toolkit/utils`, `zod` and others).
 * The test gives the extracted package a real `node_modules` directory holding one link (a junction
 * on Windows) per dependency its own `package.json` declares, each to where Node would find that
 * dependency from the workspace package. It does not link the workspace `node_modules` wholesale:
 * where bun hoists the workspace dependencies differs by OS (on Windows they sit only in the root). Everything the probe loads from `resources` itself comes from
 * the tarball; the vendored file is reached by a relative path, so the `typescript` devDependency in
 * that `node_modules` cannot stand in for it. A host that cannot create links skips that one case,
 * visibly; the file-list cases need no link.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  createSymlink,
  isTreeChangeResidue,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { ARCHIVE_LIMITS, extractArchive } from '@vibe-agent-toolkit/utils/archive';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectProbeLoadsDeclaredVersion } from './vendored-typescript-probe.js';

/** The `resources` package directory: the package `npm pack` packs (selected by cwd). */
const PACKAGE_DIR = safePath.resolve(import.meta.dirname, '../..');

/**
 * The directory Node would resolve `name` to from the workspace package: the first `node_modules/<name>`
 * holding a `package.json`, walking up from the package. Walked by hand because a package's `exports`
 * map can hide its own `package.json` (and an ESM-only one has no `require` entry) from `require.resolve`.
 */
function installedDependencyDir(name: string): string {
  let dir = PACKAGE_DIR;
  for (;;) {
    const candidate = safePath.join(dir, 'node_modules', name);
    if (existsSync(safePath.join(candidate, 'package.json'))) return candidate;
    const parent = safePath.resolve(dir, '..');
    if (parent === dir) throw new Error(`dependency ${name} is not installed above ${PACKAGE_DIR}`);
    dir = parent;
  }
}

/**
 * Give the extracted package a `node_modules` of its own: a real directory with one link per declared
 * dependency. `typescript` is refused, so an npm copy can never satisfy the vendored loader.
 */
function linkDeclaredDependencies(
  cap: NonNullable<ReturnType<typeof symlinkCapability>>,
  extractedPackageDir: string,
): void {
  const manifest = JSON.parse(readFileSync(safePath.join(extractedPackageDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const names = Object.keys(manifest.dependencies ?? {});
  expect(names).not.toContain('typescript');
  for (const name of names) {
    const link = safePath.join(extractedPackageDir, 'node_modules', name);
    mkdirSyncReal(safePath.resolve(link, '..'), { recursive: true });
    createSymlink(cap, installedDependencyDir(name), link, 'junction');
  }
}

/** The files the vendored copy ships as, inside the tarball's `package/` root. */
const VENDORED_FILES = [
  'package/dist/vendor/typescript.cjs',
  'package/dist/vendor/typescript.d.cts',
  'package/dist/vendor/LICENSE.txt',
  'package/dist/vendor/ThirdPartyNoticeText.txt',
  'package/dist/vendor/ATTRIBUTION.md',
] as const;

/**
 * A temporary file `replaceFile` leaves beside `src/vendor/typescript.cjs` when a build is killed
 * mid-write (`.<base>.vat-staged-<random>`, a full ~9 MB copy). Planted before packing, so the
 * `files` negations are proven to keep such residue out of the tarball.
 */
const PLANTED_RESIDUE = '.typescript.cjs.vat-staged-0badc0de';

/** `npm pack --json`, reduced to the two fields read: the package name asserted, the tarball's file name. */
interface PackReport {
  readonly name: string;
  readonly filename: string;
}

let workDir = '';
let report: PackReport;
let entries: string[] = [];
/** Whether the extracted package was given its `node_modules` link (false: the host cannot link). */
let linked = false;

beforeAll(async () => {
  workDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-vendored-ts-pack-'));
  const residue = safePath.join(PACKAGE_DIR, 'src/vendor', PLANTED_RESIDUE);
  writeFileSync(residue, 'residue of a killed build\n');
  let stdout: string;
  try {
    stdout = safeExecSync('npm', ['pack', '--json', '--pack-destination', workDir], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } finally {
    rmSync(residue, { force: true });
  }
  const [first] = JSON.parse(stdout) as PackReport[];
  if (first === undefined) throw new Error(`npm pack --json reported nothing (stdout: ${stdout.slice(0, 500)})`);
  report = first;
  const extractDir = safePath.join(workDir, 'extracted');
  mkdirSyncReal(extractDir);
  const extracted = await extractArchive(
    { file: safePath.join(workDir, report.filename), side: 'source' },
    extractDir,
    { format: 'tar', limits: ARCHIVE_LIMITS },
  );
  entries = extracted.map((entry) => toForwardSlash(entry.name));
  const cap = symlinkCapability();
  if (cap !== null) {
    linkDeclaredDependencies(cap, safePath.join(extractDir, 'package'));
    linked = true;
  }
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('the published resources tarball', () => {
  it('is the resources package, and ships its build', () => {
    expect(report.name).toBe('@vibe-agent-toolkit/resources');
    expect(entries).toContain('package/dist/index.js');
    expect(entries).toContain('package/dist/vendored-typescript.js');
  });

  it('ships the vendored copy, its typings, its licence, its notice and its attribution under dist/vendor', () => {
    expect(entries).toEqual(expect.arrayContaining([...VENDORED_FILES]));
  });

  it('ships the copy byte-for-byte as the build wrote it to src/vendor', () => {
    const packed = readFileSync(safePath.join(workDir, 'extracted/package/dist/vendor/typescript.cjs'));
    expect(packed.equals(readFileSync(safePath.join(PACKAGE_DIR, 'src/vendor/typescript.cjs')))).toBe(true);
  });

  it('ships no source map under any vendor directory, and none of the ignored src/vendor copies', () => {
    expect(entries.filter((entry) => entry.includes('/vendor/') && entry.endsWith('.map'))).toEqual([]);
    expect(entries.filter((entry) => /^package\/src\/vendor\/(?:typescript\.cjs|[^/]+\.txt)$/.test(entry))).toEqual([]);
  });

  it('ships no temporary file a killed build left in src/vendor', () => {
    expect(isTreeChangeResidue(PLANTED_RESIDUE)).toBe(true);
    expect(entries.filter((entry) => entry.startsWith('package/src/vendor/') && isTreeChangeResidue(entry.slice(entry.lastIndexOf('/') + 1)))).toEqual([]);
  });

  it('loads from the extracted package on a main thread and in a worker, at the declared version', ({ skip }) => {
    if (!linked) skip('this host cannot create the node_modules link the extracted package resolves through');
    const loader = safePath.join(workDir, 'extracted/package/dist/vendored-typescript.js');
    expectProbeLoadsDeclaredVersion(loader, 'main');
    expectProbeLoadsDeclaredVersion(loader, 'worker');
  });
});
