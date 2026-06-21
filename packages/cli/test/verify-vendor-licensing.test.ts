import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertVendoredLicensingShipped } from '../src/commands/consistency-check.js';

// Reusable paths relative to the package dir under test
const VENDOR_DIR = 'vendor/skill-creator';
const LICENSE_RELATIVE = `${VENDOR_DIR}/LICENSE.txt`;
const ATTRIBUTION_RELATIVE = `${VENDOR_DIR}/ATTRIBUTION.md`;

// Minimal stub content for test fixtures
const STUB_LICENSE = 'Apache License 2.0\n';
const STUB_ATTRIBUTION = '# Attribution\n';

/** Write a vendored fixture file under the package dir. */
function writeVendoredFile(packageDir: string, relative: string, content: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
  writeFileSync(safePath.join(packageDir, relative), content, 'utf8');
}

/** Seed both licensing artifacts (the common two-file fixture). */
function writeLicenseAndAttribution(packageDir: string): void {
  writeVendoredFile(packageDir, LICENSE_RELATIVE, STUB_LICENSE);
  writeVendoredFile(packageDir, ATTRIBUTION_RELATIVE, STUB_ATTRIBUTION);
}

describe('assertVendoredLicensingShipped', () => {
  let packageDir: string;

  beforeEach(() => {
    packageDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-vendor-lic-'));
    mkdirSyncReal(safePath.join(packageDir, VENDOR_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(packageDir, { recursive: true, force: true });
  });

  it('returns no problems when LICENSE.txt and ATTRIBUTION.md are present and vendor/ is in filesAllowlist', () => {
    writeLicenseAndAttribution(packageDir);

    const problems = assertVendoredLicensingShipped(packageDir, ['dist', 'vendor/', 'README.md']);
    expect(problems).toHaveLength(0);
  });

  it('returns a problem mentioning LICENSE when LICENSE.txt is missing', () => {
    writeVendoredFile(packageDir, ATTRIBUTION_RELATIVE, STUB_ATTRIBUTION);

    const problems = assertVendoredLicensingShipped(packageDir, ['dist', 'vendor/', 'README.md']);
    const licenseProblem = problems.find((p) => p.toLowerCase().includes('license'));
    expect(licenseProblem).toBeDefined();
  });

  it('returns a problem mentioning the files/allowlist when vendor/ is absent from filesAllowlist', () => {
    writeLicenseAndAttribution(packageDir);

    const problems = assertVendoredLicensingShipped(packageDir, ['dist', 'README.md']);
    const allowlistProblem = problems.find(
      (p) => p.toLowerCase().includes('files') || p.toLowerCase().includes('allowlist'),
    );
    expect(allowlistProblem).toBeDefined();
  });
});
