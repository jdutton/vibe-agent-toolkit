import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { regenerateVendoredManifest, verifyVendoredManifest } from '../../src/skill-test/vendor-manifest.js';

describe('vendored manifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-vendor-'));
    mkdirSyncReal(safePath.join(dir, 'agents'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
    writeFileSync(safePath.join(dir, 'agents', 'grader.md'), '# grader\n', 'utf8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
    writeFileSync(safePath.join(dir, 'LICENSE.txt'), 'Apache License 2.0\n', 'utf8');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('regenerate then verify passes', () => {
    regenerateVendoredManifest(dir);
    expect(verifyVendoredManifest(dir)).toBe(true);
  });

  it('verify fails when a vendored file is mutated after the manifest is written', () => {
    regenerateVendoredManifest(dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture mutation, controlled directory
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture mutation, controlled directory
    writeFileSync(safePath.join(dir, 'vendored.manifest.json'), '{ this is not json', 'utf8');
    expect(verifyVendoredManifest(dir)).toBe(false);
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture mutation, controlled directory
    writeFileSync(safePath.join(dir, 'agents', 'injected.md'), '# injected\n', 'utf8');
    expect(verifyVendoredManifest(dir)).toBe(false);
  });
});
