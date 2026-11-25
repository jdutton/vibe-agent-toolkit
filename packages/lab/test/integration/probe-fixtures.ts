/**
 * What the two in-process probe suites (`memory-probe`, `perf-probe`) share:
 * scratch directories, stand-in vat packages, and the builtin-only check; and
 * the built lab, for an in-process CLI case whose capture loads a probe.
 *
 * Not a test file. Two copies of `mainScript` would drift on what makes a
 * script "vat", which is the one rule the probes share.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import type { Command } from 'commander';
import { expect, it } from 'vitest';

import type * as VatLab from '../../src/bin/vat-lab.js';

/** The CLI package's name: a main script it owns is vat. */
export const CLI_PACKAGE = '@vibe-agent-toolkit/cli';

const scratch: string[] = [];

/** Remove every scratch directory made so far. Call from `afterAll`. */
export function cleanupScratch(): void {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.length = 0;
}

/**
 * A fresh scratch directory, removed by {@link cleanupScratch}.
 *
 * @param prefix - Temp-directory prefix, so a stray directory names its suite
 * @returns Its path
 */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * Write `source` as a main script at `relativePath` inside a package.
 *
 * @param owner - The owning `package.json`: its name, the whole manifest, or null for a script no package owns
 * @param relativePath - Where the script sits inside the package
 * @param source - The script
 * @returns The script's path
 */
export function mainScript(owner: string | Readonly<Record<string, unknown>> | null, relativePath: string, source: string): string {
  const root = scratchDir('lab-probe-package-');
  const manifest = typeof owner === 'string' ? { name: owner } : owner;
  if (manifest !== null) writeFileSync(safePath.join(root, 'package.json'), JSON.stringify(manifest));
  const script = safePath.join(root, relativePath);
  mkdirSyncReal(safePath.join(script, '..'), { recursive: true });
  writeFileSync(script, source);
  return script;
}

/**
 * The path of an emitted file in the lab's `dist/`.
 *
 * @param relative - Path below `dist/`
 * @returns The absolute path, forward slashes
 */
export function distFile(relative: string): string {
  return toForwardSlash(fileURLToPath(new URL(`../../dist/${relative}`, import.meta.url)));
}

/**
 * The built lab's CLI, for an in-process case whose capture loads a probe.
 *
 * A probe ships only as its emitted `.cjs` beside the built capture, and the CLI
 * resolves it there with no override, so the source program under a test runner
 * refuses to measure (`resolvePreloadPath`). The built program is the one that
 * ships, run in-process all the same: stream spies and `process.exitCode` see it.
 *
 * @returns A fresh program, as `createProgram` returns one
 */
export async function builtLabProgram(): Promise<Command> {
  const lab = (await import(pathToFileURL(distFile('bin/vat-lab.js')).href)) as typeof VatLab;
  return lab.createProgram();
}

/**
 * Register the two contract cases every probe shares: it activates on exactly the
 * variable its capture sets, and it requires nothing a bare npx install lacks.
 *
 * @param probePath - The emitted probe
 * @param captureEnv - The activation variable the facet's capture sets
 */
export function itKeepsTheProbeContract(probePath: string, captureEnv: string): void {
  it('activates on exactly the variable the capture sets', () => {
    const probe = createRequire(import.meta.url)(probePath) as { __internals: { LOG_DIR_ENV: string } };

    expect(probe.__internals.LOG_DIR_ENV).toBe(captureEnv);
  });

  it('requires nothing but node builtins and the shared vat-process rule: it runs inside an npx vat', () => {
    // Following its relative require of that sibling: it is loaded too.
    expect(foreignRequires(probePath)).toEqual([]);
  });
}

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

/** The one sibling a probe may load: the shared vat-process rule. */
const VAT_PROCESS = { specifier: '../../harness/vat-process.cjs', file: distFile('harness/vat-process.cjs') };

/**
 * Every non-builtin specifier a probe loads, following its relative require of
 * the shared `vat-process.cjs` and no further. Any other relative require is
 * reported as foreign.
 *
 * @param file - An emitted probe
 * @returns Every specifier that is neither a `node:` builtin nor the vat-process sibling
 */
function foreignRequires(file: string): (string | undefined)[] {
  const foreign: (string | undefined)[] = [];
  for (const name of requiredBy(file)) {
    if (name?.startsWith('node:') === true) continue;
    if (name === VAT_PROCESS.specifier && file !== VAT_PROCESS.file) {
      foreign.push(...foreignRequires(VAT_PROCESS.file));
      continue;
    }
    foreign.push(name);
  }
  return foreign;
}
