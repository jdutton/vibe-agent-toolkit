/**
 * The live half of the OSV ignore register: an empty-config osv-scanner report, judged against the
 * register. The scope comes from OSV's report, so a range OSV amends or a second package an
 * advisory names turns red here even though the register and bun.lock did not move.
 */
import { describe, expect, it } from 'vitest';

import { type AcceptedAdvisory } from '../src/osv-ignore-register.js';
import { osvScanFindings } from '../src/osv-ignore-scan.js';

const ID = 'GHSA-mrhx-c7xc-m3w5';
const CVE = 'CVE-2023-54404';
const SCOPES: Readonly<Record<string, AcceptedAdvisory>> = { [ID]: { package: 'zod', accepted: ['3.25.76'] } };
const REGISTER = `[[IgnoredVulns]]\nid = "${ID}"\nignoreUntil = 2026-12-31\nreason = "accepted"\n`;
const BEFORE_EXPIRY = new Date('2026-11-17T00:00:00Z');

interface Advisory {
  readonly name: string;
  readonly version: string;
  readonly ids: readonly [string, ...string[]];
  readonly ecosystem?: string;
}

/** An osv-scanner `--format json` report in the shape 2.4.0 writes, one package per advisory. */
function reportOf(...advisories: readonly Advisory[]): unknown {
  return {
    results: [
      {
        source: { path: '/repo/bun.lock', type: 'lockfile' },
        packages: advisories.map(({ name, version, ids: [id, ...aliases], ecosystem = 'npm' }) => ({
          package: { name, version, ecosystem },
          vulnerabilities: [{ id, aliases, summary: 'x', affected: [] }],
          groups: [{ ids: [id], aliases: [id, ...aliases], max_severity: '8.2' }],
        })),
      },
    ],
    experimental_config: { licenses: { summary: false, allowlist: null } },
  };
}

const TODAY = reportOf({ name: 'zod', version: '3.25.76', ids: [ID, CVE] });

describe('osvScanFindings', () => {
  it("passes today's report: one advisory, ignored, on the one version its row accepts", () => {
    expect(osvScanFindings(TODAY, REGISTER, SCOPES, BEFORE_EXPIRY)).toEqual([]);
  });

  it('passes a clean report against an empty register', () => {
    expect(osvScanFindings({ results: [] }, '', {}, BEFORE_EXPIRY)).toEqual([]);
  });

  it('matches an entry written under an alias of the reported id', () => {
    const register = REGISTER.replace(ID, CVE);

    expect(osvScanFindings(TODAY, register, { [CVE]: { package: 'zod', accepted: ['3.25.76'] } }, BEFORE_EXPIRY)).toEqual([]);
  });

  it('refuses an advisory no entry ignores: un-triaged', () => {
    const report = reportOf({ name: 'zod', version: '3.25.76', ids: [ID, CVE] }, { name: 'tar', version: '7.5.1', ids: ['GHSA-tttt-tttt-tttt'] });

    expect(osvScanFindings(report, REGISTER, SCOPES, BEFORE_EXPIRY)).toEqual([expect.stringContaining('GHSA-tttt-tttt-tttt affects tar@7.5.1 (npm) and no osv-scanner.toml entry ignores it')]);
  });

  it.each([
    ['another version of the package', { name: 'zod', version: '3.25.75', ids: [ID] }, 'zod@3.25.75'],
    ['a second package the advisory names', { name: 'zod-mini', version: '1.0.0', ids: [ID] }, 'zod-mini@1.0.0'],
    ['the accepted name and version in another ecosystem', { name: 'zod', version: '3.25.76', ids: [ID], ecosystem: 'PyPI' }, 'zod@3.25.76 (PyPI)'],
  ] as const)('refuses an ignored advisory against %s: the ignore would hide it', (_case, extra, label) => {
    const report = reportOf({ name: 'zod', version: '3.25.76', ids: [ID, CVE] }, extra);

    expect(osvScanFindings(report, REGISTER, SCOPES, BEFORE_EXPIRY)).toEqual([expect.stringContaining(`${ID} affects ${label}`)]);
  });

  it('refuses an entry the scan never reports: unused, delete it', () => {
    expect(osvScanFindings({ results: [] }, REGISTER, SCOPES, BEFORE_EXPIRY)).toEqual([expect.stringContaining(`ignores ${ID}, which the scan no longer reports`)]);
  });

  it('refuses a fake ignore, which pairs with no row and matches no advisory', () => {
    const register = `${REGISTER}\n[[IgnoredVulns]]\nid = "GHSA-aaaa-bbbb-cccc"\nignoreUntil = 2026-12-31\nreason = "probe"\n`;

    expect(osvScanFindings(TODAY, register, SCOPES, BEFORE_EXPIRY)).toEqual([
      expect.stringContaining('GHSA-aaaa-bbbb-cccc, which has no ACCEPTED_ADVISORIES row'),
      expect.stringContaining('ignores GHSA-aaaa-bbbb-cccc, which the scan no longer reports'),
    ]);
  });

  it.each([
    ['on its ignoreUntil date', new Date('2026-12-31T00:00:00Z')],
    ['after it', new Date('2027-01-15T00:00:00Z')],
  ])('refuses an entry %s: osv-scanner stops ignoring it, so this does too', (_when, now) => {
    expect(osvScanFindings(TODAY, REGISTER, SCOPES, now)).toEqual([expect.stringContaining(`entry ${ID} expired on 2026-12-31`)]);
  });

  it.each([
    ['not an object', 'nope'],
    ['missing results', { experimental_config: {} }],
    ['a package without a version', { results: [{ packages: [{ package: { name: 'zod', ecosystem: 'npm' }, vulnerabilities: [] }] }] }],
  ])('refuses a report that is %s rather than reading it as clean', (_shape, report) => {
    expect(osvScanFindings(report, REGISTER, SCOPES, BEFORE_EXPIRY)).toEqual([expect.stringContaining('not an osv-scanner --format json report')]);
  });
});
