/**
 * The root-discovery walks (`findConfigFile`, `findNodeWorkspaceRoot`, `findProjectRoot`,
 * `gitFindRoot`) start inside CRAWLED trees — `vat audit` asks `findProjectRoot(dirname(skill))` for
 * every SKILL.md its walk finds — so each name they probe at a level (`vibe-agent-toolkit.config.yaml`,
 * `package.json`, `.git`) can be a link the tree's author planted. On Windows the kernel's follow of a
 * link to `\\host\share` is itself the leak (an SMB session offering the operator's NTLM credentials),
 * so every probe reads the link's chain by its text first and refuses a network hop before the kernel
 * is asked. The host flavor is bound to `win32` so the guard runs Windows semantics on every host; the
 * link text is a UNC path (on POSIX a legal relative name no kernel would send anywhere).
 *
 * The kernel is watched on both routes a source file can reach it by: the `node:fs` default object
 * (`vi.spyOn`), and the module's NAMED exports — Node snapshots those at import time, so a spy on the
 * default object cannot see `import { existsSync } from 'node:fs'` (`vi.mock` wraps them instead).
 */
import fs from 'node:fs';
import type * as NodeFs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINK_CHAIN_REFUSED_CODE } from '../src/errors/errno-table.js';
import { gitFindRoot } from '../src/git-utils.js';
import { safePath, toForwardSlash } from '../src/path-utils.js';
import { findConfigFile, findNodeWorkspaceRoot, findProjectRoot, resetProjectRootCaches } from '../src/project-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import { setupSyncTempDirSuite } from '../src/testing/temp-dir.js';

const named = vi.hoisted(() => ({ asked: [] as string[] }));

vi.mock('../src/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  const { toForwardSlash: forward } = await import('../src/path-core.js');
  const record = (path: fs.PathLike): void => {
    named.asked.push(forward(String(path)));
  };
  return {
    ...real,
    default: real.default,
    existsSync: (path: fs.PathLike) => (record(path), real.existsSync(path)),
    statSync: ((path: fs.PathLike, ...rest: unknown[]) => (record(path), (real.statSync as (...args: unknown[]) => unknown)(path, ...rest))) as typeof real.statSync,
  };
});

const UNC = String.raw`\\attacker\share\c.yaml`;

/** Every path the kernel was asked to follow, on either route, while the spies are on. */
function spyOnTheKernel(): { asked: () => string[]; restore: () => void } {
  named.asked.length = 0;
  const viaDefault: string[] = [];
  const record = (path: fs.PathLike): void => {
    viaDefault.push(toForwardSlash(String(path)));
  };
  const realStatSync = fs.statSync;
  const realNative = fs.realpathSync.native;
  const spies = [
    vi.spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      record(path);
      return (realStatSync as (path: fs.PathLike, ...rest: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.statSync),
    vi.spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => (record(path), false)),
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((path: fs.PathLike) => (record(path), realNative(path))) as typeof fs.realpathSync.native),
  ];
  return { asked: () => [...viaDefault, ...named.asked], restore: () => { for (const spy of spies) spy.mockRestore() } };
}

/** `<scanned>/<name> -> \\attacker\share\c.yaml`; returns the link. */
function plant(scanned: string, name: string, skip: () => never): string {
  const cap = symlinkCapability() ?? skip();
  const link = safePath.join(scanned, name);
  createSymlink(cap, UNC, link, 'file');
  return link;
}

const refused = expect.objectContaining({ faultClass: 'refused', errno: LINK_CHAIN_REFUSED_CODE });

describe('root discovery never hands the kernel a planted link to a network path (win32 semantics)', () => {
  const suite = setupSyncTempDirSuite('root-discovery-link-chain');
  let scanned: string;
  let kernel: ReturnType<typeof spyOnTheKernel> | undefined;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    resetProjectRootCaches();
    scanned = safePath.join(toForwardSlash(fs.realpathSync(suite.getTempDir())), 'scanned', 'sub');
    fs.mkdirSync(scanned, { recursive: true });
  });
  afterEach(() => {
    kernel?.restore();
    kernel = undefined;
    resetProjectRootCaches();
  });

  const walks: ReadonlyArray<readonly [string, string, (start: string) => unknown]> = [
    ['findConfigFile', 'vibe-agent-toolkit.config.yaml', findConfigFile],
    ['findProjectRoot (the config phase)', 'vibe-agent-toolkit.config.yaml', findProjectRoot],
    ['findProjectRoot (the git phase)', '.git', findProjectRoot],
    ['gitFindRoot', '.git', gitFindRoot],
    ['findNodeWorkspaceRoot', 'package.json', findNodeWorkspaceRoot],
  ];

  it.for(walks)(String.raw`%s refuses <scanned>/sub/%s -> \\attacker\share before the kernel is asked`, ([, name, walk], { skip }) => {
    const link = plant(scanned, name, skip);
    kernel = spyOnTheKernel();

    let thrown: unknown;
    try {
      walk(scanned);
    } catch (error: unknown) {
      thrown = error;
    }

    // The kernel first: a walk that followed the link and THEN refused would still have leaked.
    expect(kernel?.asked().filter((asked) => asked.startsWith(link)), 'paths the kernel was asked to follow').toEqual([]);
    expect(thrown).toEqual(refused);
  });

  it('follows a local link to a real config (positive control: the guard is not a blanket "absent")', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    fs.writeFileSync(safePath.join(scanned, 'real.yaml'), '{}\n');
    createSymlink(cap, 'real.yaml', safePath.join(scanned, 'vibe-agent-toolkit.config.yaml'), 'file');

    expect(findProjectRoot(scanned)).toBe(scanned);
    expect(findConfigFile(scanned)).toBe(safePath.join(scanned, 'vibe-agent-toolkit.config.yaml'));
  });
});
