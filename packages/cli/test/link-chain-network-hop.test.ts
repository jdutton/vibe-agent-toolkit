/**
 * The cli lanes that follow a link a project carries ask the kernel only about a chain they have
 * read and shown local. On Windows the kernel's resolution of `\\host\share` is itself the leak (an
 * SMB session offering the operator's NTLM credentials), so a link whose text names a network path
 * is refused before any `stat`/`realpath` reaches it. The host flavor is bound to `win32` so the
 * guard runs Windows semantics on every host, over a real tree whose link text is a UNC path (on
 * POSIX a legal relative file name no POSIX kernel would send anywhere). Spies on the DEFAULT `node:fs`
 * objects — the seam utils' link-following reaches the kernel through — record every path asked.
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

import type { MarketplaceValidateReport } from '@vibe-agent-toolkit/schema';
import { createSymlink, mkdirSyncReal, relativeEscapesRoot, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMarketplaceValidatePhase } from '../src/commands/claude/marketplace/validate.js';
import { treeCopyPlugin } from '../src/commands/claude/plugin/tree-copy.js';
import { toEnumerationRow } from '../src/pipeline-oracles/aliases.js';

import { publishedPhase } from './helpers/published-phase.js';
import { createTempDirTracker } from './system/test-common.js';

// utils is inlined by vitest, so its own link-chain module is the seam the host flavor is bound at.
vi.mock('../../utils/dist/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));

const UNC = String.raw`\\attacker\share`;
const SYMLINK_CAP = symlinkCapability();
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-link-chain-network-');

/** Every path a following `stat` or `realpath` (sync or async, native or JS) was asked about. */
function spyOnTheKernel(): string[] {
  const asked: string[] = [];
  const record = (path: unknown): void => {
    asked.push(toForwardSlash(String(path)));
  };
  const realStatSync = fs.statSync;
  const realRealpathSyncNative = fs.realpathSync.native;
  const realStat = fsPromises.stat;
  const realRealpath = fsPromises.realpath;
  vi.spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    record(args[0]);
    return realStatSync(...args);
  }) as typeof fs.statSync);
  vi.spyOn(fs.realpathSync, 'native').mockImplementation(((path: fs.PathLike) => (record(path), realRealpathSyncNative(path))) as typeof fs.realpathSync.native);
  vi.spyOn(fs.realpath, 'native').mockImplementation(((path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, real?: string) => void) => {
    record(path);
    try {
      callback(null, realRealpathSyncNative(path));
    } catch (error) {
      callback(error as NodeJS.ErrnoException);
    }
  }) as unknown as typeof fs.realpath.native);
  vi.spyOn(fsPromises, 'stat').mockImplementation((async (path: fs.PathLike) => (record(path), await realStat(path))) as typeof fsPromises.stat);
  vi.spyOn(fsPromises, 'realpath').mockImplementation((async (path: fs.PathLike) => (record(path), await realRealpath(path))) as typeof fsPromises.realpath);
  return asked;
}

/** Whether the kernel was asked about `link` or anything reached through it. */
function askedThrough(asked: readonly string[], link: string): boolean {
  return asked.some((path) => !relativeEscapesRoot(safePath.relative(link, path)));
}

/** What `run` threw (or rejected with). */
async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

describe.skipIf(SYMLINK_CAP === null)('a link naming a network path is refused before the kernel follows it (win32 semantics)', () => {
  it('vat claude plugin build: the tree copy refuses a plugin file linked to a share, and never resolves it', async () => {
    const root = createTempDir();
    const src = safePath.join(root, 'plugins', 'p1');
    const dest = safePath.join(root, 'out', 'p1');
    mkdirSyncReal(safePath.join(src, 'hooks'), { recursive: true });
    mkdirSyncReal(dest, { recursive: true });
    fs.writeFileSync(safePath.join(src, 'hooks', 'hooks.json'), '{}');
    const link = safePath.join(src, 'hooks', 'smb.json');
    createSymlink(SYMLINK_CAP ?? expect.unreachable(), UNC, link, 'file');
    const asked = spyOnTheKernel();

    const error = await thrownBy(() => treeCopyPlugin({ sourceDir: src, destDir: dest }));

    expect(error).toMatchObject({ code: 'FS_FAULT', side: 'source' });
    expect(String((error as Error).message)).toContain('network');
    expect(askedThrough(asked, link)).toBe(false);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it('vat claude marketplace validate: a declared plugin source linked to a share is never resolved', async () => {
    const root = createTempDir();
    fs.mkdirSync(safePath.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      safePath.join(root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'mp', owner: { name: 'owner' }, plugins: [{ name: 's', source: './plugins/s' }] }),
    );
    for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md']) fs.writeFileSync(safePath.join(root, file), 'x\n');
    mkdirSyncReal(safePath.join(root, 'plugins'), { recursive: true });
    const link = safePath.join(root, 'plugins', 's');
    createSymlink(SYMLINK_CAP ?? expect.unreachable(), UNC, link, 'dir');
    const asked = spyOnTheKernel();

    const { exitCode, document } = publishedPhase<MarketplaceValidateReport>('claude marketplace validate', await runMarketplaceValidatePhase(root, { verbose: true }));

    expect(exitCode).not.toBe(0);
    expect(document.status === 'findings' ? document.data.plugins : []).toEqual([]);
    expect(askedThrough(asked, link)).toBe(false);
  });

  it('the symlink-divergence oracle records a corpus link to a share as unresolved, through the resolver', () => {
    const root = toForwardSlash(fs.realpathSync(createTempDir()));
    const link = safePath.join(root, 'smb.md');
    createSymlink(SYMLINK_CAP ?? expect.unreachable(), UNC, link, 'file');
    const asked = spyOnTheKernel();

    const row = toEnumerationRow(
      { path: 'smb.md', contentKey: null, exists: true, isDirectory: false, gitignored: false, isSymlink: true, symlinkResolves: false } as unknown as Parameters<typeof toEnumerationRow>[0],
      link,
      root,
    );

    expect(row.targetInsideRoot).toEqual({ fault: 'LINK_CHAIN_REFUSED' });
    expect(askedThrough(asked, link)).toBe(false);
  });
});
