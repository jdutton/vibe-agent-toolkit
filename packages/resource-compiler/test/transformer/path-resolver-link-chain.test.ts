/**
 * A markdown import whose path runs through a link to `\\host\share` is never handed to the kernel
 * (a Windows kernel resolving it offers the operator's NTLM credentials to the host), and it is
 * never answered "not found" either: the refusal is thrown for the compiler to report.
 *
 * The host flavor the guard binds is set to `win32` (the shared `utils` build's `link-chain`
 * module, mocked), so this runs Windows semantics on every host over a real tree whose link's text
 * is a UNC path — on POSIX a legal file name no kernel would send anywhere, which an `existsSync`
 * answers `false` for.
 */

import { writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { createTempDir, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultCompilerOptions, resolveMarkdownPath } from '../../src/transformer/path-resolver.js';

vi.mock('../../../utils/dist/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));

const CAPABILITY = symlinkCapability();
const UNC = String.raw`\\attacker\share\core.md`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

/** A project with `src/index.ts`, `src/plain.md`, and `src/smb.md -> \\attacker\share\core.md`. */
function project(): string {
  if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
  const root = createTempDir('vat-md-import-link-');
  dirs.push(root);
  const src = safePath.join(root, 'src');
  mkdirSyncReal(src);
  writeFileSync(safePath.join(src, 'index.ts'), "import * as core from './smb.md';\n");
  writeFileSync(safePath.join(src, 'plain.md'), '## Plain\n');
  createSymlink(CAPABILITY, UNC, safePath.join(src, 'smb.md'), 'file');
  return safePath.join(src, 'index.ts');
}

describe.skipIf(CAPABILITY === null)('resolveMarkdownPath never resolves an import through a network link (win32 semantics)', () => {
  it('throws the refusal for an import naming the link, instead of answering not found', () => {
    const containingFile = project();

    expect(() => resolveMarkdownPath('./smb.md', containingFile, createDefaultCompilerOptions()))
      .toThrow(expect.objectContaining({ code: 'LINK_CHAIN_REFUSED' }));
    // Positive control: a local import resolves, and an absent one is still "not found".
    expect(resolveMarkdownPath('./plain.md', containingFile, createDefaultCompilerOptions())).toMatch(/\/src\/plain\.md$/);
    expect(resolveMarkdownPath('./gone.md', containingFile, createDefaultCompilerOptions())).toBeNull();
  });
});
