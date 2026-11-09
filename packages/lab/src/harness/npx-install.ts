/**
 * An `npx:` build, resolved as the CLI's own entry point — for every facet.
 *
 * `npx` runs the published package's `bin` — the cli's `dist/bin/vat.js` wrapper,
 * which re-resolves which vat to run from its cwd (the subject) and, when the
 * subject has vat installed, runs the SUBJECT'S copy: a report stamped with the
 * pinned version measured another one. A `tree:` or `dist:` build runs
 * `dist/bin.js` straight; so does an `npx:` build. The pinned spec — a VAT package
 * ({@link VAT_PACKAGE_NAMES}) and an exact version, nothing else (`instrument.ts`) —
 * is installed once, into an arm of its own under the invocation's arms root, and
 * the build runs as `node <that install's @vibe-agent-toolkit/cli/dist/bin.js>`: one
 * vat process per repeat, whatever the subject has installed. Running `dist/bin.js`
 * directly is the protection; `bin.js` is the CLI itself and delegates to no other copy.
 *
 * What stands between the install and the stamp, checked once per install, before
 * any repeat: the entry is looked for only where the named package's own cli lives;
 * that cli's `package.json` must name `@vibe-agent-toolkit/cli` (an alias keeps the
 * real package's name) at the pinned version; and the entry's real path must lie
 * inside the install. The entry is then run once with `--version` — a check that
 * `bin.js` and its static imports load, not of which version it is: `--version`
 * reads that same manifest. The coordinate's `closure` is `closureDigest` from the
 * installed cli, its ceiling the install — the one definition every kind stamps
 * (`closure.ts`): the bytes of the cli and its `@vibe-agent-toolkit/*` dependencies,
 * and the resolved `name@version` of every third-party package in that closure.
 * `--no-package-lock` leaves third-party ranges to float, so two installs of one pin
 * that resolved another version of one are two instruments.
 *
 * Every refusal here — npm failing, the wrong cli, an entry outside the install or one
 * that does not start, a closure that does not resolve inside the install — is an arm
 * refusal (`armRefusal`): the CLI prints it as one `REFUSED:` line.
 *
 * npm itself is the one bundled with the Node that runs the lab, run as
 * `node <npm-cli.js>` with no shell on every platform ({@link locateNpmCli}): PATH is
 * never consulted, and under `cmd.exe` a timeout would kill the shell and leave npm's
 * node running.
 *
 * ## What stays inside the install, and what does not
 *
 * Node resolves a bare module name up the directory tree, past the install and the
 * arms root — to `/tmp/node_modules`, which is world-writable on Linux, or
 * `C:\node_modules`. For every OPTIONAL PEER any package of the install declares
 * (`peerDependenciesMeta`, `optional: true` — the cli's `@vibe-agent-toolkit/rag`, a
 * third-party package's optional integration) that does not resolve from that package
 * inside the install, the lab writes a stub package at the install's top-level
 * `node_modules`, which Node stops at and fails to load (`ERR_MODULE_NOT_FOUND` /
 * `MODULE_NOT_FOUND`) — the package's own "not installed". Only declared optional
 * peers are stubbed: any other name the install lacks — an undeclared `try { require() }`
 * — is still looked up in ancestor `node_modules` directories, as it is for any Node
 * program. Do not put the arms root under a directory other users can write to on a
 * shared host.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { everywhere, isUnderRoot, mkdirSyncReal, pathPresent, safePath } from '@vibe-agent-toolkit/utils';

import { distinctSlug } from '../store.js';

import {
  type ArmDirectories,
  armDirectories,
  armRefusal,
  armStepEnvironment,
  prepareArmDirectories,
  resetArmHome,
  resetColdArm,
} from './arm-dirs.js';
import { EMPTY_ARM_ENVIRONMENT } from './arm-env.js';
import { closureDigest } from './closure.js';
import { runCommand } from './run.js';
import type { ResolvedInstrument } from './types.js';

/** The cli package: what every `npx:` build runs, whichever VAT package it names. */
const CLI_PACKAGE = '@vibe-agent-toolkit/cli';

/**
 * The only packages an `npx:` build may name: VAT's umbrella and its cli. Any other
 * package could carry a dependency aliased to the cli's name, or a copy of it, and
 * pass every check the install makes under the pinned label.
 */
export const VAT_PACKAGE_NAMES = ['vibe-agent-toolkit', CLI_PACKAGE] as const;

/** One of {@link VAT_PACKAGE_NAMES}. */
export type VatPackageName = (typeof VAT_PACKAGE_NAMES)[number];

/** A VAT package and the exact version it pins — checked by `instrument.ts`. */
export interface NpmPin {
  readonly name: VatPackageName;
  readonly version: string;
}

/** Installs a pinned npm spec under a prefix directory, in the install arm's environment. */
export type NpxInstaller = (spec: string, prefix: string, dirs: ArmDirectories) => Promise<void> | void;

/**
 * Where, and how, an invocation's `npx:` builds are installed: its arms root, its
 * installer, and what it has installed — one install per spec, so two builds
 * naming one spec share it rather than one emptying the other's arm.
 * Made by {@link npxInstallSite}.
 */
export interface NpxInstallSite {
  readonly armsRoot: string;
  readonly install: NpxInstaller;
  readonly installs: Map<string, Promise<ResolvedInstrument>>;
}

/**
 * @param armsRoot - The invocation's arms root
 * @param install - Installs a pinned spec
 * @returns A site that has installed nothing yet
 */
export function npxInstallSite(armsRoot: string, install: NpxInstaller): NpxInstallSite {
  return { armsRoot, install, installs: new Map() };
}

/** The cli's entry point, relative to the directory holding a `node_modules`. */
const CLI_ENTRY = `node_modules/${CLI_PACKAGE}/dist/bin.js`;

/**
 * The file a stub peer's `exports` names, and never holds: Node resolves the package,
 * stops its walk there, and fails the load as `ERR_MODULE_NOT_FOUND` naming this file.
 * A missing target rather than a throwing module body: a named import is checked at
 * link time, before a body runs, and would fail as a `SyntaxError` the cli does not
 * read as "not installed".
 */
const STUB_PEER_TARGET = './vat-lab-does-not-install-optional-peers.js';

/** One segment of an npm package name: never `.`, `..` or empty, so it cannot climb out of `node_modules`. */
const PACKAGE_NAME_SEGMENT = /^[a-z0-9~-][a-z0-9._~-]*$/u;

/**
 * @param name - A name an installed manifest declares
 * @returns `true` for `name` or `@scope/name`, each segment {@link PACKAGE_NAME_SEGMENT}
 */
function isPackageName(name: string): boolean {
  if (!name.startsWith('@')) return PACKAGE_NAME_SEGMENT.test(name);
  // A segment holds no `/`, so a second one fails the bare name's test.
  const slash = name.indexOf('/');
  return slash !== -1 && PACKAGE_NAME_SEGMENT.test(name.slice(1, slash)) && PACKAGE_NAME_SEGMENT.test(name.slice(slash + 1));
}

/** The install arm's name; its build segment is the spec. */
const INSTALL_ARM = 'npx-install';

/** How long the entry may take to start. */
const START_TIMEOUT_MS = 60_000;

/**
 * How long one `npm install` of a pinned spec may take — every verb, whatever its
 * `--timeout-ms`: that bounds a measured step, and a cold install outlasts one.
 */
export const NPX_INSTALL_TIMEOUT_MS = 15 * 60_000;

/** @returns The operator's npm userconfig: an inherited `npm_config_userconfig`, in any case, or `~/.npmrc` */
function operatorNpmUserconfig(): string {
  const named = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'npm_config_userconfig')?.[1];
  return named ?? safePath.join(homedir(), '.npmrc');
}

/** A package's manifest file. */
const MANIFEST = 'package.json';

/**
 * The `npm-cli.js` bundled with the Node that runs the lab — the one npm an
 * `npx:` install uses, run as `node <npm-cli.js>` with no shell: `npm.cmd` runs
 * under `cmd.exe`, and a timeout kills `cmd.exe` but not npm's node beneath it.
 * PATH is not consulted, so a version manager's shell shim never decides it.
 *
 * - POSIX: `<prefix>/lib/node_modules/npm/bin/npm-cli.js`, `<prefix>` the parent
 *   of the directory holding `node`.
 * - Windows: `node_modules/npm/bin/npm-cli.js` beside `node.exe`.
 *
 * @param execPath - The Node executable (`process.execPath`)
 * @param platform - Whose layout
 * @returns The absolute `npm-cli.js`
 * @throws {VatError} an arm refusal naming the path looked for when nothing is there
 */
export function locateNpmCli(execPath: string, platform: NodeJS.Platform): string {
  const nodeDir = dirname(execPath);
  const npmRoot = platform === 'win32' ? nodeDir : safePath.join(dirname(nodeDir), 'lib');
  const cli = safePath.join(npmRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!pathPresent(cli, { follow: cli }, everywhere('source'), 'probe')) {
    throw armRefusal(
      `an npx: build is installed with the npm bundled with the Node running the lab (${execPath}), ` +
        `and there is none at ${cli}. Run the lab with a Node installation that ships npm.`,
    );
  }
  return cli;
}

/**
 * Install a pinned spec with npm, in the install arm's environment — its npm cache,
 * temp directory and home — with lifecycle scripts off: the lab measures vat, never
 * runs a package's install hooks. The arm's home holds no `.npmrc`, so npm reads the
 * operator's (registry, scoped registries, auth) as its userconfig; an install never writes it.
 * npm reads that file with `HOME` pointed at the arm's home, so a `~/` or `${HOME}` in it
 * resolves THERE, not to the operator's home.
 * No arm's own `--env` reaches it: one install serves every arm that names the spec, and
 * the inherited network settings (`arm-env.ts`) are what npm needs to reach a registry.
 * Run as `node <npm-cli.js>` ({@link locateNpmCli}), no shell, and bounded by
 * {@link NPX_INSTALL_TIMEOUT_MS}.
 *
 * @param spec - The pinned spec
 * @param prefix - The directory to install under
 * @param dirs - The install arm
 * @throws {VatError} an arm refusal when npm cannot be located, fails or times out
 */
export const npmInstall: NpxInstaller = (spec, prefix, dirs) => {
  const npmEnv = { set: { npm_config_userconfig: operatorNpmUserconfig() }, unset: [] };
  const result = runCommand(
    { command: process.execPath, leadingArgs: [locateNpmCli(process.execPath, process.platform)] },
    // `--`: the spec is an operand, never an option, whatever it starts with.
    ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', prefix, '--', spec],
    { cwd: prefix, env: armStepEnvironment(dirs, npmEnv).env, timeoutMs: NPX_INSTALL_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    throw armRefusal(`npm install ${spec} failed (${String(result.spawnError ?? result.exitCode)}): ${result.stderr.trim()}`);
  }
};

/**
 * @param armsRoot - The invocation's arms root
 * @param spec - The pinned spec
 * @returns The arm the spec is installed in — named by the spec's slug and a digest of
 *   the raw spec, so two specs that slug alike never share one; nothing is created
 */
export function npxInstallArm(armsRoot: string, spec: string): ArmDirectories {
  return armDirectories({ root: armsRoot, build: distinctSlug(spec), arm: INSTALL_ARM, state: 'cold' });
}

/**
 * Require the cli an install holds to be the cli, at the pinned version. npm keeps an
 * aliased package's own name in its manifest, so a name other than the cli's is other
 * code installed under the cli's directory.
 *
 * @param cliRoot - The package directory of the cli entry an install holds
 * @param pin - The VAT package and the version it pins
 * @param spec - The pinned spec, for the error message
 * @throws {VatError} an arm refusal when its package's `package.json` names another package or version
 */
function requirePinnedCli(cliRoot: string, pin: NpmPin, spec: string): void {
  const manifest = readInstalledManifest(safePath.join(cliRoot, MANIFEST));
  const { name, version } = manifest;
  const misnamed = name === CLI_PACKAGE ? null : `${CLI_PACKAGE} resolved to "${String(name)}", another package under its name`;
  const misversioned = version === pin.version ? null : `it resolved ${CLI_PACKAGE} ${String(version)}, not ${pin.version}`;
  const wrong = misnamed ?? misversioned;
  if (wrong !== null) {
    throw armRefusal(`the install of ${spec}: ${wrong}: the report would name one build and measure another`);
  }
}

/** The fields of an installed `package.json` an install reads — someone else's file, so unknown. */
interface InstalledManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly peerDependencies?: unknown;
  readonly peerDependenciesMeta?: unknown;
}

/**
 * @param manifestPath - An installed `package.json`
 * @returns It, parsed
 * @throws {VatError} an arm refusal when it is not JSON
 */
function readInstalledManifest(manifestPath: string): InstalledManifest {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as InstalledManifest;
  } catch (error) {
    throw armRefusal(`the install holds ${manifestPath}, which cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @param manifest - An installed package's manifest
 * @returns The peers it declares optional: named under `peerDependencies`, `optional: true` in `peerDependenciesMeta`
 */
function optionalPeers(manifest: InstalledManifest): string[] {
  const { peerDependencies: peers, peerDependenciesMeta: meta } = manifest;
  if (typeof peers !== 'object' || peers === null || typeof meta !== 'object' || meta === null) return [];
  const flags = meta as Readonly<Record<string, unknown>>;
  return Object.keys(peers).filter((name) => {
    const flag = flags[name];
    return typeof flag === 'object' && flag !== null && (flag as { optional?: unknown }).optional === true;
  });
}

/**
 * Every package directory of an install, nested ones included: each real directory
 * under a `node_modules` (a `@scope/` directory's children) that holds a `package.json`,
 * and the same beneath each one's own `node_modules`. A link is not followed: npm links
 * only what the pin refuses (a directory spec), and the cli entry is proven inside.
 *
 * @param nodeModules - A `node_modules` directory
 * @returns The package directories under it
 */
function installedPackages(nodeModules: string): string[] {
  const found: string[] = [];
  const pending = [nodeModules];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (!pathPresent(dir, 'entry', everywhere('source'), 'probe')) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // A link is not followed (above): its package is not one the install laid down.
      if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = safePath.join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        pending.push(path);
      } else if (pathPresent(safePath.join(path, MANIFEST), 'entry', everywhere('source'), 'probe')) {
        found.push(path);
        pending.push(safePath.join(path, 'node_modules'));
      }
    }
  }
  return found;
}

/**
 * Stub every optional peer any package of the install declares and that does not
 * resolve from that package inside the install, at the install's top-level
 * `node_modules`, so Node's walk for it ends inside the install (module header). A
 * peer resolves when any `node_modules` from the package's directory up to the
 * install's holds an entry of its name — what Node would find first. The top-level
 * `node_modules` is on every such walk, so a peer that resolves nowhere is absent
 * there too, and its stub shadows nothing.
 *
 * @param prefix - The install's directory
 * @throws {VatError} an arm refusal for a declared peer that is not a package name
 */
function stubAbsentOptionalPeers(prefix: string): void {
  const top = safePath.join(prefix, 'node_modules');
  for (const packageDir of installedPackages(top)) {
    const manifest = readInstalledManifest(safePath.join(packageDir, MANIFEST));
    for (const peer of optionalPeers(manifest)) {
      // A name, never a path: the stub is written where the name says.
      if (!isPackageName(peer)) {
        throw armRefusal(`the installed package at ${packageDir} declares an optional peer "${peer}" that is not a package name`);
      }
      if (!resolvesInside(prefix, packageDir, peer)) writeStubPeer(top, peer);
    }
  }
}

/**
 * @param prefix - The install's directory
 * @param packageDir - An installed package's directory, inside it
 * @param peer - A package name
 * @returns Whether some `node_modules` from the package's directory up to the install's holds `peer`
 */
function resolvesInside(prefix: string, packageDir: string, peer: string): boolean {
  const ceiling = safePath.resolve(prefix);
  for (let dir = packageDir; ; dir = safePath.resolve(dir, '..')) {
    if (pathPresent(safePath.join(dir, 'node_modules', peer), 'entry', everywhere('destination'), 'confirmed')) return true;
    if (dir === ceiling || dir === safePath.resolve(dir, '..')) return false;
  }
}

/**
 * @param top - The install's top-level `node_modules`
 * @param peer - A package name, checked
 */
function writeStubPeer(top: string, peer: string): void {
  const stub = safePath.join(top, peer);
  mkdirSyncReal(stub, { recursive: true });
  const description = `Placed by vat-lab: the lab does not install optional peers, so ${peer} is not installed.`;
  writeFileSync(safePath.join(stub, MANIFEST), `${JSON.stringify({ name: peer, description, exports: STUB_PEER_TARGET })}\n`);
}

/**
 * Run the entry once with `--version` and require it to exit 0: `bin.js` and its static
 * imports load. A module the cli imports only on demand is not reached. Not a version
 * check: `--version` reads the manifest {@link requirePinnedCli} already read.
 *
 * @param entry - The cli entry about to be stamped
 * @param spec - The pinned spec, for the error message
 * @param dirs - The install arm, whose step environment it runs under
 * @throws {VatError} an arm refusal when it does not start
 */
function requireEntryStarts(entry: string, spec: string, dirs: ArmDirectories): void {
  const ran = runCommand({ command: process.execPath, leadingArgs: [entry] }, ['--version'], {
    cwd: dirs.tmp,
    env: armStepEnvironment(dirs, EMPTY_ARM_ENVIRONMENT).env,
    timeoutMs: START_TIMEOUT_MS,
  });
  if (ran.exitCode !== 0) {
    throw armRefusal(
      `the install of ${spec}: ${entry} --version exited ${String(ran.spawnError ?? ran.exitCode)}: ` +
        `the install does not start. ${ran.stderr.trim()}`,
    );
  }
}

/**
 * Install a pinned spec under the arms root and resolve it as `node <installed cli entry>`,
 * its closure the installed cli's ({@link closureDigest}).
 *
 * The install is made in the arm's `tmp/`, emptied first, so an interrupted run leaves
 * it under the arms root — never in the system temp directory — for the next to clear.
 *
 * @param pin - The VAT package and the version it pins
 * @param site - The arms root and installer
 * @returns The resolved instrument
 * @throws {VatError} an arm refusal when npm fails, or the install holds no cli entry, one outside
 *   the install, one of another package or version, one that does not start, or a closure
 *   that does not resolve inside the install
 */
export function installNpxInstrument(pin: NpmPin, site: NpxInstallSite): Promise<ResolvedInstrument> {
  const spec = `${pin.name}@${pin.version}`;
  const known = site.installs.get(spec);
  if (known !== undefined) return known;
  const installing = installOnce(pin, spec, site);
  site.installs.set(spec, installing);
  return installing;
}

/**
 * Where the named package's own cli lives, in the order Node resolves it from that
 * package: the cli itself is the hoisted one; the umbrella's is its own dependency,
 * nested under it when npm cannot hoist it, else hoisted. No other directory is
 * searched, so no copy a dependency bundles can win.
 *
 * @param prefix - The install's directory
 * @param name - The VAT package installed there
 * @returns The candidate cli entries, first match wins
 */
function cliEntryCandidates(prefix: string, name: VatPackageName): string[] {
  const hoisted = safePath.join(prefix, CLI_ENTRY);
  return name === CLI_PACKAGE ? [hoisted] : [safePath.join(prefix, 'node_modules', name, CLI_ENTRY), hoisted];
}

/**
 * @param prefix - The install's directory
 * @param name - The VAT package installed there
 * @param spec - The pinned spec, for the error message
 * @returns The install's cli entry, proven to lie inside it
 * @throws {VatError} an arm refusal when there is none, or its real path lies outside the install
 */
function locateCliEntry(prefix: string, name: VatPackageName, spec: string): string {
  const entry = cliEntryCandidates(prefix, name).find((path) => pathPresent(path, { follow: path }, everywhere('source'), 'probe'));
  if (entry === undefined) throw armRefusal(`the install of ${spec} holds no ${CLI_ENTRY} to measure`);
  // Through every link: an entry npm linked from elsewhere is not the published bytes.
  if (isUnderRoot(prefix, entry) !== 'inside') {
    throw armRefusal(`the install of ${spec}: ${entry} lies outside the install at ${prefix}; it is not the published package`);
  }
  return entry;
}

/**
 * {@link installNpxInstrument}, for a spec the site has not installed.
 *
 * @param pin - The VAT package and the version it pins
 * @param spec - Their spec
 * @param site - The arms root and installer
 * @returns The resolved instrument
 */
async function installOnce(pin: NpmPin, spec: string, site: NpxInstallSite): Promise<ResolvedInstrument> {
  const dirs = npxInstallArm(site.armsRoot, spec);
  prepareArmDirectories(dirs);
  const unclean = await resetColdArm(dirs);
  if (unclean !== null) throw armRefusal(`npx install arm: ${unclean}`);
  await resetArmHome(dirs);
  const prefix = mkdirSyncReal(safePath.join(dirs.tmp, 'install'));
  await site.install(spec, prefix, dirs);
  const entry = locateCliEntry(prefix, pin.name, spec);
  const cliRoot = safePath.join(entry, '..', '..');
  requirePinnedCli(cliRoot, pin, spec);
  stubAbsentOptionalPeers(prefix);
  requireEntryStarts(entry, spec, dirs);
  return {
    command: process.execPath,
    leadingArgs: [entry],
    // No root: every file of the install sits under `node_modules`, which the io facet's site normalizer keys on.
    version: { version: pin.version, commit: null, dirty: null, closure: installedClosure(cliRoot, prefix, spec) },
  };
}

/**
 * @param cliRoot - The installed cli's directory
 * @param prefix - The install's directory: the closure's ceiling
 * @param spec - The pinned spec, for the refusal
 * @returns The closure ({@link closureDigest}) the install stamps
 * @throws {VatError} an arm refusal when the closure does not resolve inside the install
 */
function installedClosure(cliRoot: string, prefix: string, spec: string): string {
  try {
    return closureDigest(cliRoot, prefix);
  } catch (error) {
    throw armRefusal(`the install of ${spec}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
