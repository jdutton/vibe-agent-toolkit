/**
 * The read lanes — the projection's filesystem extent (`hostResolution`), the realizations'
 * `resolveRealPath` (which the symlink-divergence oracle reads) and `stat` column, OKF discovery's
 * symlink classifier and the containment canonicalizer — never hand the kernel a link
 * chain whose texts have not been read: a corpus link to `\\host\share` (a Windows kernel resolving
 * it offers the operator's NTLM credentials to the host) is that ONE link's fault row, carrying the
 * refusal's code and class, and the kernel is never asked about it.
 *
 * The host flavor the realpath guard binds is set to `win32` (the shared `utils` build's
 * `link-chain` module, mocked), so this runs Windows semantics on every host over a real tree whose
 * link's text is a UNC path — on POSIX a legal file name no kernel would send anywhere. On a POSIX
 * kernel that link resolves to nothing (`ENOENT`, no fault), so a fault row here is the guard's.
 * The kernel spy is `installFaultFs`, which records every `realpath` (native and JS) by path.
 */

import { writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { installFaultFs } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it, vi } from 'vitest';

import { discoverOkfBundle } from '../../src/okf/discovery.js';
import { EXTENT_SYMLINK_NOT_REALIZED, EXTENT_SYMLINK_TARGET_UNREADABLE, FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { FilesystemCrawlSource } from '../../src/projection/crawl-source.js';
import { collectRealization, resolveRealPath } from '../../src/projection/realizations.js';
import { canonicalizeSync, isWithinProject } from '../../src/utils.js';
import { buildExtentContribution, faultFsScratch } from '../test-helpers.js';

vi.mock('../../../utils/dist/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));

const CAPABILITY = symlinkCapability();
const UNC = String.raw`\\attacker\share\x.md`;

const scratch = faultFsScratch();

/** A corpus with `docs/plain.md`, `smb.md -> \\attacker\share\x.md` and `alias.md -> docs/plain.md`, its realpaths spied on. */
function corpus(): string {
  if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
  const root = scratch.tempDir('vat-link-chain-read-');
  mkdirSyncReal(safePath.join(root, 'docs'));
  writeFileSync(safePath.join(root, 'docs', 'plain.md'), '# plain\n');
  createSymlink(CAPABILITY, UNC, safePath.join(root, 'smb.md'), 'file');
  createSymlink(CAPABILITY, 'docs/plain.md', safePath.join(root, 'alias.md'), 'file');
  scratch.watch(installFaultFs({ within: root }));
  return root;
}

/** Every following `stat` the kernel was asked of a path naming the link. */
function kernelStatted(name: string): string[] {
  return (scratch.session?.calls ?? []).filter((call) => call.op === 'stat' && call.path.endsWith(`/${name}`)).map((call) => call.path);
}

/** Every realpath the kernel was asked of a path naming the link. */
function kernelAskedAbout(name: string): string[] {
  return (scratch.session?.calls ?? []).filter((call) => call.op === 'realpath' && call.path.endsWith(`/${name}`)).map((call) => call.path);
}

describe.skipIf(CAPABILITY === null)('read lanes never resolve a link chain through a network path (win32 semantics)', () => {
  it('resolveRealPath answers the link nowhere, with the refusal as its fault, and never asks the kernel', () => {
    const root = corpus();

    expect(resolveRealPath(safePath.join(root, 'smb.md'), root)).toMatchObject({ kind: 'nowhere', fault: { errno: 'LINK_CHAIN_REFUSED', faultClass: 'refused' } });
    expect(kernelAskedAbout('smb.md')).toEqual([]);
    // Positive control: a local link is resolved by the kernel, as before.
    expect(resolveRealPath(safePath.join(root, 'alias.md'), root)).toMatchObject({ kind: 'resolved' });
    expect(kernelAskedAbout('alias.md').length).toBeGreaterThan(0);
  });

  it('the filesystem extent writes the link\'s fault row and keeps every other row, never asking the kernel', async () => {
    const root = corpus();

    const { contribution } = await buildExtentContribution(root, new FilesystemExtentContributor((at) => new FilesystemCrawlSource(at, [])));

    expect(contribution.conditions.find((condition) => condition.path === 'smb.md')).toMatchObject({ code: EXTENT_SYMLINK_TARGET_UNREADABLE, targetFaultClass: 'refused' });
    expect(contribution.conditions.find((condition) => condition.path === 'alias.md')?.code).toBe(EXTENT_SYMLINK_NOT_REALIZED);
    expect(kernelAskedAbout('smb.md')).toEqual([]);
  });

  it('the containment canonicalizer refuses the link outright, so containment calls it outside, and never asks the kernel', () => {
    const root = corpus();

    expect(() => canonicalizeSync(safePath.join(root, 'smb.md'), root)).toThrow(expect.objectContaining({ code: 'LINK_CHAIN_REFUSED' }));
    expect(isWithinProject(safePath.join(root, 'smb.md'), root)).toBe(false);
    expect(kernelAskedAbout('smb.md')).toEqual([]);
    // Positive control: a local link is resolved by the kernel, as before.
    expect(canonicalizeSync(safePath.join(root, 'alias.md'), root).endsWith('/docs/plain.md')).toBe(true);
    expect(isWithinProject(safePath.join(root, 'alias.md'), root)).toBe(true);
  });

  it('a realization row calls the link unresolved and never has the kernel stat it', async () => {
    const root = corpus();

    const row = await collectRealization(safePath.join(root, 'smb.md'), 'res-smb', { root, extentId: 'ext' });

    expect(row).toMatchObject({ exists: true, isSymlink: true, symlinkResolves: false });
    expect(kernelStatted('smb.md')).toEqual([]);
    // Positive control: a local link is followed by the kernel's stat, and resolves.
    expect(await collectRealization(safePath.join(root, 'alias.md'), 'res-alias', { root, extentId: 'ext' })).toMatchObject({ isSymlink: true, symlinkResolves: true });
    expect(kernelStatted('alias.md').length).toBeGreaterThan(0);
  });

  it('OKF discovery records the link as not assessed (LINK_CHAIN_REFUSED), never as dangling, and never stats it', async () => {
    const root = corpus();

    const files = await discoverOkfBundle(root);

    expect(files.unreadableDocuments).toContainEqual({ document: 'smb.md', code: 'LINK_CHAIN_REFUSED' });
    expect(files.unpackableDocuments.map((entry) => entry.document)).not.toContain('smb.md');
    expect(kernelStatted('smb.md')).toEqual([]);
    // Positive control: a local alias inside the bundle is a member.
    expect(files.unreadableDocuments.map((entry) => entry.document)).not.toContain('alias.md');
  });
});
