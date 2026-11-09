/**
 * An `npx:` build, resolved as the CLI's own entry point — for every facet.
 *
 * `npx` runs the published package's `bin` — the cli's `dist/bin/vat.js` wrapper,
 * which re-resolves which vat to run from its cwd (the subject) and, when the
 * subject has vat installed, runs the SUBJECT'S copy: a report stamped with the
 * pinned version measured another one. A `tree:` or `dist:` build runs
 * `dist/bin.js` straight; so does an `npx:` build. The pinned spec is installed
 * once, into an arm of its own under the invocation's arms root, and the build
 * runs as `node <that install's @vibe-agent-toolkit/cli/dist/bin.js>`: one vat
 * process per repeat, whatever the subject has installed.
 *
 * Two checks stand between the install and the stamp. npm resolves the cli as a
 * DEPENDENCY of the spec, so the cli's own `package.json` must name the pinned
 * version; and the entry itself is run once with `--version` and must REPORT it —
 * so no delegation path, this one or a later one, can run another copy under the
 * pinned name. `--no-package-lock` leaves third-party ranges to float, so the
 * install's whole `node_modules` is digested into the coordinate's `closure`: two
 * installs of one version that resolved differently are two instruments.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { everywhere, mkdirSyncReal, pathPresent, safePath } from '@vibe-agent-toolkit/utils';

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
import { fingerprintFiles } from './fingerprint.js';
import { runCommand } from './run.js';
import type { ResolvedInstrument } from './types.js';

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

/** The cli's package directory, relative to an install's directory. */
const CLI_DIR = 'node_modules/@vibe-agent-toolkit/cli';

/** The cli's entry point, relative to an install's directory. */
const CLI_ENTRY = `${CLI_DIR}/dist/bin.js`;

/** The install arm's name; its build segment is the spec. */
const INSTALL_ARM = 'npx-install';

/** How long the entry may take to print its version. */
const VERSION_TIMEOUT_MS = 60_000;

/** @returns The operator's npm userconfig: an inherited `npm_config_userconfig`, in any case, or `~/.npmrc` */
function operatorNpmUserconfig(): string {
  const named = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'npm_config_userconfig')?.[1];
  return named ?? safePath.join(homedir(), '.npmrc');
}

/**
 * Install a pinned spec with npm, in the install arm's environment — its npm cache,
 * temp directory and home — with lifecycle scripts off: the lab measures vat, never
 * runs a package's install hooks. The arm's home holds no `.npmrc`, so npm reads the
 * operator's (registry, scoped registries, auth) as its userconfig; an install never writes it.
 * No arm's own `--env` reaches it: one install serves every arm that names the spec, and
 * the inherited network settings (`arm-env.ts`) are what npm needs to reach a registry.
 *
 * @param timeoutMs - The invocation's timeout, if any
 * @returns The installer
 */
export function npmInstaller(timeoutMs: number | undefined): NpxInstaller {
  return (spec, prefix, dirs) => {
    const npmEnv = { set: { npm_config_userconfig: operatorNpmUserconfig() }, unset: [] };
    const result = runCommand(
      { command: 'npm', leadingArgs: [] },
      ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', prefix, spec],
      { cwd: prefix, env: armStepEnvironment(dirs, npmEnv).env, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    );
    if (result.exitCode !== 0) {
      throw new Error(`npm install ${spec} failed (${String(result.spawnError ?? result.exitCode)}): ${result.stderr.trim()}`);
    }
  };
}

/**
 * @param armsRoot - The invocation's arms root
 * @param spec - The pinned spec
 * @returns The arm the spec is installed in; nothing is created
 */
export function npxInstallArm(armsRoot: string, spec: string): ArmDirectories {
  const build = spec.replaceAll(/[^\w.-]/gu, '-').replace(/^\.+/u, '');
  return armDirectories({ root: armsRoot, build, arm: INSTALL_ARM, state: 'cold' });
}

/**
 * @param entry - The cli entry an install holds
 * @returns The version its package's `package.json` names
 */
function cliVersionAt(entry: string): unknown {
  const manifest = safePath.join(entry, '..', '..', 'package.json');
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
}

/**
 * Run the entry with `--version` and require the version it reports to be the pin.
 *
 * @param entry - The cli entry about to be stamped
 * @param spec - The pinned spec, for the error message
 * @param version - The pinned version
 * @param dirs - The install arm, whose step environment it runs under
 * @throws {Error} when it does not run, or reports another version
 */
function requireReportedVersion(entry: string, spec: string, version: string, dirs: ArmDirectories): void {
  const ran = runCommand({ command: process.execPath, leadingArgs: [entry] }, ['--version'], {
    cwd: dirs.tmp,
    env: armStepEnvironment(dirs, EMPTY_ARM_ENVIRONMENT).env,
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  // The first token of the first line: `0.2.0-rc.11`, then `  binary: <path>` on the next.
  const reported = ran.stdout.trim().split(/\s/u)[0] ?? '';
  if (ran.exitCode !== 0 || reported !== version) {
    throw new Error(
      `the install of ${spec}: ${entry} --version reported '${reported}' (exit ${String(ran.spawnError ?? ran.exitCode)}), ` +
        `not ${version}: the report would name one build and measure another`,
    );
  }
}

/**
 * Install a pinned spec under the arms root and resolve it as `node <installed cli entry>`,
 * its closure the install's.
 *
 * The install is made in the arm's `tmp/`, emptied first, so an interrupted run leaves
 * it under the arms root — never in the system temp directory — for the next to clear.
 *
 * @param spec - The pinned spec
 * @param version - The version it pins
 * @param site - The arms root and installer
 * @returns The resolved instrument
 * @throws {Error} when the install holds no cli entry, or one of another version, or one that reports another
 */
export function installNpxInstrument(spec: string, version: string, site: NpxInstallSite): Promise<ResolvedInstrument> {
  const known = site.installs.get(spec);
  if (known !== undefined) return known;
  const installing = installOnce(spec, version, site);
  site.installs.set(spec, installing);
  return installing;
}

/**
 * {@link installNpxInstrument}, for a spec the site has not installed.
 *
 * @param spec - The pinned spec
 * @param version - The version it pins
 * @param site - The arms root and installer
 * @returns The resolved instrument
 */
async function installOnce(spec: string, version: string, site: NpxInstallSite): Promise<ResolvedInstrument> {
  const dirs = npxInstallArm(site.armsRoot, spec);
  prepareArmDirectories(dirs);
  const unclean = await resetColdArm(dirs);
  if (unclean !== null) throw armRefusal(`npx install arm: ${unclean}`);
  await resetArmHome(dirs);
  const prefix = mkdirSyncReal(safePath.join(dirs.tmp, 'install'));
  await site.install(spec, prefix, dirs);
  const name = spec.slice(0, spec.lastIndexOf('@'));
  // npm nests the cli under the named package when it cannot hoist it.
  const entry = [safePath.join(prefix, 'node_modules', name, CLI_ENTRY), safePath.join(prefix, CLI_ENTRY)].find((path) =>
    pathPresent(path, { follow: path }, everywhere('source'), 'probe'),
  );
  if (entry === undefined) throw new Error(`the install of ${spec} holds no ${CLI_ENTRY} to measure`);
  const installed = cliVersionAt(entry);
  if (installed !== version) {
    throw new Error(
      `the install of ${spec} resolved @vibe-agent-toolkit/cli ${String(installed)}, not ${version}: ` +
        'the report would name one build and measure another',
    );
  }
  requireReportedVersion(entry, spec, version, dirs);
  const closure = fingerprintFiles(safePath.join(prefix, 'node_modules'), { fromGit: false, exclude: [] }).fingerprint;
  return {
    command: process.execPath,
    leadingArgs: [entry],
    // No root: every file of the install sits under `node_modules`, which the io facet's site normalizer keys on.
    version: { version, commit: null, dirty: null, closure },
  };
}
