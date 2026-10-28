/**
 * The read lanes — the projection's filesystem extent (`hostResolution`) and the realizations'
 * `resolveRealPath` (which the symlink-divergence oracle reads) — never hand the kernel a link
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

import { EXTENT_SYMLINK_NOT_REALIZED, EXTENT_SYMLINK_TARGET_UNREADABLE, FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { FilesystemCrawlSource } from '../../src/projection/crawl-source.js';
import { resolveRealPath } from '../../src/projection/realizations.js';
import { canonicalizeSync } from '../../src/utils.js';
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

/** Every realpath the kernel was asked of a path naming the link. */
function kernelAskedAbout(name: string): string[] {
  return (scratch.session?.calls ?? []).filter((call) => call.op === 'realpath' && call.path.endsWith(`/${name}`)).map((call) => call.path);
}

describe.skipIf(CAPABILITY === null)('read lanes never resolve a link chain through a network path (win32 semantics)', () => {
  it('resolveRealPath answers the link nowhere, with the refusal as its fault, and never asks the kernel', () => {
    const root = corpus();

    expect(resolveRealPath(safePath.join(root, 'smb.md'))).toMatchObject({ kind: 'nowhere', fault: { errno: 'LINK_CHAIN_REFUSED', faultClass: 'refused' } });
    expect(kernelAskedAbout('smb.md')).toEqual([]);
    // Positive control: a local link is resolved by the kernel, as before.
    expect(resolveRealPath(safePath.join(root, 'alias.md'))).toMatchObject({ kind: 'resolved' });
    expect(kernelAskedAbout('alias.md').length).toBeGreaterThan(0);
  });

  it('the filesystem extent writes the link\'s fault row and keeps every other row, never asking the kernel', async () => {
    const root = corpus();

    const { contribution } = await buildExtentContribution(root, new FilesystemExtentContributor((at) => new FilesystemCrawlSource(at, [])));

    expect(contribution.conditions.find((condition) => condition.path === 'smb.md')).toMatchObject({ code: EXTENT_SYMLINK_TARGET_UNREADABLE, targetFaultClass: 'refused' });
    expect(contribution.conditions.find((condition) => condition.path === 'alias.md')?.code).toBe(EXTENT_SYMLINK_NOT_REALIZED);
    expect(kernelAskedAbout('smb.md')).toEqual([]);
  });

  it('the containment canonicalizer answers the link in its parent\'s namespace and never asks the kernel', () => {
    const root = corpus();

    expect(canonicalizeSync(safePath.join(root, 'smb.md')).endsWith('/smb.md')).toBe(true);
    expect(kernelAskedAbout('smb.md')).toEqual([]);
    // Positive control: a local link is resolved by the kernel, as before.
    expect(canonicalizeSync(safePath.join(root, 'alias.md')).endsWith('/docs/plain.md')).toBe(true);
  });
});
