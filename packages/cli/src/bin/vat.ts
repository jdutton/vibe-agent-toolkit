#!/usr/bin/env node

/**
 * Smart vat wrapper with context-aware execution
 *
 * Automatically detects execution context and delegates to appropriate binary:
 * - Developer mode: Inside vibe-agent-toolkit repo → packages/cli/dist/bin.js (unpackaged dev build)
 * - Local install: Project has vibe-agent-toolkit → node_modules version (packaged)
 * - Global install: Fallback → globally installed version (packaged)
 *
 * Features:
 * - Version detection and comparison
 * - Debug mode (VAT_DEBUG=1) shows resolution details
 * - Works from any subdirectory within the repo
 *
 * Works in both git and non-git directories.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {  dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeStdioBlocking,
  findNodeWorkspaceRoot,
  makeStdioBlocking,
  safePath,
} from '@vibe-agent-toolkit/utils';

// Before ANY output. This file — not bin.ts — is what package.json maps `vat` to,
// so it is the CLI entry point in every installed copy, and `makeStdioBlocking`
// is documented as belonging first thing in one. The delegated child applies it
// again for the command's own output; what this protects is THIS process's
// writes, every one of which is followed by `spawnCli`'s immediate
// `process.exit`. See ../utils/output.ts.
const stdioBlocking = makeStdioBlocking();

/**
 * Report whether the streams above actually went blocking.
 *
 * A free function rather than an inline `if` in `main()` because `main()` is
 * already at the cognitive-complexity ceiling, and because reaching through an
 * internal Node handle is precisely the kind of thing that can fail quietly on
 * Windows — the diagnostic must not be the first thing dropped to save a branch.
 */
function reportStdioBlocking(debug: boolean): void {
  if (debug) {
    console.error(`[vat debug] ${describeStdioBlocking(stdioBlocking)}`);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

type Context = 'dev' | 'local' | 'global';

function spawnCli(binPath: string, context: Context, contextPath?: string): never {
  const env = {
    ...process.env,
    VAT_CONTEXT: context,
    VAT_CONTEXT_PATH: contextPath,
  };

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is always in PATH for CLI usage
  const result = spawnSync('node', [binPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });

  process.exit(result.status ?? 1);
}

/**
 * Check if we're in vibe-agent-toolkit repo (developer mode)
 * Simple detection: both wrapper and bin.js must exist in project structure
 *
 * @param projectRoot - Root directory of the project
 * @returns Path to bin.js if detected, null otherwise
 */
function getDevModeBinary(projectRoot: string): string | null {
  const wrapperPath = safePath.join(projectRoot, 'packages/cli/dist/bin/vat.js');
  const binPath = safePath.join(projectRoot, 'packages/cli/dist/bin.js');

  if (process.env['VAT_DEBUG'] === '1') {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checking project structure files for debug
    console.error(`[vat debug] Dev check - wrapper: ${wrapperPath} (${existsSync(wrapperPath)})`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checking project structure files for debug
    console.error(`[vat debug] Dev check - bin: ${binPath} (${existsSync(binPath)})`);
  }

  // Both files must exist to confirm we're in vibe-agent-toolkit repo
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checking project structure files
  if (existsSync(wrapperPath) && existsSync(binPath)) {
    return binPath;
  }

  return null;
}

/**
 * Find the CLI the adopter's lockfile pinned, wherever their package manager put it.
 *
 * Resolved through Node's OWN resolver rather than by probing a path, because the
 * path this used to probe —
 * `<dir>/node_modules/@vibe-agent-toolkit/cli/dist/bin.js` — assumes npm's flat
 * layout and **does not exist under pnpm** (issue #172). An adopter depending on
 * the umbrella `vibe-agent-toolkit` package gets no top-level
 * `node_modules/@vibe-agent-toolkit/` directory at all; the real CLI lives under
 * `node_modules/.pnpm/@vibe-agent-toolkit+cli@<ver>_<hash>/…`. So priority 3 never
 * fired for them, resolution fell through to priority 4, and whichever copy of
 * `vat.js` happened to be invoked won — silently ignoring the version they pinned.
 * That is the exact failure `findLocalInstall` exists to prevent, and it was
 * invisible on npm/bun, where the flat layout makes the probe succeed.
 *
 * `createRequire` resolution walks the ancestor `node_modules` chain itself, which
 * is what the hand-rolled loop here used to do — and it does so correctly for
 * npm, bun, pnpm and yarn PnP without enumerating any of their layouts.
 *
 * It asks for `package.json` (exported by this package precisely so it can be
 * located) and derives the binary from the package DIRECTORY rather than from the
 * manifest's `bin` field. `bin.vat` names `dist/bin/vat.js` — THIS wrapper — so
 * honouring it would make the wrapper delegate to itself and spawn forever. The
 * target is the real CLI entry, `dist/bin.js`, exactly as before; only the way it
 * is located has changed.
 *
 * TWO resolution bases are tried, and the second is not redundant. Under pnpm's
 * isolated layout only DIRECT dependencies are symlinked into the adopter's
 * top-level `node_modules`, so when the adopter depends on the umbrella
 * `vibe-agent-toolkit` package — the documented way to adopt VAT — the CLI is a
 * TRANSITIVE dependency and is deliberately unreachable from the adopter root.
 * Resolving from the adopter alone would still miss it, which is the umbrella case
 * the issue actually describes. It IS reachable from the umbrella package's own
 * directory, so that package is resolved first (it is a direct dependency, hence
 * visible) and used as the base for the second hop.
 *
 * @param projectRoot - Directory to resolve from; ancestors are searched too.
 * @returns Path to the local `dist/bin.js` if one is installed and built, else null.
 */
function findLocalInstall(projectRoot: string): string | null {
  // The base need not exist — `createRequire` treats it purely as the directory
  // to resolve relative to.
  const fromProject = safePath.join(projectRoot, 'noop.js');
  const umbrellaManifest = tryResolve(fromProject, 'vibe-agent-toolkit/package.json');
  const bases = umbrellaManifest === null ? [fromProject] : [fromProject, umbrellaManifest];

  for (const base of bases) {
    const manifestPath = tryResolve(base, '@vibe-agent-toolkit/cli/package.json');
    if (manifestPath === null) continue;
    const localBin = safePath.join(dirname(manifestPath), 'dist', 'bin.js');
    // Still existence-checked: a dependency can be installed without having been
    // built (a fresh workspace checkout, a partial install), and spawning a
    // missing file would fail far from its cause.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checking for local install
    if (existsSync(localBin)) return localBin;
  }
  return null;
}

/**
 * `require.resolve` reduced to "found it, or didn't".
 *
 * A failure here is priority 3's ordinary "not applicable" answer — no local
 * install on this base — so it falls through to the next base and ultimately to
 * the global install rather than failing the run.
 */
function tryResolve(fromPath: string, specifier: string): string | null {
  try {
    return createRequire(fromPath).resolve(specifier);
  } catch {
    return null;
  }
}

/**
 * Read version from package.json
 * @param packageJsonPath - Path to package.json file
 * @returns Version string or null if not found
 */
function readVersion(packageJsonPath: string): string | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reading version from package.json
    if (!existsSync(packageJsonPath)) {
      return null;
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reading version from package.json
    const content = readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Main entry point - detects context and executes appropriate binary
 */
function main(): void {
  // VAT_TEST_ROOT: legacy test override that pins the project root to a
  // specific directory. Applied at the bin boundary so library code stays
  // pure — no library function reads this variable.
  const testRoot = process.env['VAT_TEST_ROOT'];
  const cwd = testRoot ? safePath.resolve(testRoot) : process.cwd();
  const args = process.argv.slice(2);
  const debug = process.env['VAT_DEBUG'] === '1';

  // Reported here rather than in the block further down because every dispatch
  // path below ends in `spawnCli`, which never returns.
  reportStdioBlocking(debug);

  // Priority 1: Explicit override via VAT_ROOT_DIR
  if (process.env['VAT_ROOT_DIR']) {
    const binPath = safePath.join(process.env['VAT_ROOT_DIR'], 'packages/cli/dist/bin.js');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dynamic path from env is expected
    if (existsSync(binPath)) {
      if (debug) {
        console.error('[vat debug] Using VAT_ROOT_DIR override');
        console.error(`[vat debug] Binary: ${binPath}`);
      }
      spawnCli(binPath, 'dev', process.env['VAT_ROOT_DIR']);
    }
  }

  // Find the Node monorepo workspace root from the current working directory.
  // bin/vat.ts uses this to locate packages/cli/dist/bin.js in dev mode —
  // strictly a workspace-binary lookup, not a VAT-project lookup.
  const projectRoot = findNodeWorkspaceRoot(cwd) ?? cwd;

  let binPath: string;
  let context: Context;
  let binDir: string;

  // Priority 2: Check for developer mode (inside vibe-agent-toolkit repo)
  const devBin = getDevModeBinary(projectRoot);
  if (devBin) {
    binPath = devBin;
    context = 'dev';
    binDir = dirname(dirname(devBin)); // packages/cli/dist -> packages/cli
  }
  // Priority 3: Check for local install (node_modules)
  else {
    const localBin = findLocalInstall(projectRoot);
    if (localBin) {
      binPath = localBin;
      context = 'local';
      binDir = dirname(dirname(localBin)); // node_modules/@vibe-agent-toolkit/cli/dist -> node_modules/@vibe-agent-toolkit/cli
    }
    // Priority 4: Use global install (this script's location)
    else {
      binPath = safePath.resolve(__dirname, '../bin.js');
      context = 'global';
      binDir = dirname(__dirname); // dist -> cli root
    }
  }

  // Read versions for comparison
  // __dirname = dist/bin, so go up twice to reach package.json at cli root
  const globalPkgPath = safePath.join(dirname(dirname(__dirname)), 'package.json');
  const globalVersion = readVersion(globalPkgPath);
  let localVersion: string | null = null;
  if (context === 'local') {
    const localPkgPath = safePath.join(binDir, 'package.json');
    localVersion = readVersion(localPkgPath);
  }

  // Debug output
  if (debug) {
    console.error(`[vat debug] CWD: ${cwd}`);
    console.error(`[vat debug] Project root: ${projectRoot}`);
    console.error(`[vat debug] Context: ${context}`);
    console.error(`[vat debug] Binary: ${binPath}`);
    console.error(`[vat debug] Global version: ${globalVersion ?? 'unknown'}`);
    console.error(`[vat debug] Local version: ${localVersion ?? 'N/A'}`);
    console.error(`[vat debug] Args: ${args.join(' ')}`);
  }

  // Execute the binary with all arguments (pass projectRoot for dev and local contexts)
  const contextPath = context === 'dev' || context === 'local' ? projectRoot : undefined;
  spawnCli(binPath, context, contextPath);
}

// Run main function
main();
