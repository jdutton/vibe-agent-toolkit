/**
 * `vendorTypescript()` run for real against a temp package: the manifest is read from disk, and
 * `typescript` is resolved by Node from the package's own `node_modules`, so the refusal is proven
 * on the resolution path the build takes, not only on the pure check the unit tests call.
 *
 * Integration tier: it writes real files. The stub `typescript` holds the three files the script
 * copies and a `package.json` whose version the test picks; the versions are fixture values.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { createTempDir, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { vendorTypescript, VendorTypescriptRefusal } from '../../src/vendor-typescript.js';

const DECLARED = '1.2.3';
const STUB_SOURCE = 'module.exports = { version: "stub" };\n';
const SOURCE_MAP_LINE = '//# sourceMappingURL=typescript.js.map\n';

/** The files the script writes into `src/vendor/` from the installed package. */
const COPIED_FILES = ['typescript.cjs', 'LICENSE.txt', 'ThirdPartyNoticeText.txt'] as const;

/** The committed files in `src/vendor/` that only travel to `dist/vendor/`. */
const COMMITTED_FILES = ['typescript.d.cts', 'ATTRIBUTION.md'] as const;

/** The files `src/vendor/` and `dist/vendor/` must each hold after a run. */
const VENDORED_FILES = [...COPIED_FILES, ...COMMITTED_FILES] as const;

function writeText(path: string, text: string): void {
  mkdirSyncReal(safePath.join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A package declaring `typescript@DECLARED` whose installed `typescript` says `installed`.
 *
 * @param root - The temp directory to lay the package out in
 * @param installed - The version the installed stub's `package.json` declares
 */
function layOutPackage(root: string, installed: string): void {
  writeText(safePath.join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', devDependencies: { typescript: DECLARED } }));
  const typescriptRoot = safePath.join(root, 'node_modules', 'typescript');
  writeText(safePath.join(typescriptRoot, 'package.json'), JSON.stringify({ name: 'typescript', version: installed }));
  writeText(safePath.join(typescriptRoot, 'lib', 'typescript.js'), `${STUB_SOURCE}${SOURCE_MAP_LINE}`);
  writeText(safePath.join(typescriptRoot, 'LICENSE.txt'), 'license\n');
  writeText(safePath.join(typescriptRoot, 'ThirdPartyNoticeText.txt'), 'notices\n');
  writeText(safePath.join(root, 'src', 'vendor', 'typescript.d.cts'), 'export {};\n');
  writeText(safePath.join(root, 'src', 'vendor', 'ATTRIBUTION.md'), '# Attribution\n');
}

/** Run `body` on a fresh temp directory, removed afterwards. */
async function inTempPackage(body: (root: string) => Promise<void>): Promise<void> {
  const root = createTempDir('vendor-typescript-');
  try {
    await body(root);
  } finally {
    removeTempDir(root);
  }
}

describe('vendorTypescript on a real package layout', () => {
  it('refuses when the installed typescript is not the declared version, and writes nothing', async () => {
    await inTempPackage(async (root) => {
      layOutPackage(root, '1.2.4');
      const run = vendorTypescript(root);
      await expect(run).rejects.toThrow(VendorTypescriptRefusal);
      await expect(run).rejects.toThrow(/1\.2\.4.*1\.2\.3/s);
      expect(existsSync(safePath.join(root, 'src', 'vendor', 'typescript.cjs'))).toBe(false);
      expect(existsSync(safePath.join(root, 'dist'))).toBe(false);
    });
  });

  it('writes src/vendor and dist/vendor when the installed typescript is the declared version', async () => {
    await inTempPackage(async (root) => {
      layOutPackage(root, DECLARED);
      const written = await vendorTypescript(root);
      expect(written).toHaveLength(COPIED_FILES.length * 2 + COMMITTED_FILES.length);
      for (const name of VENDORED_FILES) {
        const src = readFileSync(safePath.join(root, 'src', 'vendor', name));
        expect(readFileSync(safePath.join(root, 'dist', 'vendor', name)).equals(src), name).toBe(true);
      }
      expect(readFileSync(safePath.join(root, 'src', 'vendor', 'typescript.cjs'), 'utf8')).toBe(STUB_SOURCE);
      await expect(vendorTypescript(root)).resolves.toEqual([]);
    });
  });
});
