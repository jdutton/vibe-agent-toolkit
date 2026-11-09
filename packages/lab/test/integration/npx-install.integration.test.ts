/**
 * `resolveInstrument({ kind: 'npx' })`: an `npx:` build is resolved, for every
 * facet, as `node <cli>/dist/bin.js` from an install of the pinned spec — never
 * through npx and the package's cwd-resolving wrapper, which runs the SUBJECT'S
 * own vat when it has one. The install lands in an arm of its own under the arms
 * root; its cli must be the pinned version, and must REPORT it when run.
 *
 * The installer is a stand-in that lays fixture packages on disk — no network.
 * The real `npm install` (`npmInstaller`) is covered only for its arguments and
 * environment, below; a real registry install is not exercised here.
 *
 * Integration-tier: runs the installed entry with node.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ArmDirectories } from '../../src/harness/arm-dirs.js';
import type { ArmEnvironment } from '../../src/harness/arm-env.js';
import { resolveInstrument } from '../../src/harness/instrument.js';
import { type NpxInstaller, npxInstallArm, npxInstallSite } from '../../src/harness/npx-install.js';
import { runCommand } from '../../src/harness/run.js';

const VERSION = '0.1.43';
const SPEC = `vibe-agent-toolkit@${VERSION}`;
const CLI_DIR = 'node_modules/@vibe-agent-toolkit/cli';
const CLI_BIN = `${CLI_DIR}/dist/bin.js`;

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-npx-install-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** @returns A fresh arms root */
function armsRoot(): string {
  return mkdtempSync(safePath.join(scratch, 'arms-'));
}

/**
 * Lay the given files down under `root`.
 *
 * @param root - The directory
 * @param files - Paths relative to it, with their contents
 */
async function lay(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const path = safePath.join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/**
 * @param files - Paths relative to the prefix, with their contents
 * @returns An installer that lays them under the prefix, as a spy
 */
function installing(files: Readonly<Record<string, string>>): NpxInstaller & ReturnType<typeof vi.fn> {
  return vi.fn(async (_spec: string, prefix: string, _dirs: ArmDirectories) => lay(prefix, files));
}

/** A package manifest. */
function manifest(name: string, version: string, extra: object = {}): string {
  return JSON.stringify({ name, version, ...extra });
}

/** A cli entry that prints `reported` for `--version` (as vat does) and `label` otherwise. */
function entry(reported: string, label = 'cli entry'): string {
  return [
    "if (process.argv[2] === '--version') { process.stdout.write(" + JSON.stringify(`${reported}\n  binary: x\n`) + '); process.exit(0); }',
    `process.stdout.write(${JSON.stringify(label)});`,
    '',
  ].join('\n');
}

/** The cli's entry point and the manifest beside it, at `version`. */
function cliAt(version: string, under = '', reported = version): Record<string, string> {
  return {
    [`${under}${CLI_BIN}`]: entry(reported),
    [`${under}${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', version),
  };
}

/**
 * @param install - The installer
 * @param root - The arms root
 * @returns What `resolveInstrument` makes of the pinned spec
 */
function resolveNpx(install: NpxInstaller, root = armsRoot()): ReturnType<typeof resolveInstrument> {
  return resolveInstrument({ kind: 'npx', spec: SPEC }, npxInstallSite(root, install));
}

describe("resolveInstrument({ kind: 'npx' })", () => {
  it('resolves the pinned spec as node <installed cli>/dist/bin.js, installed under its own arm of the arms root', async () => {
    const install = installing(cliAt(VERSION));
    const root = armsRoot();

    const used = await resolveNpx(install, root);

    expect(install).toHaveBeenCalledWith(SPEC, expect.any(String), npxInstallArm(root, SPEC));
    // Both sides through `toForwardSlash`: the install dir is a native path, `\`-separated on Windows.
    expect(toForwardSlash(vi.mocked(install).mock.calls[0]?.[1] ?? '').startsWith(`${toForwardSlash(root)}/`)).toBe(true);
    expect(used.command).toBe(process.execPath);
    expect(used.leadingArgs).toHaveLength(1);
    expect(toForwardSlash(used.leadingArgs[0] ?? '')).toMatch(/\/node_modules\/@vibe-agent-toolkit\/cli\/dist\/bin\.js$/u);
    // No root, a fact rather than a gap: every file of the install sits under `node_modules`,
    // which the io facet's site normalizer already keys on; an arms-root path would mean nothing.
    expect(used.root).toBeUndefined();
    expect(used.version).toEqual({ version: VERSION, commit: null, dirty: null, closure: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(existsSync(npxInstallArm(root, SPEC).home)).toBe(true); // npm's HOME is the arm's, and exists
  });

  it("runs the pinned cli from a subject that has its own vat installed — never the subject's copy", async () => {
    // The defect: npx ran the package's wrapper, which delegated to the subject's
    // local @vibe-agent-toolkit/cli of ANOTHER version, under the pinned name.
    const subject = mkdtempSync(safePath.join(scratch, 'subject-'));
    await lay(subject, {
      'package.json': manifest('subject', '1.0.0', { devDependencies: { '@vibe-agent-toolkit/cli': '0.1.42' } }),
      [`${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', '0.1.42', { bin: { vat: './dist/bin/vat.js' } }),
      [CLI_BIN]: entry('0.1.42', "the subject's own vat"),
      [`${CLI_DIR}/dist/bin/vat.js`]: entry('0.1.42', "the subject's own vat"),
    });
    const used = await resolveNpx(installing(cliAt(VERSION)));

    const ran = runCommand({ command: used.command, leadingArgs: used.leadingArgs }, ['audit'], {
      cwd: subject,
      env: { set: {}, unset: [] },
    });

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe('cli entry');
  });

  it('installs one spec once per site: a second build naming it shares the install rather than emptying its arm', async () => {
    const install = installing(cliAt(VERSION));
    const site = npxInstallSite(armsRoot(), install);
    const source = { kind: 'npx', spec: SPEC } as const;

    const [first, second] = await Promise.all([resolveInstrument(source, site), resolveInstrument(source, site)]);

    expect(install).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(existsSync(first.leadingArgs[0] ?? '')).toBe(true);
  });

  it("stamps the install's whole node_modules as the closure, third-party dependencies included", async () => {
    const closure = async (dependency: string): Promise<string | null> =>
      (await resolveNpx(installing({ ...cliAt(VERSION), 'node_modules/left-pad/index.js': dependency }))).version.closure;

    const first = await closure('module.exports = 1;');
    expect(await closure('module.exports = 1;')).toBe(first);
    expect(await closure('module.exports = 2;')).not.toBe(first);
  });

  it('prefers the cli nested under the named package over a hoisted one', async () => {
    const used = await resolveNpx(installing({ ...cliAt(VERSION), ...cliAt(VERSION, 'node_modules/vibe-agent-toolkit/') }));

    expect(toForwardSlash(used.leadingArgs[0] ?? '')).toContain('/node_modules/vibe-agent-toolkit/node_modules/');
  });

  it('refuses an install that holds no cli entry, naming the spec', async () => {
    await expect(resolveNpx(installing({}))).rejects.toThrow(SPEC);
  });

  it('refuses an install whose cli manifest is not the pinned version, naming both', async () => {
    await expect(resolveNpx(installing(cliAt('0.1.42')))).rejects.toThrow(/0\.1\.42.*0\.1\.43|0\.1\.43.*0\.1\.42/u);
  });

  it('refuses an entry that REPORTS another version than the pin, though its manifest names the pin', async () => {
    // Any delegation the entry might do — to a local install, a global one — shows here.
    await expect(resolveNpx(installing(cliAt(VERSION, '', '0.1.42')))).rejects.toThrow(/--version reported '0\.1\.42'.*not 0\.1\.43/u);
  });

  it('refuses an entry that does not run', async () => {
    const files = { ...cliAt(VERSION), [CLI_BIN]: 'process.exit(3);\n' };

    await expect(resolveNpx(installing(files))).rejects.toThrow(/--version reported '' \(exit 3\)/u);
  });

  it('measures the published layout: the umbrella package, its cli dependency, and the cli entry run straight', async () => {
    // As npm lays out `vibe-agent-toolkit@<v>`: the umbrella's `bin` is a wrapper, and its cli
    // dependency is hoisted beside it. Running the resolved entry proves which file ran.
    const files = {
      'node_modules/vibe-agent-toolkit/package.json': manifest('vibe-agent-toolkit', VERSION, {
        bin: { vat: './bin/vat' },
        dependencies: { '@vibe-agent-toolkit/cli': VERSION },
      }),
      'node_modules/vibe-agent-toolkit/bin/vat': 'process.stdout.write("umbrella wrapper");\n',
      [`${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', VERSION, { bin: { vat: './dist/bin/vat.js' } }),
      [`${CLI_DIR}/dist/bin/vat.js`]: 'process.stdout.write("cli wrapper");\n',
      [CLI_BIN]: entry(VERSION),
    };

    const used = await resolveNpx(installing(files));
    const ran = runCommand({ command: used.command, leadingArgs: used.leadingArgs }, [], { cwd: scratch, env: { set: {}, unset: [] } });

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe('cli entry');
  });
});

describe('npmInstaller', () => {
  it('installs with lifecycle scripts off, in the install arm, into its npm cache', async () => {
    vi.resetModules();
    // An inherited userconfig, in any case, would win over ~/.npmrc.
    for (const name of Object.keys(process.env).filter((key) => key.toLowerCase() === 'npm_config_userconfig')) vi.stubEnv(name, undefined);
    const calls: { args: readonly string[]; env: ArmEnvironment }[] = [];
    vi.doMock('../../src/harness/run.js', () => ({
      runCommand: (_command: unknown, args: readonly string[], options: { env: ArmEnvironment }) => {
        calls.push({ args, env: options.env });
        return { exitCode: 0, stdout: '', stderr: '', wallMs: 0, spawnError: undefined };
      },
    }));
    const { npmInstaller } = await import('../../src/harness/npx-install.js');
    const dirs = npxInstallArm(armsRoot(), SPEC);

    await npmInstaller(undefined)(SPEC, safePath.join(dirs.tmp, 'install'), dirs);
    vi.doUnmock('../../src/harness/run.js');
    vi.unstubAllEnvs();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('--ignore-scripts');
    expect(calls[0]?.env.set['npm_config_cache']).toBe(dirs.npmCache);
    // The arm's HOME holds no .npmrc: the operator's registry, scopes and auth come from theirs.
    expect(calls[0]?.env.set['npm_config_userconfig']).toBe(safePath.join(homedir(), '.npmrc'));
  });
});
