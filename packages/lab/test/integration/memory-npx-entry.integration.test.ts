/**
 * `withMemoryInstrument`: an `npx:` build is measured as `node <cli>/dist/bin.js`
 * from an install of the pinned spec — never through npx and the package's
 * cwd-resolving wrapper, which is a second vat process the other kinds never run.
 * The install lands in an arm of its own under the arms root, and its cli must be
 * the version the coordinate names.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { npxInstallArm, withMemoryInstrument } from '../../src/facets/memory/npx-entry.js';
import type { ArmEnvironment } from '../../src/harness/arm-env.js';
import { runCommand } from '../../src/harness/run.js';
import type { ResolvedInstrument } from '../../src/harness/types.js';

const VERSION = '0.1.43';
const SPEC = `vibe-agent-toolkit@${VERSION}`;
const NPX: ResolvedInstrument = {
  command: 'npx',
  leadingArgs: ['--yes', SPEC],
  version: { version: VERSION, commit: null, dirty: null, closure: null },
};
const CLI_DIR = 'node_modules/@vibe-agent-toolkit/cli';
const CLI_BIN = `${CLI_DIR}/dist/bin.js`;

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-npx-entry-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh install arm under a fresh arms root. */
function installArm(): ReturnType<typeof npxInstallArm> {
  return npxInstallArm({ root: mkdtempSync(safePath.join(scratch, 'arms-')), build: VERSION }, 'warm');
}

/**
 * An installer that lays down the given files under the prefix.
 *
 * @param files - Paths relative to the prefix, with their contents
 * @returns The installer, as a spy
 */
function installing(files: Readonly<Record<string, string>>): (spec: string, prefix: string) => Promise<void> {
  return vi.fn(async (_spec: string, prefix: string) => {
    for (const [file, content] of Object.entries(files)) {
      const path = safePath.join(prefix, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  });
}

/** A package manifest. */
function manifest(name: string, version: string, extra: object = {}): string {
  return JSON.stringify({ name, version, type: 'module', ...extra });
}

/** The cli's entry point and the manifest beside it, at `version`. */
function cliAt(version: string, under = ''): Record<string, string> {
  return {
    [`${under}${CLI_BIN}`]: '',
    [`${under}${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', version),
  };
}

describe('withMemoryInstrument', () => {
  it('runs a tree: or dist: build as given, installing nothing', async () => {
    const tree: ResolvedInstrument = { ...NPX, command: process.execPath, leadingArgs: ['/x/dist/bin.js'] };
    const install = installing({});

    await expect(withMemoryInstrument(tree, installArm(), install, async (used) => used)).resolves.toBe(tree);
    expect(install).not.toHaveBeenCalled();
  });

  it('runs an npx: build as node <installed cli>/dist/bin.js, installed under its own arm', async () => {
    const install = installing(cliAt(VERSION));
    const dirs = installArm();

    const used = await withMemoryInstrument(NPX, dirs, install, async (instrument) => instrument);

    expect(install).toHaveBeenCalledWith(SPEC, expect.any(String));
    expect(vi.mocked(install).mock.calls[0]?.[1].startsWith(`${dirs.root}/`)).toBe(true);
    expect(used.command).toBe(process.execPath);
    expect(used.leadingArgs).toHaveLength(1);
    expect(used.leadingArgs[0]).toMatch(/\/node_modules\/@vibe-agent-toolkit\/cli\/dist\/bin\.js$/);
    expect(used.version).toEqual({ ...NPX.version, closure: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(existsSync(dirs.home)).toBe(true); // npm's HOME is the arm's, and exists
  });

  it("stamps the install's whole node_modules as the closure, third-party dependencies included", async () => {
    const closure = async (dependency: string): Promise<string | null> => {
      const files = { ...cliAt(VERSION), 'node_modules/left-pad/index.js': dependency };
      return (await withMemoryInstrument(NPX, installArm(), installing(files), async (instrument) => instrument)).version.closure;
    };

    const first = await closure('module.exports = 1;');
    expect(await closure('module.exports = 1;')).toBe(first);
    expect(await closure('module.exports = 2;')).not.toBe(first);
  });

  it('prefers the cli nested under the named package over a hoisted one', async () => {
    const files = { ...cliAt(VERSION), ...cliAt(VERSION, 'node_modules/vibe-agent-toolkit/') };
    const used = await withMemoryInstrument(NPX, installArm(), installing(files), async (instrument) => instrument);

    expect(used.leadingArgs[0]).toContain('/node_modules/vibe-agent-toolkit/node_modules/');
  });

  it('refuses an install that holds no cli entry, naming the spec', async () => {
    await expect(withMemoryInstrument(NPX, installArm(), installing({}), async () => 0)).rejects.toThrow(SPEC);
  });

  it('refuses an install whose cli is not the version the coordinate names, naming both', async () => {
    const run = withMemoryInstrument(NPX, installArm(), installing(cliAt('0.1.42')), async () => 0);

    await expect(run).rejects.toThrow(/0\.1\.42.*0\.1\.43|0\.1\.43.*0\.1\.42/);
  });

  it('measures the published layout: the umbrella package, its cli dependency, and the cli entry run straight', async () => {
    // As npm lays out `vibe-agent-toolkit@<v>`: the umbrella's `bin` is a wrapper, and its cli
    // dependency is hoisted beside it. The entry here prints what it is, so running it proves which file ran.
    const files = {
      'node_modules/vibe-agent-toolkit/package.json': manifest('vibe-agent-toolkit', VERSION, {
        bin: { vat: './bin/vat' },
        dependencies: { '@vibe-agent-toolkit/cli': VERSION },
      }),
      'node_modules/vibe-agent-toolkit/bin/vat': 'process.stdout.write("umbrella wrapper");\n',
      [`${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', VERSION, { bin: { vat: './dist/bin/vat.js' } }),
      [`${CLI_DIR}/dist/bin/vat.js`]: 'process.stdout.write("cli wrapper");\n',
      [CLI_BIN]: 'process.stdout.write("cli entry");\n',
    };

    const ran = await withMemoryInstrument(NPX, installArm(), installing(files), async (instrument) =>
      runCommand({ command: instrument.command, leadingArgs: instrument.leadingArgs }, [], { cwd: scratch, env: { set: {}, unset: [] } }),
    );

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe('cli entry');
  });
});

describe('npmInstaller', () => {
  it('installs with lifecycle scripts off, in the install arm, into its npm cache', async () => {
    vi.resetModules();
    const calls: { args: readonly string[]; env: ArmEnvironment }[] = [];
    vi.doMock('../../src/harness/run.js', () => ({
      runCommand: (_command: unknown, args: readonly string[], options: { env: ArmEnvironment }) => {
        calls.push({ args, env: options.env });
        return { exitCode: 0, stdout: '', stderr: '', wallMs: 0, spawnError: undefined };
      },
    }));
    const { npmInstaller } = await import('../../src/facets/memory/npx-entry.js');
    const dirs = installArm();

    await npmInstaller(dirs, { set: {}, unset: [] }, undefined)(SPEC, safePath.join(dirs.tmp, 'install'));
    vi.doUnmock('../../src/harness/run.js');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('--ignore-scripts');
    expect(calls[0]?.env.set['npm_config_cache']).toBe(dirs.npmCache);
    // The arm's HOME holds no .npmrc: the operator's registry, scopes and auth come from theirs.
    expect(calls[0]?.env.set['npm_config_userconfig']).toBe(safePath.join(homedir(), '.npmrc'));
  });
});
