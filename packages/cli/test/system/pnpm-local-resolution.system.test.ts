/**
 * Regression, issue #172: the `vat` wrapper's "local install" priority resolved
 * exactly one hardcoded path — `node_modules/@vibe-agent-toolkit/cli/dist/bin.js`
 * — which assumes npm's FLAT layout. Under pnpm's isolated layout that path does
 * not exist, so priority 3 never fired, resolution fell through to priority 4
 * (whichever `vat.js` happened to be invoked), and the adopter silently ran a CLI
 * other than the one their lockfile pinned. No warning; they believed they were on
 * their pinned version.
 *
 * The layout below is built by hand rather than by running `pnpm install`, for two
 * reasons: a real install of this monorepo's workspace graph is slow and needs the
 * network, and the fixture has to pin the ONE structural fact the bug turns on —
 * that pnpm symlinks only DIRECT dependencies into the adopter's top-level
 * `node_modules`. An adopter depending on the umbrella `vibe-agent-toolkit`
 * package therefore gets **no top-level `node_modules/@vibe-agent-toolkit/`
 * directory at all**, and the CLI is reachable only from inside the umbrella
 * package's own directory.
 *
 * The installed CLI here is a STUB that prints a marker, not a copy of the real
 * one. That is what makes the assertion decisive: the marker can only be printed
 * by the copy under `.pnpm/`, so seeing it proves priority 3 fired. A fixture that
 * symlinked the real CLI would print the same version either way and would pass
 * against the unfixed wrapper.
 */

import { createSymlink, type SymlinkCapability, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, it } from 'vitest';

import {
  describe,
  expect,
  fs,
  getWrapperPath,
  safePath,
  spawnSync,
} from './test-common.js';
import { createTestTempDir } from './test-helpers/index.js';

const wrapperPath = getWrapperPath(import.meta.url);

/** Printed by the stub CLI planted under `.pnpm/`, and by nothing else. */
const PINNED_MARKER = 'PINNED-LOCAL-CLI-9.9.9';
const CLI_PKG = '@vibe-agent-toolkit/cli';
const UMBRELLA_PKG = 'vibe-agent-toolkit';
const CLI_VERSION = '9.9.9';
const UMBRELLA_VERSION = '1.0.0';
const NODE_MODULES = 'node_modules';
const PACKAGE_JSON = 'package.json';
const CLI_SCOPE = '@vibe-agent-toolkit';

/**
 * Windows needs elevation or developer mode to create directory symlinks, and
 * pnpm's layout IS symlinks — without them the fixture is not a pnpm layout and
 * would assert nothing. Probed rather than gated on raw platform, so this also
 * runs on an elevated/Developer-Mode Windows host instead of skipping outright.
 */
const symlinkCap = symlinkCapability();

let tempDir: string;
let adopterDir: string;

function writeJson(filePath: string, value: object): void {
  fs.mkdirSync(safePath.resolve(filePath, '..'), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

/**
 * Build pnpm's isolated layout:
 *
 *   adopter/node_modules/
 *     vibe-agent-toolkit -> .pnpm/vibe-agent-toolkit@1.0.0/node_modules/vibe-agent-toolkit
 *     .pnpm/
 *       vibe-agent-toolkit@1.0.0/node_modules/
 *         vibe-agent-toolkit/            (depends on the CLI)
 *         @vibe-agent-toolkit/cli -> ../../../@vibe-agent-toolkit+cli@9.9.9/...
 *       @vibe-agent-toolkit+cli@9.9.9/node_modules/@vibe-agent-toolkit/cli/
 *
 * Note what is ABSENT: `adopter/node_modules/@vibe-agent-toolkit/`. That absence
 * is the bug's precondition, and it is asserted below rather than left implied.
 */
function buildPnpmLayout(root: string, cap: SymlinkCapability): void {
  const pnpmDir = safePath.join(root, NODE_MODULES, '.pnpm');
  const umbrellaModules = safePath.join(pnpmDir, `${UMBRELLA_PKG}@${UMBRELLA_VERSION}`, NODE_MODULES);
  const cliModules = safePath.join(pnpmDir, `@vibe-agent-toolkit+cli@${CLI_VERSION}`, NODE_MODULES);
  const cliHome = safePath.join(cliModules, CLI_PKG);

  writeJson(safePath.join(root, PACKAGE_JSON), {
    name: 'pnpm-adopter',
    version: '1.0.0',
    dependencies: { [UMBRELLA_PKG]: UMBRELLA_VERSION },
  });
  writeJson(safePath.join(umbrellaModules, UMBRELLA_PKG, PACKAGE_JSON), {
    name: UMBRELLA_PKG,
    version: UMBRELLA_VERSION,
    dependencies: { [CLI_PKG]: CLI_VERSION },
  });
  // `exports` mirrors the real CLI package: `./package.json` is exported PRECISELY
  // so the resolver can locate the package without knowing its internal layout.
  writeJson(safePath.join(cliHome, PACKAGE_JSON), {
    name: CLI_PKG,
    version: CLI_VERSION,
    exports: { './package.json': './package.json' },
  });
  fs.mkdirSync(safePath.join(cliHome, 'dist'), { recursive: true });
  fs.writeFileSync(
    safePath.join(cliHome, 'dist', 'bin.js'),
    `console.log(${JSON.stringify(PINNED_MARKER)});\n`,
  );

  // Only the umbrella is linked at top level — the CLI deliberately is not.
  fs.mkdirSync(safePath.join(umbrellaModules, CLI_SCOPE), { recursive: true });
  createSymlink(
    cap,
    safePath.join('..', '..', '..', `@vibe-agent-toolkit+cli@${CLI_VERSION}`, NODE_MODULES, CLI_PKG),
    safePath.join(umbrellaModules, CLI_SCOPE, 'cli'),
  );
  createSymlink(
    cap,
    safePath.join('.pnpm', `${UMBRELLA_PKG}@${UMBRELLA_VERSION}`, NODE_MODULES, UMBRELLA_PKG),
    safePath.join(root, NODE_MODULES, UMBRELLA_PKG),
  );
}

beforeAll(() => {
  if (!symlinkCap) return;
  tempDir = createTestTempDir('vat-pnpm-resolution-');
  adopterDir = safePath.join(tempDir, 'adopter');
  fs.mkdirSync(adopterDir, { recursive: true });
  buildPnpmLayout(adopterDir, symlinkCap);
});

afterAll(() => {
  if (!symlinkCap || !tempDir) return;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe.skipIf(!symlinkCap)('vat wrapper local-install resolution under pnpm', () => {
  // The bug's precondition. If a future pnpm changes this, these tests would go
  // green for a reason unrelated to the fix, so it is asserted rather than assumed.
  it('fixture has no top-level @vibe-agent-toolkit directory (pnpm isolated layout)', () => {
    expect(fs.existsSync(safePath.join(adopterDir, NODE_MODULES, CLI_SCOPE))).toBe(false);
    // ...and the old hardcoded probe therefore finds nothing, which is the defect.
    expect(
      fs.existsSync(safePath.join(adopterDir, NODE_MODULES, CLI_PKG, 'dist', 'bin.js')),
    ).toBe(false);
  });

  it('runs the CLI the lockfile pinned instead of falling through to the global install', () => {
    const result = spawnSync('node', [wrapperPath, '--version'], {
      encoding: 'utf-8',
      cwd: adopterDir,
      env: { ...process.env, VAT_ROOT_DIR: undefined },
    });

    expect(result.status).toBe(0);
    // Only the copy under .pnpm/ can print this. Before the fix, this run
    // resolved `global` and printed the wrapper's own version instead.
    expect(result.stdout).toContain(PINNED_MARKER);
  });

  it('reports the local context, not the global fallback', () => {
    const result = spawnSync('node', [wrapperPath, '--version'], {
      encoding: 'utf-8',
      cwd: adopterDir,
      env: { ...process.env, VAT_ROOT_DIR: undefined, VAT_DEBUG: '1' },
    });

    expect(result.stderr).toContain('Context: local');
    expect(result.stderr).toContain(`Local version: ${CLI_VERSION}`);
  });
});
