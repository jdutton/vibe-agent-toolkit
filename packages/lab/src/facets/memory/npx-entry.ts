/**
 * An `npx:` build, measured as the CLI's own entry point.
 *
 * `npx` runs the published package's `bin` — the cli's `dist/bin/vat.js` wrapper,
 * which re-resolves which vat to run from its cwd (the subject) and spawns it as
 * a SECOND vat process. A `tree:` or `dist:` build runs `dist/bin.js` straight.
 * So this facet installs the pinned spec once, into a directory of its own, and
 * runs `node <that install's @vibe-agent-toolkit/cli/dist/bin.js>`: the bytes the
 * spec names, one vat process per repeat, whatever the subject has installed.
 */

import { everywhere, pathPresent, safePath, withTempDir } from '@vibe-agent-toolkit/utils';

import { runCommand } from '../../harness/run.js';
import type { ResolvedInstrument, RunOptions } from '../../harness/types.js';

/** Installs a pinned npm spec under a prefix directory. */
type NpxInstaller = (spec: string, prefix: string) => Promise<void> | void;

/** The cli's entry point, relative to a package's directory. */
const CLI_ENTRY = 'node_modules/@vibe-agent-toolkit/cli/dist/bin.js';

/**
 * Install a pinned spec with npm, in the arm's environment.
 *
 * @param env - The arm's environment, so npm reaches the same registry npx would
 * @param timeoutMs - The capture's timeout, if any
 * @returns The installer
 */
export function npmInstaller(env: RunOptions['env'], timeoutMs: number | undefined): NpxInstaller {
  return (spec, prefix) => {
    const result = runCommand(
      { command: 'npm', leadingArgs: [] },
      ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--prefix', prefix, spec],
      { cwd: prefix, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    );
    if (result.exitCode !== 0) {
      throw new Error(`npm install ${spec} failed (${String(result.spawnError ?? result.exitCode)}): ${result.stderr.trim()}`);
    }
  };
}

/**
 * Run `body` with the instrument a memory repeat launches: a `tree:` or `dist:`
 * build as given, an `npx:` build as `node <installed cli entry>`.
 *
 * @param instrument - The resolved build
 * @param install - Installs the npx spec
 * @param body - The capture
 * @returns What `body` returns
 * @throws {Error} when the install holds no cli entry
 */
export async function withMemoryInstrument<T>(
  instrument: ResolvedInstrument,
  install: NpxInstaller,
  body: (instrument: ResolvedInstrument) => Promise<T>,
): Promise<T> {
  if (instrument.command !== 'npx') return body(instrument);
  const spec = instrument.leadingArgs.at(-1) ?? '';
  const { value, leftover } = await withTempDir('vat-lab-memory-npx-', async (prefix) => {
    await install(spec, prefix);
    const name = spec.slice(0, spec.lastIndexOf('@'));
    // npm nests the cli under the named package when it cannot hoist it.
    const entry = [safePath.join(prefix, 'node_modules', name, CLI_ENTRY), safePath.join(prefix, CLI_ENTRY)].find((path) =>
      pathPresent(path, { follow: path }, everywhere('source'), 'probe'),
    );
    if (entry === undefined) throw new Error(`the install of ${spec} holds no ${CLI_ENTRY} to measure`);
    return body({ ...instrument, command: process.execPath, leadingArgs: [entry] });
  });
  if (leftover !== undefined) throw leftover;
  return value;
}
