import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { withSyncFsRefused } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { regenerateVendoredManifest, verifyVendoredManifest } from '../../src/skill-test/vendor-manifest.js';

const MANIFEST_FILE = 'vendored.manifest.json';

describe('vendored manifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-vendor-'));
    mkdirSyncReal(safePath.join(dir, 'agents'));
    writeFileSync(safePath.join(dir, 'agents', 'grader.md'), '# grader\n', 'utf8');
    writeFileSync(safePath.join(dir, 'LICENSE.txt'), 'Apache License 2.0\n', 'utf8');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('regenerate then verify passes', () => {
    regenerateVendoredManifest(dir);
    expect(verifyVendoredManifest(dir)).toBe(true);
  });

  it('verify fails when a vendored file is mutated after the manifest is written', () => {
    regenerateVendoredManifest(dir);
    writeFileSync(safePath.join(dir, 'agents', 'grader.md'), '# tampered\n', 'utf8');
    expect(verifyVendoredManifest(dir)).toBe(false);
  });

  it('verify fails when the manifest is absent', () => {
    expect(verifyVendoredManifest(dir)).toBe(false);
  });

  it('verify fails (fail-closed) when the manifest JSON is unparseable', () => {
    regenerateVendoredManifest(dir);
    expect(verifyVendoredManifest(dir)).toBe(true);
    // Corrupt the manifest into invalid JSON — the JSON.parse throw must be
    // caught and treated as tampering (false), never silently accepted.
    writeFileSync(safePath.join(dir, MANIFEST_FILE), '{ this is not json', 'utf8');
    expect(verifyVendoredManifest(dir)).toBe(false);
  });

  it('verify fails (fail-closed) when the manifest is JSON of the wrong shape', () => {
    regenerateVendoredManifest(dir);
    writeFileSync(safePath.join(dir, MANIFEST_FILE), JSON.stringify({ files: 'nope' }), 'utf8');
    expect(verifyVendoredManifest(dir)).toBe(false);
  });

  // `false` means "tampered" and fails preflight with that word. A manifest the
  // OS refused to hand over has not been shown to be tampered — reporting it as
  // such sends the operator to reinstall a package whose bytes are fine.
  it('verify rethrows a refused manifest read rather than reporting tampering', async () => {
    regenerateVendoredManifest(dir);
    await withSyncFsRefused('readFileSync', safePath.join(dir, MANIFEST_FILE), 'EACCES', () => {
      expect(() => verifyVendoredManifest(dir)).toThrow(/EACCES/);
    });
  });

  it('verify fails (fail-closed) when a manifest-listed file is missing on disk', () => {
    regenerateVendoredManifest(dir);
    expect(verifyVendoredManifest(dir)).toBe(true);
    // Delete a file the manifest still lists — a missing listed file is tampering.
    rmSync(safePath.join(dir, 'agents', 'grader.md'), { force: true });
    expect(verifyVendoredManifest(dir)).toBe(false);
  });

  it('verify fails (fail-closed) when an unlisted extra file is added after the manifest is written', () => {
    regenerateVendoredManifest(dir);
    expect(verifyVendoredManifest(dir)).toBe(true);
    // Inject a file not present when the manifest was generated.
    writeFileSync(safePath.join(dir, 'agents', 'injected.md'), '# injected\n', 'utf8');
    expect(verifyVendoredManifest(dir)).toBe(false);
  });
});
