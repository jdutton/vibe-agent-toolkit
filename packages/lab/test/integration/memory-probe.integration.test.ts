/**
 * The `memory` facet's RSS probe, run the only way it ever runs: `--require`d
 * into a real node child. The tests run the BUILT `dist/facets/memory/rss-probe.cjs`,
 * because the emitted file is the artifact that ships.
 *
 * Each size assertion is a DIFFERENCE against a no-allocation baseline launched
 * the same way, never an absolute bound: on Linux a child's peak includes what
 * its parent held at `fork()`, so "more than 300 MiB" passes for a child of any
 * large parent — a vitest worker is one — whether or not the probe saw the
 * allocation. Both runs go through the built spawner, as a capture's do.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { type RssDump, RssDumpSchema } from '../../src/facets/memory/types.js';

/** The emitted probe. */
const PROBE_DIST = toForwardSlash(fileURLToPath(new URL('../../dist/facets/memory/rss-probe.cjs', import.meta.url)));

/** The emitted spawner, every measured repeat's parent. */
const SPAWNER_DIST = toForwardSlash(fileURLToPath(new URL('../../dist/facets/memory/rss-spawner.js', import.meta.url)));

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
 * Run a main script in a child with the probe preloaded.
 *
 * @param script - The child's main script, or `['-e', source]`
 * @param logDir - The dump directory, or `undefined` to leave the probe inert
 * @param viaSpawner - Launch the child through the built spawner, as a capture does
 * @returns The dump files' parsed contents
 */
function runWithProbe(script: string | readonly string[], logDir: string | undefined, viaSpawner = false): RssDump[] {
  const dir = scratchDir('lab-rss-probe-');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require "${PROBE_DIST}"` };
  delete env[LOG_DIR_ENV];
  if (logDir !== undefined) env[LOG_DIR_ENV] = logDir === '' ? dir : logDir;
  const child = typeof script === 'string' ? [script] : [...script];
  const argv = viaSpawner ? [SPAWNER_DIST, 'direct', NODE_EXECUTABLE, ...child] : child;
  const result = spawnSync(NODE_EXECUTABLE, argv, { env, encoding: 'utf-8' });
  expect(result.status, result.stderr).toBe(0);
  return readdirSync(dir).map((name) => RssDumpSchema.parse(JSON.parse(readFileSync(safePath.join(dir, name), 'utf-8'))));
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
 * The vat-role peak of a CLI-owned main script, launched through the spawner.
 *
 * @param source - What the script runs
 * @returns Its peak, and the spawner's
 */
function peaksViaSpawner(source: string): { vatKb: number; spawnerKb: number } {
  const dumps = runWithProbe(mainScript(CLI_PACKAGE, 'dist/bin.js', source), '', true);
  const of = (role: 'vat' | 'spawner'): number => {
    const found = dumps.filter((dump) => dump.role === role);
    expect(found, `${role} dumps`).toHaveLength(1);
    return found[0]?.maxRssKb ?? 0;
  };
  return { vatKb: of('vat'), spawnerKb: of('spawner') };
}

/** The roles a run's dumps carry. */
function rolesOf(dumps: readonly RssDump[]): string[] {
  return dumps.map((dump) => dump.role);
}

describe('the RSS probe', () => {
  it('writes one schema-valid vat dump whose peak rises by what the process allocated', () => {
    const baseline = peaksViaSpawner('');
    const allocated = peaksViaSpawner(allocate(200));

    expect(allocated.vatKb - baseline.vatKb).toBeGreaterThan(180 * MIB_KB);
  });

  it('counts a worker thread\'s memory in its process, and writes no second dump for the worker', () => {
    // The main thread allocates nothing; only the worker does. A probe that
    // missed workers reports a bare node's peak; one that let the worker dump
    // too writes two vat files (`peaksViaSpawner` asserts exactly one).
    const worker = (source: string): string =>
      "const { Worker } = require('node:worker_threads');" +
      `new Worker(${JSON.stringify(source + ' setTimeout(() => {}, 50);')}, { eval: true });`;
    const baseline = peaksViaSpawner(worker(''));
    const allocated = peaksViaSpawner(worker(allocate(300)));

    expect(allocated.vatKb - baseline.vatKb).toBeGreaterThan(270 * MIB_KB);
  });

  it('gives the spawner\'s child the spawner\'s floor, not the parent\'s resident set', () => {
    // This vitest worker is the spawner's parent. Holding 400 MiB here must not
    // reach the spawner's child: that is the whole reason the spawner exists.
    const held = Buffer.alloc(400 * MIB_KB * 1024, 1);
    const { vatKb } = peaksViaSpawner('');

    expect(held.length).toBeGreaterThan(0);
    expect(vatKb).toBeLessThan(400 * MIB_KB);
  });

  it('counts a published build\'s bins as vat, with nothing asked of the build', () => {
    // The two installed shapes, as any published version lays them out: the
    // launcher package's `bin/vat`, and the CLI's own wrapper under node_modules.
    const launcher = mainScript('vibe-agent-toolkit', 'bin/vat', allocate(1));
    const wrapper = mainScript(CLI_PACKAGE, 'dist/bin/vat.js', allocate(1));

    expect(rolesOf(runWithProbe(launcher, ''))).toEqual(['vat']);
    expect(rolesOf(runWithProbe(wrapper, ''))).toEqual(['vat']);
  });

  it('counts vat reached through a link, as npm\'s .bin/vat is', ({ skip }) => {
    const real = mainScript(CLI_PACKAGE, 'dist/bin/vat.js', allocate(1));
    const link = safePath.join(scratchDir('lab-rss-bin-'), 'vat');
    createSymlink(symlinkCapability() ?? skip(), real, link, 'file');

    expect(rolesOf(runWithProbe(link, ''))).toEqual(['vat']);
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

    expect(rolesOf(runWithProbe(vat, ''))).toEqual(['vat']);
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

describe('the RSS spawner', () => {
  it('imports only the exit-code and process contracts, never the utils barrel — its footprint is the floor', () => {
    const source = readFileSync(SPAWNER_DIST, 'utf-8');
    const required = [...source.matchAll(/^import .* from ["']([^"']+)["'];$/gm)]
      .map((match) => match[1])
      .filter((name) => name?.startsWith('node:') !== true);

    expect(new Set(required)).toEqual(new Set(['@vibe-agent-toolkit/schema', '@vibe-agent-toolkit/utils/process']));
  });

  it('passes the child\'s exit status through unchanged', () => {
    const result = spawnSync(NODE_EXECUTABLE, [SPAWNER_DIST, 'direct', NODE_EXECUTABLE, '-e', 'process.exitCode = 7'], {
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(7);
  });

  it.skipIf(process.platform === 'win32')('dies of the signal that killed the child', () => {
    const result = spawnSync(
      NODE_EXECUTABLE,
      [SPAWNER_DIST, 'direct', NODE_EXECUTABLE, '-e', "process.kill(process.pid, 'SIGTERM')"],
      { encoding: 'utf-8' },
    );

    expect(result.signal, result.stderr).toBe('SIGTERM');
  });

  it('refuses a usage it does not understand with the contract\'s ERROR code', () => {
    const result = spawnSync(NODE_EXECUTABLE, [SPAWNER_DIST, 'sideways', 'x'], { encoding: 'utf-8' });

    expect(result.status).toBe(ExitCode.ERROR);
    expect(result.stderr).toMatch(/usage: rss-spawner/);
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
