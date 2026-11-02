/**
 * An `npx:` build, measured as the CLI's own entry point.
 *
 * `npx` runs the published package's `bin` — the cli's `dist/bin/vat.js` wrapper,
 * which re-resolves which vat to run from its cwd (the subject) and spawns it as
 * a SECOND vat process. A `tree:` or `dist:` build runs `dist/bin.js` straight.
 * So this facet installs the pinned spec once, into an arm of its own under the
 * arms root, and runs `node <that install's @vibe-agent-toolkit/cli/dist/bin.js>`:
 * one vat process per repeat, whatever the subject has installed. npm resolves the
 * cli as a DEPENDENCY of the spec, so the cli's own `package.json` must name the
 * version the coordinate does, or the install is refused.
 */

import { readFileSync } from 'node:fs';

import { everywhere, mkdirSyncReal, pathPresent, safePath } from '@vibe-agent-toolkit/utils';

import {
  type ArmDirectories,
  armDirectories,
  armRefusal,
  armStepEnvironment,
  prepareArmDirectories,
  resetColdArm,
} from '../../harness/arm-dirs.js';
import type { ArmEnvironment } from '../../harness/arm-env.js';
import { runCommand } from '../../harness/run.js';
import type { CacheMode, CaptureArms, ResolvedInstrument } from '../../harness/types.js';

/** Installs a pinned npm spec under a prefix directory. */
type NpxInstaller = (spec: string, prefix: string) => Promise<void> | void;

/** The cli's package directory, relative to an install's directory. */
const CLI_DIR = 'node_modules/@vibe-agent-toolkit/cli';

/** The cli's entry point, relative to an install's directory. */
const CLI_ENTRY = `${CLI_DIR}/dist/bin.js`;

/** The install arm's name: a measured command's arm is named by the command. */
const INSTALL_ARM = 'memory-npx-install';

/**
 * @param arms - The capture's arms root and build alias
 * @param cache - The capture's cache mode
 * @returns The directories of the arm an `npx:` build is installed in; nothing is created
 */
export function npxInstallArm(arms: CaptureArms, cache: CacheMode): ArmDirectories {
  return armDirectories({ root: arms.root, build: arms.build, arm: INSTALL_ARM, state: cache });
}

/**
 * Install a pinned spec with npm, in the install arm's environment — its npm cache,
 * temp directory and home — with lifecycle scripts off: the lab measures vat, never
 * runs a package's install hooks.
 *
 * @param dirs - The install arm
 * @param env - The capture's arm environment, so npm reaches the same registry
 * @param timeoutMs - The capture's timeout, if any
 * @returns The installer
 */
export function npmInstaller(dirs: ArmDirectories, env: ArmEnvironment, timeoutMs: number | undefined): NpxInstaller {
  return (spec, prefix) => {
    const result = runCommand(
      { command: 'npm', leadingArgs: [] },
      ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', prefix, spec],
      { cwd: prefix, env: armStepEnvironment(dirs, env).env, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    );
    if (result.exitCode !== 0) {
      throw new Error(`npm install ${spec} failed (${String(result.spawnError ?? result.exitCode)}): ${result.stderr.trim()}`);
    }
  };
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
 * Run `body` with the instrument a memory repeat launches: a `tree:` or `dist:`
 * build as given, an `npx:` build as `node <installed cli entry>`.
 *
 * The install is made in `dirs.tmp`, emptied first, so an interrupted capture leaves
 * it under the arms root — never in the system temp directory — for the next to clear.
 *
 * @param instrument - The resolved build
 * @param dirs - The install arm ({@link npxInstallArm})
 * @param install - Installs the npx spec
 * @param body - The capture
 * @returns What `body` returns
 * @throws {Error} when the install holds no cli entry, or one of another version
 */
export async function withMemoryInstrument<T>(
  instrument: ResolvedInstrument,
  dirs: ArmDirectories,
  install: NpxInstaller,
  body: (instrument: ResolvedInstrument) => Promise<T>,
): Promise<T> {
  if (instrument.command !== 'npx') return body(instrument);
  const spec = instrument.leadingArgs.at(-1) ?? '';
  prepareArmDirectories(dirs);
  const unclean = await resetColdArm(dirs);
  if (unclean !== null) throw armRefusal(`npx install arm: ${unclean}`);
  const prefix = mkdirSyncReal(safePath.join(dirs.tmp, 'install'));
  await install(spec, prefix);
  const name = spec.slice(0, spec.lastIndexOf('@'));
  // npm nests the cli under the named package when it cannot hoist it.
  const entry = [safePath.join(prefix, 'node_modules', name, CLI_ENTRY), safePath.join(prefix, CLI_ENTRY)].find((path) =>
    pathPresent(path, { follow: path }, everywhere('source'), 'probe'),
  );
  if (entry === undefined) throw new Error(`the install of ${spec} holds no ${CLI_ENTRY} to measure`);
  const installed = cliVersionAt(entry);
  if (installed !== instrument.version.version) {
    throw new Error(
      `the install of ${spec} resolved @vibe-agent-toolkit/cli ${String(installed)}, not ${instrument.version.version}: ` +
        'the report would name one build and measure another',
    );
  }
  return body({ ...instrument, command: process.execPath, leadingArgs: [entry] });
}
