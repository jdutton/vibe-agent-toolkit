/**
 * The offline half of the OSV ignore register: every `osv-scanner.toml` entry pairs with an
 * ACCEPTED_ADVISORIES row both ways, carries an id, a reason and a TOML re-check date, and every
 * version it accepts still resolves in `bun.lock`.
 */
import { describe, expect, it } from 'vitest';

import { type AcceptedAdvisory, osvIgnoreFindings, readRegister, resolvedVersions } from '../src/osv-ignore-register.js';

const ID = 'GHSA-mrhx-c7xc-m3w5';
const SCOPES: Readonly<Record<string, AcceptedAdvisory>> = { [ID]: { package: 'zod', accepted: ['3.25.76'] } };

/** A `bun.lock` packages block resolving each `[key, "name@version"]` tuple. */
function lockOf(...resolutions: ReadonlyArray<readonly [key: string, tuple: string]>): string {
  const lines = resolutions.map(([key, tuple]) => `    "${key}": ["${tuple}", "", {}, "sha512-x"],`);
  return ['{', '  "packages": {', '    "react": ["react@19.2.0", "", {}, "sha512-y"],', '    "zod-to-json-schema": ["zod-to-json-schema@3.24.6", "", { "peerDependencies": { "zod": "^3.24.1" } }, "sha512-z"],', ...lines, '  }', '}'].join('\n');
}

function entry(id: string): string {
  return `[[IgnoredVulns]]\nid = "${id}"\nignoreUntil = 2026-12-31\nreason = "accepted"\n`;
}

const REGISTER = entry(ID);
const LOCK = lockOf(['zod', 'zod@3.25.76'], ['knip/zod', 'zod@4.6.7']);

describe('resolvedVersions', () => {
  it('reads every resolved version, nested keys included, and no declared range or similarly named package', () => {
    const lock = lockOf(['zod', 'zod@3.25.76'], ['knip/zod', 'zod@4.6.7'], ['@langchain/core/zod', 'zod@4.6.7']);

    expect(resolvedVersions(lock, 'zod')).toEqual(['3.25.76', '4.6.7']);
  });

  // bun.lock keys an npm alias by the alias and writes the real package in the tuple; OSV reads the tuple.
  it('reads a version installed under an npm alias, whatever its key', () => {
    const lock = lockOf(['zod', 'zod@3.25.76'], ['zod-v3', 'zod@3.22.4']);

    expect(resolvedVersions(lock, 'zod')).toEqual(['3.22.4', '3.25.76']);
  });

  it('reads a scoped package by its full name, its regex metacharacters taken literally', () => {
    const lock = lockOf(['@hono/node-server', '@hono/node-server@1.19.17'], ['honoXnode-server', 'honoXnode-server@9.9.9']);

    expect(resolvedVersions(lock, '@hono/node-server')).toEqual(['1.19.17']);
    expect(resolvedVersions(lock, 'hono.node-server')).toEqual([]);
  });
});

describe('readRegister', () => {
  it('reads a well-formed entry, its ignoreUntil as a TOML date', () => {
    const { ids, entries, findings } = readRegister(REGISTER);

    expect(findings).toEqual([]);
    expect([...ids]).toEqual([ID]);
    expect(entries.map((e) => [e.id, e.ignoreUntil.toISOString()])).toEqual([[ID, '2026-12-31']]);
  });

  it('reads an id quoted inside another entry\'s multi-line reason as content, not an entry', () => {
    const register = `[[IgnoredVulns]]\nid = "GHSA-0000-0000-0000"\nignoreUntil = 2026-12-31\nreason = """\nid = "${ID}"\n"""\n`;

    expect([...readRegister(register).ids]).toEqual(['GHSA-0000-0000-0000']);
  });
});

describe('osvIgnoreFindings', () => {
  it("passes today's shape: the accepted version resolves, beside fixed nested copies", () => {
    expect(osvIgnoreFindings(LOCK, REGISTER, SCOPES)).toEqual([]);
  });

  it('passes an empty register with an empty table: nothing is ignored', () => {
    expect(osvIgnoreFindings(LOCK, '# no entries\n', {})).toEqual([]);
  });

  it('refuses once the accepted version is gone: the bump patched it, so the entry is stale', () => {
    expect(osvIgnoreFindings(lockOf(['zod', 'zod@4.6.7']), REGISTER, SCOPES)).toEqual([expect.stringContaining('zod@3.25.76 no longer resolves')]);
  });

  it('refuses once the package is gone from bun.lock altogether', () => {
    expect(osvIgnoreFindings(lockOf(), REGISTER, SCOPES)).toEqual([expect.stringContaining(`delete the ${ID} entry`)]);
  });

  it('refuses one accepted version gone while another remains', () => {
    const scopes = { [ID]: { package: 'zod', accepted: ['3.25.76', '3.24.0'] } };

    expect(osvIgnoreFindings(LOCK, REGISTER, scopes)).toEqual([expect.stringContaining('zod@3.24.0 no longer resolves')]);
  });

  it('refuses an entry with no scope row: an unscoped ignore hides its advisory everywhere', () => {
    const register = `${REGISTER}\n${entry('GHSA-aaaa-bbbb-cccc')}`;

    expect(osvIgnoreFindings(LOCK, register, SCOPES)).toEqual([expect.stringContaining('GHSA-aaaa-bbbb-cccc, which has no ACCEPTED_ADVISORIES row')]);
  });

  it('refuses a scope row with no entry: the table is asserted both ways', () => {
    expect(osvIgnoreFindings(LOCK, '# no entries\n', SCOPES)).toEqual([expect.stringContaining(`scopes ${ID}, which osv-scanner.toml does not ignore`)]);
  });

  it('refuses a commented-out entry the same way: it ignores nothing, so its row is stale', () => {
    const commented = REGISTER.split('\n').map((line) => `# ${line}`).join('\n');

    expect(osvIgnoreFindings(LOCK, commented, SCOPES)).toEqual([expect.stringContaining('does not ignore')]);
  });

  it.each([
    ['no reason', `[[IgnoredVulns]]\nid = "${ID}"\nignoreUntil = 2026-12-31\n`, 'has no `reason`'],
    ['a blank reason', `[[IgnoredVulns]]\nid = "${ID}"\nignoreUntil = 2026-12-31\nreason = "  "\n`, 'has no `reason`'],
    ['no ignoreUntil', `[[IgnoredVulns]]\nid = "${ID}"\nreason = "accepted"\n`, 'has no `ignoreUntil` date'],
    ['a string ignoreUntil', `[[IgnoredVulns]]\nid = "${ID}"\nignoreUntil = "2026-12-31"\nreason = "accepted"\n`, 'has no `ignoreUntil` date'],
    ['a time-only ignoreUntil', `[[IgnoredVulns]]\nid = "${ID}"\nignoreUntil = 12:00:00\nreason = "accepted"\n`, 'has no `ignoreUntil` date'],
  ])('refuses an entry with %s, and still pairs it by id', (_field, register, message) => {
    expect(osvIgnoreFindings(LOCK, register, SCOPES)).toEqual([expect.stringContaining(message)]);
  });

  it.each([
    ['no id', `[[IgnoredVulns]]\nignoreUntil = 2026-12-31\nreason = "accepted"\n`],
    ['a non-string id', `[[IgnoredVulns]]\nid = 42\nignoreUntil = 2026-12-31\nreason = "accepted"\n`],
    ['a blank id', `[[IgnoredVulns]]\nid = " "\nignoreUntil = 2026-12-31\nreason = "accepted"\n`],
  ])('refuses an entry with %s, naming it by position', (_shape, register) => {
    expect(osvIgnoreFindings(LOCK, register, {})).toEqual([expect.stringContaining('entry #1 has no string `id`')]);
  });

  it.each(['PackageOverrides', 'GoVersionOverride'])('refuses a top-level %s, naming the key', (key) => {
    const register = `${REGISTER}\n[[${key}]]\nname = "zod"\n`;

    expect(osvIgnoreFindings(LOCK, register, SCOPES)).toEqual([`osv-scanner.toml declares \`${key}\`, which this register does not allow: it holds [[IgnoredVulns]] entries only, each scoped in ACCEPTED_ADVISORIES`]);
  });

  it.each([
    ['a string', 'IgnoredVulns = "GHSA-mrhx-c7xc-m3w5"\n'],
    ['an array holding a non-table', 'IgnoredVulns = ["GHSA-mrhx-c7xc-m3w5"]\n'],
  ])('refuses IgnoredVulns written as %s rather than an array of tables', (_shape, register) => {
    expect(osvIgnoreFindings(LOCK, register, {})).toEqual([expect.stringContaining('not an array of tables')]);
  });
});
