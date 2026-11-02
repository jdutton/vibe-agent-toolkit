/**
 * The `memory` facet's RSS probe, run the only way it ever runs: `--require`d
 * into a real node child. The tests run the BUILT `dist/facets/memory/rss-probe.cjs`,
 * because the emitted file is the artifact that ships.
 *
 * Each size assertion is a DIFFERENCE against a no-allocation baseline launched
 * the same way, never an absolute bound: a bare node's own footprint differs by
 * platform and version. That the parent's memory is NOT in the figure — the one
 * thing `maxRSS` got wrong on Linux — is pinned on its own below.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { type RssDump, RssDumpSchema } from '../../src/facets/memory/types.js';

/** The emitted probe. */
const PROBE_DIST = toForwardSlash(fileURLToPath(new URL('../../dist/facets/memory/rss-probe.cjs', import.meta.url)));

/** The CLI package's name: a main script it owns is vat. */
const CLI_PACKAGE = '@vibe-agent-toolkit/cli';

/** The activation variable `capture.ts` sets — pinned against the probe's own below. */
const LOG_DIR_ENV = 'VAT_LAB_RSS_LOG';

/** Kilobytes in a mebibyte. */
const MIB_KB = 1024;

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A fresh scratch directory, removed after the suite. */
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * Write `source` as a main script at `relativePath` inside a package named `name`.
 *
 * @param name - The owning `package.json`'s name, or null for a script no package owns
 * @param relativePath - Where the script sits inside the package
 * @param source - The script
 * @returns The script's path
 */
function mainScript(name: string | null, relativePath: string, source: string): string {
  const root = scratchDir('lab-rss-package-');
  if (name !== null) writeFileSync(safePath.join(root, 'package.json'), JSON.stringify({ name }));
  const script = safePath.join(root, relativePath);
  mkdirSyncReal(safePath.join(script, '..'), { recursive: true });
  writeFileSync(script, source);
  return script;
}

/**
 * The environment that switches the probe on into `dir` — or leaves it inert.
 *
 * @param dir - The dump directory, or `undefined` for none
 * @returns The child's environment
 */
function probeEnv(dir: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require "${PROBE_DIST}"` };
  delete env[LOG_DIR_ENV];
  if (dir !== undefined) env[LOG_DIR_ENV] = dir;
  return env;
}

/** Every dump in `dir`, parsed. */
function dumpsIn(dir: string): RssDump[] {
  return readdirSync(dir).map((name) => RssDumpSchema.parse(JSON.parse(readFileSync(safePath.join(dir, name), 'utf-8'))));
}

/**
 * Run a main script in a child with the probe preloaded.
 *
 * @param script - The child's main script, or `['-e', source]`
 * @param logDir - `''` for a fresh dump directory, or `undefined` to leave the probe inert
 * @returns The dump files' parsed contents
 */
function runWithProbe(script: string | readonly string[], logDir: '' | undefined): RssDump[] {
  const dir = scratchDir('lab-rss-probe-');
  const child = typeof script === 'string' ? [script] : [...script];
  const result = spawnSync(NODE_EXECUTABLE, child, { env: probeEnv(logDir === undefined ? undefined : dir), encoding: 'utf-8' });
  expect(result.status, result.stderr).toBe(0);
  return dumpsIn(dir);
}

/**
 * Source that allocates and fills N MiB, so the pages are resident rather than merely reserved.
 *
 * @param mib - How much
 * @returns A script fragment
 */
function allocate(mib: number): string {
  return `globalThis.kept = Buffer.alloc(${String(mib)} * 1024 * 1024, 1);`;
}

/**
 * The one peak a CLI-owned main script writes.
 *
 * @param source - What the script runs
 * @returns Its peak
 */
function vatPeakKb(source: string): number {
  const dumps = runWithProbe(mainScript(CLI_PACKAGE, 'dist/bin.js', source), '');
  expect(dumps, 'vat dumps').toHaveLength(1);
  return dumps[0]?.maxRssKb ?? 0;
}

/**
 * The peak of a vat stand-in started the way `npx` and a shell start vat: by a
 * node parent holding `parentMib` MiB, through `sh -c 'exec node …'`.
 *
 * @param parentMib - What the parent holds, resident, before it launches
 * @returns The stand-in's peak
 */
function peakUnderParentKb(parentMib: number): number {
  const vat = mainScript(CLI_PACKAGE, 'dist/bin.js', allocate(20));
  const dir = scratchDir('lab-rss-parent-');
  const parent =
    `${allocate(parentMib)}` +
    "const r = require('node:child_process').spawnSync('sh', ['-c', 'exec \"$0\" \"$1\"', process.execPath, process.argv[1]], " +
    "{ stdio: 'inherit', env: JSON.parse(process.env.CHILD_ENV) });" +
    'process.exitCode = r.status ?? 1;';
  // The parent itself runs without the probe: only the child gets it, through CHILD_ENV.
  const result = spawnSync(NODE_EXECUTABLE, ['-e', parent, vat], {
    env: { ...process.env, CHILD_ENV: JSON.stringify(probeEnv(dir)) },
    encoding: 'utf-8',
  });
  expect(result.status, result.stderr).toBe(0);
  const dumps = dumpsIn(dir);
  expect(dumps, 'vat dumps').toHaveLength(1);
  return dumps[0]?.maxRssKb ?? 0;
}

describe('the RSS probe', () => {
  it('writes one schema-valid vat dump whose peak rises by what the process allocated', () => {
    const baseline = vatPeakKb('');
    const allocated = vatPeakKb(allocate(200));

    expect(allocated - baseline).toBeGreaterThan(180 * MIB_KB);
  });

  it('counts a worker thread\'s memory in its process, and writes no second dump for the worker', () => {
    // The main thread allocates nothing; only the worker does. A probe that
    // missed workers reports a bare node's peak; one that let the worker dump
    // too writes two vat files (`vatPeakKb` asserts exactly one).
    const worker = (source: string): string =>
      "const { Worker } = require('node:worker_threads');" +
      `new Worker(${JSON.stringify(source + ' setTimeout(() => {}, 50);')}, { eval: true });`;
    const baseline = vatPeakKb(worker(''));
    const allocated = vatPeakKb(worker(allocate(300)));

    expect(allocated - baseline).toBeGreaterThan(270 * MIB_KB);
  });

  /**
   * The Linux defect this figure exists to avoid: `maxRSS` survives `exec`, and a forked child
   * starts with its parent's resident set, so a vat launched by a 300 MiB parent read as 300 MiB
   * or more. `VmHWM` belongs to the exec'd image alone. Needs `sh`, so not on Windows, which
   * creates a process rather than forking one; on macOS it is the measured reason the lab needs
   * no bare-node launcher there either.
   */
  it.skipIf(process.platform === 'win32')('is independent of what the parent held (Linux and macOS: sh -c exec)', () => {
    const small = peakUnderParentKb(0);
    const large = peakUnderParentKb(300);

    expect(Math.abs(large - small)).toBeLessThan(50 * MIB_KB);
  });

  it('counts a published build\'s bins as vat, with nothing asked of the build', () => {
    // The two installed shapes, as any published version lays them out: the
    // launcher package's `bin/vat`, and the CLI's own wrapper under node_modules.
    const launcher = mainScript('vibe-agent-toolkit', 'bin/vat', allocate(1));
    const wrapper = mainScript(CLI_PACKAGE, 'dist/bin/vat.js', allocate(1));

    expect(runWithProbe(launcher, '')).toHaveLength(1);
    expect(runWithProbe(wrapper, '')).toHaveLength(1);
  });

  it('counts vat reached through a link, as npm\'s .bin/vat is', ({ skip }) => {
    const real = mainScript(CLI_PACKAGE, 'dist/bin/vat.js', allocate(1));
    const link = safePath.join(scratchDir('lab-rss-bin-'), 'vat');
    createSymlink(symlinkCapability() ?? skip(), real, link, 'file');

    expect(runWithProbe(link, '')).toHaveLength(1);
  });

  it('writes nothing for an npm-like main script, a script no package owns, or node -e', () => {
    expect(runWithProbe(mainScript('npm', 'bin/npm-cli.js', allocate(1)), '')).toEqual([]);
    expect(runWithProbe(mainScript(null, 'loose.js', allocate(1)), '')).toEqual([]);
    expect(runWithProbe(['-e', allocate(1)], '')).toEqual([]);
  });

  it('writes nothing for a node child vat spawns, though it inherits the probe', () => {
    const vat = mainScript(
      CLI_PACKAGE,
      'dist/bin.js',
      "require('node:child_process').spawnSync(process.execPath, ['-e', '0'], { stdio: 'inherit' });",
    );

    expect(runWithProbe(vat, '')).toHaveLength(1);
  });

  it('is inert without its variable', () => {
    expect(runWithProbe(mainScript(CLI_PACKAGE, 'dist/bin.js', allocate(1)), undefined)).toEqual([]);
  });

  it('activates on exactly the variable the capture sets', () => {
    const probe = createRequire(import.meta.url)(PROBE_DIST) as { __internals: { LOG_DIR_ENV: string } };

    expect(probe.__internals.LOG_DIR_ENV).toBe(LOG_DIR_ENV);
  });

  it('requires nothing but node builtins — it runs inside an npx vat', () => {
    const required = requiredBy(PROBE_DIST);

    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => name?.startsWith('node:') !== true)).toEqual([]);
  });
});

/**
 * The `require()` specifiers a built file names, comments stripped.
 *
 * @param file - An emitted `.cjs`
 * @returns Every specifier, in order
 */
function requiredBy(file: string): (string | undefined)[] {
  const source = readFileSync(file, 'utf-8').replaceAll(/\/\*[\S\s]*?\*\//g, '');
  return [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
}
