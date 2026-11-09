/**
 * `resolveInstrument({ kind: 'npx' })`: an `npx:` build is resolved, for every
 * facet, as `node <cli>/dist/bin.js` from an install of the pinned spec — never
 * through npx and the package's cwd-resolving wrapper, which runs the SUBJECT'S
 * own vat when it has one. The install lands in an arm of its own under the arms
 * root; its cli's manifest must name the pinned version, its entry must lie inside
 * the install, and it must start.
 *
 * The installer is a stand-in that lays fixture packages on disk — no network.
 * The real `npm install` (`npmInstall`) is covered only for its arguments and
 * environment, below; a real registry install is not exercised here.
 *
 * Integration-tier: runs the installed entry with node.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { createSymlinkAsync, isVatError, normalizedTmpdir, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { underTemp } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ARM_REFUSED_CODE, type ArmDirectories, armDirectories } from '../../src/harness/arm-dirs.js';
import type { ArmEnvironment } from '../../src/harness/arm-env.js';
import { prepareInstrument, resolveInstrument } from '../../src/harness/instrument.js';
import {
  NPX_INSTALL_TIMEOUT_MS,
  type NpxInstallSite,
  type NpxInstaller,
  locateNpmCli,
  npxInstallArm,
  npxInstallSite,
} from '../../src/harness/npx-install.js';
import type * as RunModule from '../../src/harness/run.js';
import { runCommand } from '../../src/harness/run.js';
import type { InstrumentSource } from '../../src/harness/types.js';
import { distinctSlug } from '../../src/store.js';
import { layFakeNode } from '../npm-fixtures.js';

/**
 * Both phases a verb runs, back to back.
 *
 * @param source - The build as named
 * @param site - Where an `npx:` build installs
 * @returns The resolved build
 */
async function resolveSource(source: InstrumentSource, site: NpxInstallSite): ReturnType<typeof resolveInstrument> {
  return resolveInstrument(await prepareInstrument(source), site);
}

const VERSION = '0.1.43';
const SPEC = `vibe-agent-toolkit@${VERSION}`;
const CLI_DIR = 'node_modules/@vibe-agent-toolkit/cli';
const CLI_BIN = `${CLI_DIR}/dist/bin.js`;
/** A VAT package the cli depends on, hoisted beside it. */
const UTILS = '@vibe-agent-toolkit/utils';

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
function cliAt(version: string, under = ''): Record<string, string> {
  return {
    [`${under}${CLI_BIN}`]: entry(version),
    [`${under}${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', version),
  };
}

/**
 * @param install - The installer
 * @param root - The arms root
 * @returns What `resolveInstrument` makes of the pinned spec
 */
function resolveNpx(install: NpxInstaller, root = armsRoot()): ReturnType<typeof resolveInstrument> {
  return resolveSource({ kind: 'npx', spec: SPEC }, npxInstallSite(root, install));
}

/**
 * Every install refusal is an arm refusal: the CLI prints it as one `REFUSED:` line.
 *
 * @param pending - A resolution expected to be refused
 * @param message - What the refusal must say: a pattern, or text it must contain
 */
async function expectRefusal(pending: Promise<unknown>, message: RegExp | string): Promise<void> {
  const outcome = await pending.then(() => null, (error: unknown) => error);
  expect(isVatError(outcome, ARM_REFUSED_CODE), `not an arm refusal: ${String(outcome)}`).toBe(true);
  expect((outcome as Error).message).toMatch(message);
}

/**
 * @param over - Files laid over a cli that depends on a hoisted VAT sibling and a third-party package
 * @returns Those files
 */
function closureInstall(over: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    ...cliAt(VERSION),
    [`${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', VERSION, {
      dependencies: { [UTILS]: VERSION, 'left-pad': '^1.0.0' },
    }),
    [`node_modules/${UTILS}/package.json`]: manifest(UTILS, VERSION),
    [`node_modules/${UTILS}/dist/index.js`]: 'export const utils = 1;\n',
    'node_modules/left-pad/package.json': manifest('left-pad', '1.0.0'),
    'node_modules/left-pad/index.js': 'module.exports = 1;\n',
    ...over,
  };
}

/**
 * @param files - The install
 * @param spec - The spec it is installed as
 * @returns The closure the npx: build stamps
 */
async function npxClosure(files: Readonly<Record<string, string>>, spec = SPEC): Promise<string> {
  return (await resolveSource({ kind: 'npx', spec }, npxInstallSite(armsRoot(), installing(files)))).version.closure;
}

/** An optional peer the cli declares and the lab does not install. */
const RAG = '@vibe-agent-toolkit/rag';

/** The installed entry's code: on `peer`, what `./peer.js` loaded, or the error's code and message. */
const PEER_ENTRY = [
  "if (process.argv[2] === 'peer') {",
  "  await import('./peer.js').then((peer) => process.stdout.write(peer.loaded), (error) => process.stdout.write(String(error.code) + ': ' + String(error.message)));",
  '} else {',
  `  process.stdout.write(${JSON.stringify(VERSION + '\n')});`,
  '}',
  '',
].join('\n');

/**
 * A cli that declares {@link RAG} an optional peer, and on `peer` imports a named binding
 * from it the way the cli's rag lane does (a lazily imported module with a static import),
 * printing what it loaded or the error code.
 *
 * @returns The cli's files
 */
function cliWithOptionalPeer(): Record<string, string> {
  return {
    ...cliAt(VERSION),
    [`${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', VERSION, {
      type: 'module',
      peerDependencies: { [RAG]: VERSION },
      peerDependenciesMeta: { [RAG]: { optional: true } },
    }),
    [CLI_BIN]: PEER_ENTRY,
    [`${CLI_DIR}/dist/peer.js`]: `import { which } from '${RAG}';\nexport const loaded = which;\n`,
  };
}

/**
 * @param which - What its `which` export says
 * @returns The files of a {@link RAG} package in the `node_modules` of the directory laid into
 */
function ragPackage(which: string): Record<string, string> {
  return {
    // Under `dist/`, as a VAT package ships: an installed optional peer is part of the closure.
    [`node_modules/${RAG}/package.json`]: manifest(RAG, VERSION, { type: 'module', exports: './dist/index.js' }),
    [`node_modules/${RAG}/dist/index.js`]: `export const which = ${JSON.stringify(which)};\n`,
  };
}

/**
 * @param files - The install
 * @param planted - A package planted in a `node_modules` ABOVE the arms root
 * @param argument - What the installed entry is run with
 * @returns What the installed entry printed, run from a cwd outside the arms root
 */
async function peerFrom(
  files: Readonly<Record<string, string>>,
  planted: Readonly<Record<string, string>> = ragPackage('planted above the install'),
  argument = 'peer',
): Promise<string> {
  // A package planted in a node_modules ABOVE the arms root, where Node's walk reaches
  // when the install lacks the peer: `/tmp/node_modules` on Linux is world-writable.
  // Planted AFTER the install, which refuses an ancestor `node_modules` it can see.
  const ancestor = mkdtempSync(safePath.join(scratch, 'ancestor-'));
  const root = mkdtempSync(safePath.join(ancestor, 'arms-'));
  const used = await resolveNpx(installing(files), root);
  await lay(ancestor, planted);
  return runCommand({ command: used.command, leadingArgs: used.leadingArgs }, [argument], {
    cwd: scratch,
    env: { set: {}, unset: [] },
  }).stdout;
}

/** An optional peer a THIRD-PARTY package of the install declares, and the lab does not install. */
const CHAIN_PEER = 'chain-optional-peer';

/**
 * A cli (CommonJS) that, on `chain`, loads a third-party package `chain` which try-requires
 * {@link CHAIN_PEER} — declared optional in `chain`'s own manifest, not the cli's.
 *
 * @returns The install's files
 */
function cliWithThirdPartyOptionalPeer(): Record<string, string> {
  return {
    ...cliAt(VERSION),
    [CLI_BIN]: [
      "if (process.argv[2] === 'chain') { process.stdout.write(String(require('chain'))); }",
      `else { process.stdout.write(${JSON.stringify(VERSION + '\n')}); }`,
      '',
    ].join('\n'),
    'node_modules/chain/package.json': manifest('chain', '1.0.0', {
      main: 'index.js',
      peerDependencies: { [CHAIN_PEER]: '*' },
      peerDependenciesMeta: { [CHAIN_PEER]: { optional: true } },
    }),
    'node_modules/chain/index.js': `try { module.exports = require('${CHAIN_PEER}'); } catch (error) { module.exports = 'absent: ' + error.code; }\n`,
  };
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

  it("hands back node and the install's own dist/bin.js — never npx, never the vat a subject has installed", async () => {
    // The defect: npx ran the package's wrapper, which delegated to the subject's
    // local @vibe-agent-toolkit/cli of ANOTHER version, under the pinned name. What this
    // proves is the resolver's answer: the command is node and the entry is the install's
    // `bin.js`, wherever the subject is. That the real `bin.js` itself delegates to no other
    // copy is a property of the cli, which a fixture entry cannot model.
    const subject = mkdtempSync(safePath.join(scratch, 'subject-'));
    await lay(subject, {
      'package.json': manifest('subject', '1.0.0', { devDependencies: { '@vibe-agent-toolkit/cli': '0.1.42' } }),
      [`${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', '0.1.42', { bin: { vat: './dist/bin/vat.js' } }),
      [CLI_BIN]: entry('0.1.42', "the subject's own vat"),
      [`${CLI_DIR}/dist/bin/vat.js`]: entry('0.1.42', "the subject's own vat"),
    });
    const root = armsRoot();
    const used = await resolveNpx(installing(cliAt(VERSION)), root);

    const ran = runCommand({ command: used.command, leadingArgs: used.leadingArgs }, ['audit'], {
      cwd: subject,
      env: { set: {}, unset: [] },
    });

    expect(used.command).toBe(process.execPath);
    expect(toForwardSlash(used.leadingArgs[0] ?? '')).toBe(toForwardSlash(safePath.join(underTemp(npxInstallArm(root, SPEC).tmp, root), 'install', CLI_BIN)));
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe('cli entry');
  });

  it('installs one spec once per site: a second build naming it shares the install rather than emptying its arm', async () => {
    const install = installing(cliAt(VERSION));
    const site = npxInstallSite(armsRoot(), install);
    const source = { kind: 'npx', spec: SPEC } as const;

    const [first, second] = await Promise.all([resolveSource(source, site), resolveSource(source, site)]);

    expect(install).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(existsSync(first.leadingArgs[0] ?? '')).toBe(true);
  });

  describe('closure: the one definition every kind stamps', () => {
    it('stamps the umbrella and the cli installs of one version as one closure', async () => {
      const umbrella = closureInstall({
        'node_modules/vibe-agent-toolkit/package.json': manifest('vibe-agent-toolkit', VERSION, {
          dependencies: { '@vibe-agent-toolkit/cli': VERSION },
        }),
        'node_modules/vibe-agent-toolkit/bin/vat': 'process.stdout.write("umbrella wrapper");\n',
      });

      expect(await npxClosure(umbrella)).toBe(await npxClosure(closureInstall(), `@vibe-agent-toolkit/cli@${VERSION}`));
    });

    it('stamps the closure a dist: build of the same installed cli stamps', async () => {
      const used = await resolveNpx(installing(closureInstall()));
      const cliDist = dirname(used.leadingArgs[0] ?? '');
      const never = npxInstallSite(armsRoot(), () => {
        throw new Error('a dist: build installs nothing');
      });

      expect((await resolveSource({ kind: 'dist', path: cliDist }, never)).version.closure).toBe(used.version.closure);
    });

    it('moves when a third-party package of the closure resolves at another version', async () => {
      expect(await npxClosure(closureInstall({ 'node_modules/left-pad/package.json': manifest('left-pad', '1.0.1') }))).not.toBe(
        await npxClosure(closureInstall()),
      );
    });

    it('does not move when a third-party package changes its bytes at the same version', async () => {
      expect(await npxClosure(closureInstall({ 'node_modules/left-pad/index.js': 'module.exports = 2;\n' }))).toBe(
        await npxClosure(closureInstall()),
      );
    });

    it('refuses a @vibe-agent-toolkit/* dependency the install lacks', async () => {
      const files = Object.fromEntries(Object.entries(closureInstall()).filter(([path]) => !toForwardSlash(path).startsWith(`node_modules/${UTILS}/`)));

      await expectRefusal(resolveNpx(installing(files)), /@vibe-agent-toolkit\/utils is declared by @vibe-agent-toolkit\/cli but does not resolve/u);
    });

    it('follows an optional peer the install holds: its bytes move the closure', async () => {
      const withRag = (which: string): Record<string, string> => ({
        ...closureInstall({
          [`${CLI_DIR}/package.json`]: manifest('@vibe-agent-toolkit/cli', VERSION, {
            dependencies: { [UTILS]: VERSION, 'left-pad': '^1.0.0' },
            peerDependencies: { [RAG]: VERSION },
            peerDependenciesMeta: { [RAG]: { optional: true } },
          }),
        }),
        [`node_modules/${RAG}/package.json`]: manifest(RAG, VERSION),
        [`node_modules/${RAG}/dist/index.js`]: `export const which = ${JSON.stringify(which)};\n`,
      });

      expect(await npxClosure(withRag('one'))).not.toBe(await npxClosure(withRag('two')));
    });

    it('moves when a @vibe-agent-toolkit/* package of the closure changes', async () => {
      expect(await npxClosure(closureInstall({ [`node_modules/${UTILS}/dist/index.js`]: 'export const utils = 2;\n' }))).not.toBe(
        await npxClosure(closureInstall()),
      );
    });
  });

  describe('optional peers: module resolution stays inside the install', () => {
    it('resolves an absent optional peer to the lab\'s stub, never a package planted above the install', async () => {
      const printed = await peerFrom(cliWithOptionalPeer());

      expect(printed).not.toContain('planted above the install');
      // A named import, as the cli's rag lane makes: the stub must fail it as "not installed"
      // (the code the cli's `isModuleMissing` reads), not as a missing export.
      expect(printed).toMatch(/^ERR_MODULE_NOT_FOUND: .*vat-lab-does-not-install-optional-peers/u);
    });

    it('stubs an optional peer a third-party package of the install declares, never loading one planted above', async () => {
      const printed = await peerFrom(
        cliWithThirdPartyOptionalPeer(),
        {
          [`node_modules/${CHAIN_PEER}/package.json`]: manifest(CHAIN_PEER, '1.0.0', { main: 'index.js' }),
          [`node_modules/${CHAIN_PEER}/index.js`]: "module.exports = 'planted above the install';\n",
        },
        'chain',
      );

      expect(printed).toBe('absent: MODULE_NOT_FOUND');
    });

    it('leaves an optional peer the install holds as it was installed', async () => {
      expect(await peerFrom({ ...cliWithOptionalPeer(), ...ragPackage('installed') })).toBe('installed');
    });

    it('stubs no name an installed package lists in optionalDependencies: npm skipped it, and absent it stays', async () => {
      const root = armsRoot();
      const files = {
        ...cliWithThirdPartyOptionalPeer(),
        'node_modules/platform-user/package.json': manifest('platform-user', '1.0.0', { optionalDependencies: { [CHAIN_PEER]: '*' } }),
      };

      await resolveNpx(installing(files), root);

      expect(existsSync(safePath.join(npxInstallArm(root, SPEC).tmp, 'install', 'node_modules', CHAIN_PEER))).toBe(false);
    });

    it('skips an optional peer whose name is not a valid package name, rather than refusing the install', async () => {
      const files = {
        ...cliAt(VERSION),
        'node_modules/legacy/package.json': manifest('legacy', '1.0.0', {
          peerDependencies: { LegacyPeer: '*' },
          peerDependenciesMeta: { LegacyPeer: { optional: true } },
        }),
      };
      const root = armsRoot();

      await expect(resolveNpx(installing(files), root)).resolves.toMatchObject({ version: { version: VERSION } });
      expect(existsSync(safePath.join(npxInstallArm(root, SPEC).tmp, 'install', 'node_modules', 'LegacyPeer'))).toBe(false);
    });
  });

  describe('the layout: hoisted, real directories, nothing to resolve above the install', () => {
    it('refuses an install below a directory holding a node_modules, naming it', async () => {
      // Node's walk would reach it for any name the install lacks: on a shared host, another user's planting.
      const ancestor = mkdtempSync(safePath.join(scratch, 'ancestor-'));
      await lay(ancestor, { 'node_modules/anything/package.json': manifest('anything', '1.0.0') });
      const root = mkdtempSync(safePath.join(ancestor, 'arms-'));
      const install = installing(cliAt(VERSION));

      await expectRefusal(resolveNpx(install, root), `${toForwardSlash(safePath.join(ancestor, 'node_modules'))} lies above its prefix`);
      expect(install).not.toHaveBeenCalled();
    });

    it('refuses an install that holds a node_modules/.store: npm laid it out linked, not hoisted', async () => {
      await expectRefusal(
        resolveNpx(installing({ ...cliAt(VERSION), 'node_modules/.store/left-pad@1.0.0/node_modules/left-pad/package.json': manifest('left-pad', '1.0.0') })),
        /node_modules\/\.store/u,
      );
    });

    it('refuses an install whose package directory is a link, though it points inside the install', async ({ skip }) => {
      const capability = symlinkCapability() ?? skip();
      const install = vi.fn(async (_spec: string, prefix: string) => {
        await lay(prefix, { ...cliAt(VERSION), 'node_modules/real-left-pad/package.json': manifest('left-pad', '1.0.0') });
        await createSymlinkAsync(
          capability,
          safePath.join(prefix, 'node_modules/real-left-pad'),
          safePath.join(prefix, 'node_modules/left-pad'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      });

      await expectRefusal(resolveNpx(install), /node_modules\/left-pad is a link/u);
    });
  });

  it('refuses an installed cli whose manifest names another package, though its version is the pin', async () => {
    // An alias (`"@vibe-agent-toolkit/cli": "npm:other@0.1.43"`) installs other code under the
    // cli's directory, and npm keeps the real package's name in its manifest.
    const files = { ...cliAt(VERSION), [`${CLI_DIR}/package.json`]: manifest('other', VERSION) };

    await expectRefusal(resolveNpx(installing(files)), /@vibe-agent-toolkit\/cli resolved to "other"/u);
  });

  it("resolves @vibe-agent-toolkit/cli as the hoisted cli, never a copy under that cli's own node_modules", async () => {
    const spec = `@vibe-agent-toolkit/cli@${VERSION}`;
    const files = { ...cliAt(VERSION), ...cliAt(VERSION, `${CLI_DIR}/`), [`${CLI_DIR}/${CLI_BIN}`]: entry(VERSION, 'a bundled copy') };

    const used = await resolveSource({ kind: 'npx', spec }, npxInstallSite(armsRoot(), installing(files)));
    const ran = runCommand({ command: used.command, leadingArgs: used.leadingArgs }, [], { cwd: scratch, env: { set: {}, unset: [] } });

    expect(ran.stdout).toBe('cli entry');
  });

  it('prefers the cli nested under the named package over a hoisted one', async () => {
    const used = await resolveNpx(installing({ ...cliAt(VERSION), ...cliAt(VERSION, 'node_modules/vibe-agent-toolkit/') }));

    expect(toForwardSlash(used.leadingArgs[0] ?? '')).toContain('/node_modules/vibe-agent-toolkit/node_modules/');
  });

  it('refuses an install that holds no cli entry, naming the spec', async () => {
    await expectRefusal(resolveNpx(installing({})), /the install of vibe-agent-toolkit@0\.1\.43 holds no/u);
  });

  it('refuses an install whose cli manifest is not the pinned version, naming both', async () => {
    await expectRefusal(resolveNpx(installing(cliAt('0.1.42'))), /0\.1\.42.*0\.1\.43|0\.1\.43.*0\.1\.42/u);
  });

  it('refuses an entry that does not start', async () => {
    const files = { ...cliAt(VERSION), [CLI_BIN]: 'process.exit(3);\n' };

    await expectRefusal(resolveNpx(installing(files)), /--version exited 3: the install does not start/u);
  });

  it('refuses a cli entry whose real path lies outside the install, though its manifest names the pin', async ({ skip }) => {
    const capability = symlinkCapability() ?? skip();
    // npm links a directory spec into node_modules; a link out of the install must never be run as the pin.
    const outside = mkdtempSync(safePath.join(scratch, 'outside-'));
    await lay(outside, cliAt(VERSION));
    const install = vi.fn(async (_spec: string, prefix: string) => {
      await mkdir(safePath.join(prefix, 'node_modules/vibe-agent-toolkit'), { recursive: true });
      await createSymlinkAsync(
        capability,
        safePath.join(outside, 'node_modules'),
        safePath.join(prefix, 'node_modules/vibe-agent-toolkit/node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    });

    await expectRefusal(resolveNpx(install), /lies outside the install/u);
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

describe('npxInstallArm', () => {
  it('gives two specs that sanitize alike two install arms', () => {
    const root = armsRoot();

    expect(npxInstallArm(root, '@a/b-c@1.0.0').root).not.toBe(npxInstallArm(root, '@a-b/c@1.0.0').root);
    expect(npxInstallArm(root, SPEC).root).toBe(npxInstallArm(root, SPEC).root);
  });

  it('is a directory no measured arm can be laid out at, whatever its build and sequence are named', () => {
    // A build named exactly as the install arm's slug, measuring a sequence named `npx-install`
    // cold, once produced the install arm's own directory — and a cold reset of it emptied the install.
    const root = armsRoot();
    const measured = armDirectories({ root, build: distinctSlug(SPEC), arm: 'npx-install', state: 'cold' });

    expect(measured.root).not.toBe(npxInstallArm(root, SPEC).root);
  });
});

describe('npmInstall', () => {
  it("runs the Node's own npm-cli.js with node, no shell: lifecycle scripts off, in the install arm, into its npm cache, on its own timeout", async () => {
    vi.resetModules();
    // An inherited userconfig, in any case, would win over ~/.npmrc.
    for (const name of Object.keys(process.env).filter((key) => key.toLowerCase() === 'npm_config_userconfig')) vi.stubEnv(name, undefined);
    const calls: { command: string; leadingArgs: readonly string[]; args: readonly string[]; env: ArmEnvironment; timeoutMs: number | undefined }[] = [];
    vi.doMock('../../src/harness/run.js', async (importOriginal) => ({
      ...(await importOriginal<typeof RunModule>()),
      runCommand: (
        instrument: { command: string; leadingArgs: readonly string[] },
        args: readonly string[],
        options: { env: ArmEnvironment; timeoutMs?: number },
      ) => {
        calls.push({ ...instrument, args, env: options.env, timeoutMs: options.timeoutMs });
        return { exitCode: 0, stdout: '', stderr: '', wallMs: 0, spawnError: undefined };
      },
    }));
    const mocked = await import('../../src/harness/npx-install.js');
    const dirs = npxInstallArm(armsRoot(), SPEC);

    await mocked.npmInstall(SPEC, safePath.join(dirs.tmp, 'install'), dirs);
    vi.doUnmock('../../src/harness/run.js');
    vi.unstubAllEnvs();

    expect(calls).toHaveLength(1);
    // node itself, never npm.cmd under cmd.exe: a timeout kills node, not a shell that outlives it.
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.leadingArgs).toEqual([locateNpmCli(process.execPath, process.platform)]);
    expect(calls[0]?.args).toContain('--ignore-scripts');
    // The command line beats any .npmrc: an operator's `install-strategy=linked` never lays out the install.
    expect(calls[0]?.args).toContain('--install-strategy=hoisted');
    // The spec is an operand, never an option: it follows `--`.
    expect(calls[0]?.args.slice(-2)).toEqual(['--', SPEC]);
    expect(calls[0]?.env.set['npm_config_cache']).toBe(dirs.npmCache);
    // The arm's HOME holds no .npmrc: the operator's registry, scopes and auth come from theirs.
    expect(calls[0]?.env.set['npm_config_userconfig']).toBe(safePath.join(homedir(), '.npmrc'));
    // Never a step's --timeout-ms: a cold install outlasts a measured step.
    expect(calls[0]?.timeoutMs).toBe(NPX_INSTALL_TIMEOUT_MS);
  });

  it('refuses, naming the spec and npm\'s stderr, when npm install fails', async () => {
    vi.resetModules();
    vi.doMock('../../src/harness/run.js', async (importOriginal) => ({
      ...(await importOriginal<typeof RunModule>()),
      runCommand: () => ({ exitCode: 1, stdout: '', stderr: 'npm ERR! nope\n', wallMs: 0, started: true, spawnError: null }),
    }));
    const mocked = await import('../../src/harness/npx-install.js');
    const dirs = npxInstallArm(armsRoot(), SPEC);

    try {
      await expectRefusal(
        Promise.resolve().then(() => mocked.npmInstall(SPEC, safePath.join(dirs.tmp, 'install'), dirs)),
        /npm install vibe-agent-toolkit@0\.1\.43 failed \(1\): npm ERR! nope/u,
      );
    } finally {
      vi.doUnmock('../../src/harness/run.js');
    }
  });
});

/**
 * @param locate - A locator call
 * @returns What it returned, or what it threw
 */
function outcomeOf(locate: () => string): unknown {
  try {
    return locate();
  } catch (error: unknown) {
    return error;
  }
}

describe('locateNpmCli: the npm bundled with the Node that runs the lab', () => {
  it.for(['win32', 'linux', 'darwin'] as const)('finds the bundled npm-cli.js in the %s layout', (platform) => {
    const node = layFakeNode(mkdtempSync(safePath.join(scratch, 'node-')), platform);

    expect(toForwardSlash(locateNpmCli(node.execPath, platform))).toBe(toForwardSlash(node.cli));
  });

  it.for(['win32', 'linux'] as const)('refuses a %s Node with no bundled npm, naming the path it looked for', (platform) => {
    const dir = mkdtempSync(safePath.join(scratch, 'node-'));
    const node = layFakeNode(dir, platform);
    rmSync(safePath.join(node.cli, '..', '..', '..'), { recursive: true });

    const outcome = outcomeOf(() => locateNpmCli(node.execPath, platform));

    expect(isVatError(outcome, ARM_REFUSED_CODE)).toBe(true);
    expect(toForwardSlash((outcome as Error).message)).toContain(toForwardSlash(node.cli));
  });

  it('finds an npm-cli.js for the Node running this test — the real install the lab uses', () => {
    const cli = locateNpmCli(process.execPath, process.platform);

    expect(toForwardSlash(cli)).toMatch(/\/node_modules\/npm\/bin\/npm-cli\.js$/u);
    expect(existsSync(cli)).toBe(true);
  });
});
